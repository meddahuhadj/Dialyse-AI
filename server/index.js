'use strict';

// HADJ Dialysis Intelligence — backend.
//   Phase 1: fleet + audit API over SQLite (audit trail persistent).
//   Phase 3: ConnectorManager owns telemetry (simulator + live adapters).
//   Phase 4: JWT auth + RBAC, tamper-evident audit chain, server-side secrets,
//            security headers, optional HTTPS.

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { db } = require('./db');
const { ensureSeeded } = require('./seed');
const { ConnectorManager, testBinding } = require('./connectors');
const auth = require('./auth');
const secrets = require('./secrets');
const { GENESIS, hashRow, tipHash, verifyChain } = require('./audit-chain');
const { securityHeaders, createServer } = require('./security');
const gemini = require('./gemini');
const dpiImport = require('./dpi-import');
const maintenance = require('./maintenance');
const alarmClustering = require('./alarm-clustering');
const whatChanged = require('./what-changed');
const devices = require('./devices');
const priorities = require('./priorities');
const sessions = require('./sessions');
const fingerprint = require('./fingerprint');
const healthScore = require('./health-score');
const fleetAnalytics = require('./fleet-analytics');
const reconciliation = require('./reconciliation');
const shiftReport = require('./shift-report');
const readiness = require('./readiness');

ensureSeeded();

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
// CORS: open by default (lets the single file be opened from file:// during
// dev). In production set HADJ_CORS_ORIGINS to a comma-separated allowlist.
app.use(cors(process.env.HADJ_CORS_ORIGINS
  ? { origin: process.env.HADJ_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) }
  : undefined));
app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Fleet state + connectors (Phase 3)
// ---------------------------------------------------------------------------
let fleet = db.prepare('SELECT data FROM machines').all().map((r) => JSON.parse(r.data));
const TICK_MS = Number(process.env.HADJ_TICK_MS || 2000);

const connectors = new ConnectorManager(fleet);
connectors.start().catch((e) => console.error('[connectors] start:', e));

devices.ensureRows(fleet); // one Device Center row per machine (idempotent)

function flushFleet() {
  const upd = db.prepare('UPDATE machines SET data = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  for (const m of fleet) upd.run(JSON.stringify(m), now, m.id);
}
setInterval(flushFleet, 15000).unref();

// Detect NORMAL/MONITORING → ALARM transitions (mirrors the front-end's own
// detectStatusTransitions(), server-side this time) → log the real occurrence
// to the alarms table, then check whether that pushes any (machine, alarm
// type) pair past the repeated-drift threshold → auto-open a maintenance
// ticket. See maintenance.js.
const _prevAlarmId = new Map();
let _lastFleetSig = '';
setInterval(() => {
  let anyNew = false;
  for (const m of fleet) {
    const curId = m.currentAlarm ? m.currentAlarm.id : null;
    if (curId && curId !== _prevAlarmId.get(m.id)) {
      maintenance.logAlarmEvent(m);
      anyNew = true;
    }
    _prevAlarmId.set(m.id, curId);
  }
  if (anyNew) maintenance.runDriftCheck(fleet, { writeAudit });
  sessions.tick(fleet, { writeAudit }); // accumulate live sessions + archive on end

  // Push the fleet to SSE clients only when something visible changed.
  if (sseClients.size) {
    const sig = JSON.stringify(fleet.map((m) => [m.id, m.status, m.pven, m.part, m.tmp, m.ufv, m.bfr, m.dataSource, m.currentAlarm && m.currentAlarm.id]));
    if (sig !== _lastFleetSig) { _lastFleetSig = sig; sseBroadcast('fleet', fleet); }
  }
}, Math.max(TICK_MS, 2000)).unref();

// Periodic telemetry snapshots feeding the "WHAT CHANGED?" comparisons.
whatChanged.recordSnapshot(fleet); // seed one baseline immediately
setInterval(() => whatChanged.recordSnapshot(fleet), whatChanged.SNAPSHOT_EVERY_MS).unref();

// Health score is RECOMPUTED from real signals (not the seeded number) so the
// "WHY THIS SCORE?" derivation is truthful. Keeps the { reliability,
// alarmHistory, maintenance, stability, utilization } shape the front-end reads.
function healthCtxFor(m) {
  const snap = connectors.snapshot();
  const dev = devices.listDevices([m], snap)[0];
  const fp = fingerprint.computeFingerprint(m, sessions.listSessions({ machineId: m.id, limit: 30 }));
  return {
    connectivityStatus: dev ? dev.connectivityStatus : 'SIMULATION',
    sessionStats: sessions.machineSessionStats(m.id),
    fingerprintDeviations: fp.confidence === 'low' ? null : fp.deviations.length,
  };
}
function recomputeHealth() {
  for (const m of fleet) {
    const h = healthScore.computeHealth(m, healthCtxFor(m));
    m.healthScore = h.healthScore;
    m.healthBreakdown = h.healthBreakdown;
  }
}
recomputeHealth();
setInterval(recomputeHealth, 10_000).unref();

const findMachine = (id) => fleet.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
const { requireAuth, requirePerm } = auth;

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', fleet: fleet.length, tickMs: TICK_MS, uptimeSec: Math.round(process.uptime()), auth: 'required',
    mode: devices.globalMode(fleet, connectors.snapshot()),
  });
});

app.post('/api/auth/login', (req, res) => {
  const { id, password } = req.body || {};
  if (!id || !password) return res.status(400).json({ error: 'id et password requis' });
  if (!auth.throttleLogin(id)) return res.status(429).json({ error: 'trop de tentatives — réessayez dans quelques minutes' });

  const user = auth.authenticate(id, password);
  auth.noteLoginResult(id, !!user);
  if (!user) return res.status(401).json({ error: 'identifiants invalides' });

  const token = auth.signToken({ sub: user.id, name: user.name, role: user.role });
  writeAudit({ user: user.role, machine: 'HD-ALL', action: 'AUTH_LOGIN', data: `Connexion de ${user.id} (${user.role})`, ai: 'Authentification forte', network: 'AUTH' });
  res.json({ token, expiresInSec: auth.TOKEN_TTL_SEC, user: { ...user, permissions: auth.permsFor(user.role) } });
});

// ---------------------------------------------------------------------------
// Everything below requires a valid token
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  // req.path is mount-relative here (e.g. "/fleet", "/auth/me", "/docs/...").
  if (req.method === 'OPTIONS') return next();
  if (['/health', '/auth/login', '/openapi.json'].includes(req.path)) return next();
  if (req.path === '/docs' || req.path.startsWith('/docs/')) return next();
  // SSE: EventSource can't send an Authorization header, so /stream carries the
  // JWT as ?token= and validates it itself (see the route below).
  if (req.path === '/stream') return next();
  return requireAuth(req, res, next);
});

// ---------------------------------------------------------------------------
// Server-Sent Events — real-time push so the UI stops polling every 5 s.
// Broadcasts `fleet` on telemetry change, `audit` on new entries, plus a
// heartbeat. The front-end falls back to polling if the stream can't connect.
// ---------------------------------------------------------------------------
const sseClients = new Set();
function sseBroadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { /* client gone; cleaned up on 'close' */ }
  }
}
app.get('/api/stream', (req, res) => {
  let claims;
  try { claims = auth.verifyToken(req.query.token || ''); }
  catch (e) { return res.status(401).json({ error: 'jeton invalide' }); }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ role: claims.role, ts: Date.now() })}\n\n`);
  // Prime the client with the current fleet immediately.
  res.write(`event: fleet\ndata: ${JSON.stringify(fleet)}\n\n`);

  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`); } catch {} }, 25_000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    id: req.user.sub, name: req.user.name, role: req.user.role,
    permissions: auth.permsFor(req.user.role),
    exp: req.user.exp,
  });
});

// Second-factor PIN for critical actions (needle-check ack, escalation, checklist
// validation…). Independent of the login password; strict lockout (small keyspace).
app.post('/api/auth/verify-pin', (req, res) => {
  const userId = req.user.sub;
  const pin = req.body && req.body.pin;
  if (!pin) return res.status(400).json({ error: 'PIN requis' });
  if (!auth.throttlePin(userId)) return res.status(429).json({ error: 'Trop de tentatives — réessayez dans 1 min' });
  const ok = auth.verifyPin(userId, pin);
  auth.notePinResult(userId, ok);
  if (!ok) {
    writeAudit({ user: req.user.role, machine: 'HD-ALL', action: 'PIN_VERIFY_FAILED', data: `Échec PIN pour ${userId}`, ai: 'Double validation refusée', network: 'AUTH' });
    // 400, NOT 401: a wrong PIN is a business-logic failure, not a session/JWT
    // failure. apiFetch() treats any 401 as "session expired" and force-logs-out
    // — reusing 401 here silently killed the caller's session on a mistyped PIN.
    return res.status(400).json({ error: 'PIN incorrect' });
  }
  writeAudit({ user: req.user.role, machine: 'HD-ALL', action: 'PIN_VERIFIED', data: `Double validation PIN réussie pour ${userId}`, ai: 'Second facteur confirmé', network: 'AUTH' });
  res.json({ ok: true });
});

app.get('/api/fleet', requirePerm('fleet:read'), (req, res) => res.json(fleet));

// Fleet Analytics — cross-machine patterns (same alarm type on several
// generators, gateway-wide connectivity loss). Registered BEFORE /api/fleet/:id
// so "analytics" isn't captured as a machine id. See fleet-analytics.js.
app.get('/api/fleet/analytics', requirePerm('connectors:read'), (req, res) => {
  res.json(fleetAnalytics.detectPatterns(fleet, devices.listDevices(fleet, connectors.snapshot())));
});

app.get('/api/fleet/:id', requirePerm('fleet:read'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  res.json(m);
});

app.get('/api/fleet/:id/alarms', requirePerm('fleet:read'), (req, res) => {
  if (!findMachine(req.params.id)) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  const rows = db.prepare(
    `SELECT alarm_id AS id, type, priority, timestamp, duration, status, note
     FROM alarms WHERE lower(machine_id) = lower(?) ORDER BY id DESC`
  ).all(req.params.id);
  res.json(rows);
});

app.get('/api/fleet/:id/what-changed', requirePerm('fleet:read'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  const prev = sessions.previousSession(m.id, m.patientId);
  res.json(whatChanged.whatChanged(m.id, m, prev));
});

// ---------------------------------------------------------------------------
// Session history — longitudinal archive (previous-session comparisons,
// prescription-vs-delivered, auto summaries). See sessions.js.
// ---------------------------------------------------------------------------
app.get('/api/sessions', requirePerm('fleet:read'), (req, res) => {
  res.json(sessions.listSessions({ machineId: req.query.machine, patientId: req.query.patient, limit: req.query.limit }));
});

app.get('/api/sessions/:id', requirePerm('fleet:read'), (req, res) => {
  const s = sessions.getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'Séance introuvable' });
  res.json(s);
});

app.patch('/api/sessions/:id', requirePerm('audit:write'), (req, res) => {
  const s = sessions.validateSession(req.params.id, req.user.role);
  if (!s) return res.status(404).json({ error: 'Séance introuvable' });
  writeAudit({ user: req.user.role, machine: s.machine_id, action: 'SESSION_VALIDATED', data: `Séance ${s.session_ref} relue et validée`, ai: 'Validation soignante du résumé de séance', network: 'SESSION' });
  res.json(s);
});

// Machine Fingerprint — this machine's behavioural baseline (from its own
// archived sessions) vs its current behaviour. See fingerprint.js.
app.get('/api/fleet/:id/fingerprint', requirePerm('fleet:read'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  res.json(fingerprint.computeFingerprint(m, sessions.listSessions({ machineId: m.id, limit: 30 })));
});

// "WHY THIS SCORE?" — full derivation of the machine health score. See health-score.js.
app.get('/api/fleet/:id/health', requirePerm('fleet:read'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  res.json(healthScore.computeHealth(m, healthCtxFor(m)));
});

// Production readiness — "what's left before going real". Admin only (reveals
// security posture). See readiness.js and server/GO-LIVE.md.
app.get('/api/readiness', requirePerm('users:manage'), (req, res) => {
  res.json(readiness.computeReadiness(fleet, devices, connectors.snapshot()));
});

// End-of-shift report — structured aggregation + copy-ready narrative. See shift-report.js.
app.get('/api/shift-report', requirePerm('fleet:read'), (req, res) => {
  res.json(shiftReport.buildShiftReport(fleet, {
    sessions, maintenance, alarmClustering, fleetAnalytics, devices,
    connectorsSnapshot: connectors.snapshot(),
  }, { hours: req.query.hours }));
});

// Prescribed vs Delivered — reconciles the imported FHIR prescription against
// the last archived session. See reconciliation.js.
app.get('/api/fleet/:id/reconciliation', requirePerm('fleet:read'), async (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  let prescription = null;
  try { prescription = await dpiImport.getPrescription(m.patientId || 'P-8492'); }
  catch (e) { /* no prescription available — reconcile() handles null */ }
  const session = sessions.previousSession(m.id, m.patientId);
  res.json(reconciliation.reconcile(m, prescription, session));
});

// Demo/test: archive the current session on a machine and start a fresh one,
// so "vs previous session" can be demonstrated without waiting for a real one.
app.post('/api/fleet/:id/cycle-session', requirePerm('connectors:manage'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  const archived = sessions.cycleSession(m, { writeAudit });
  res.json({ ok: true, archived: archived ? archived.session_ref : null });
});

// ---------------------------------------------------------------------------
// Device Center — device registry, biomedical approval lifecycle (§30 safety
// gate), per-value data provenance (§10), LIVE/SIMULATION mode (§12). See
// devices.js. Read-only lifecycle only — no machine-control write path.
// ---------------------------------------------------------------------------
app.get('/api/devices', requirePerm('connectors:read'), (req, res) => {
  const snap = connectors.snapshot();
  res.json({ mode: devices.globalMode(fleet, snap), devices: devices.listDevices(fleet, snap) });
});

app.get('/api/devices/:id', requirePerm('connectors:read'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Appareil ${req.params.id} introuvable` });
  const snap = connectors.snapshot();
  const d = devices.listDevices([m], snap)[0];
  res.json({ ...d, parameters: devices.parameters(m, snap) });
});

app.get('/api/devices/:id/parameters', requirePerm('fleet:read'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Appareil ${req.params.id} introuvable` });
  res.json(devices.parameters(m, connectors.snapshot()));
});

app.patch('/api/devices/:id', requirePerm('connectors:manage'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Appareil ${req.params.id} introuvable` });
  const result = devices.updateDevice(m.id, req.body || {}, req.user.role);
  if (!result) return res.status(404).json({ error: 'Appareil introuvable' });
  if (result.error) return res.status(400).json({ error: result.error });
  writeAudit({ user: req.user.role, machine: m.id, action: 'DEVICE_LIFECYCLE', data: `Appareil ${m.id} → état ${result.approval_state}`, ai: "Gestion du parc d'appareils (lecture seule)", network: 'DEVICE' });
  res.json(devices.listDevices([m], connectors.snapshot())[0]);
});

app.get('/api/connectors', requirePerm('connectors:read'), (req, res) => res.json(connectors.snapshot()));
app.get('/api/connectors/catalogue', requirePerm('connectors:read'), (req, res) => res.json(ConnectorManager.catalogue()));

// ---------------------------------------------------------------------------
// Connection wizard — read/write connectors.config.json + a real connection
// test. No fake network scan: /test actually starts the adapter and reports
// what happened. Writing a binding hot-reloads the ConnectorManager.
// ---------------------------------------------------------------------------
const CONNECTORS_CFG = process.env.HADJ_CONNECTORS || path.join(__dirname, 'connectors', 'connectors.config.json');

function readConnectorsCfg() {
  try { return JSON.parse(fs.readFileSync(CONNECTORS_CFG, 'utf8')); }
  catch { return { defaultSimulator: true, staleMs: 15000, bindings: [], _new: true }; }
}
function writeConnectorsCfg(cfg) {
  delete cfg._new;
  fs.writeFileSync(CONNECTORS_CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

app.get('/api/connectors/config', requirePerm('connectors:manage'), (req, res) => {
  const cfg = readConnectorsCfg();
  res.json({ exists: !cfg._new, defaultSimulator: cfg.defaultSimulator !== false, staleMs: cfg.staleMs || 15000, bindings: cfg.bindings || [] });
});

app.post('/api/connectors/test', requirePerm('connectors:manage'), async (req, res) => {
  const { machineId, model, adapter, params } = req.body || {};
  if (!adapter) return res.status(400).json({ error: 'champ "adapter" requis' });
  if (!findMachine(machineId)) return res.status(404).json({ error: `Machine ${machineId} introuvable` });
  try {
    const result = await testBinding({ machineId, model, adapter, params: params || {} });
    writeAudit({ user: req.user.role, machine: machineId, action: 'CONNECTOR_TEST', data: `Test ${adapter} → ${result.ok ? 'OK' : 'ÉCHEC'} (${result.stage}: ${result.detail})`, ai: 'Test de connexion appareil (lecture seule)', network: 'DEVICE' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, stage: 'exception', detail: e.message });
  }
});

app.post('/api/connectors/config', requirePerm('connectors:manage'), async (req, res) => {
  const { machineId, model, adapter, params } = req.body || {};
  if (!machineId || !adapter) return res.status(400).json({ error: 'machineId et adapter requis' });
  if (!findMachine(machineId)) return res.status(404).json({ error: `Machine ${machineId} introuvable` });
  if (adapter === 'simulator') return res.status(400).json({ error: 'le simulateur est implicite, pas une source à ajouter' });
  const cfg = readConnectorsCfg();
  cfg.bindings = (cfg.bindings || []).filter((b) => b.machineId !== machineId);
  cfg.bindings.push({ machineId, model: model || findMachine(machineId).model, adapter, params: params || {} });
  writeConnectorsCfg(cfg);
  await connectors.reload();
  writeAudit({ user: req.user.role, machine: machineId, action: 'CONNECTOR_BOUND', data: `Source ${adapter} liée à ${machineId} et connecteurs rechargés`, ai: 'Onboarding appareil (lecture seule)', network: 'DEVICE' });
  res.json({ ok: true, bindings: readConnectorsCfg().bindings });
});

app.delete('/api/connectors/config/:machineId', requirePerm('connectors:manage'), async (req, res) => {
  const cfg = readConnectorsCfg();
  const before = (cfg.bindings || []).length;
  cfg.bindings = (cfg.bindings || []).filter((b) => b.machineId !== req.params.machineId);
  if (cfg.bindings.length === before) return res.status(404).json({ error: 'aucune liaison pour cette machine' });
  writeConnectorsCfg(cfg);
  await connectors.reload();
  writeAudit({ user: req.user.role, machine: req.params.machineId, action: 'CONNECTOR_UNBOUND', data: `Source live retirée de ${req.params.machineId} (retour simulateur)`, ai: 'Onboarding appareil', network: 'DEVICE' });
  res.json({ ok: true, bindings: cfg.bindings });
});

// Demo/test helper: push a machine into ALARM for a few seconds, then restore.
// Lets the front-end's automatic Focus-Alarme escalation be demonstrated without
// a physical generator. Gated to connectors:manage (ADMIN / TECHNICIEN).
// Pre-simulation baseline per machine, captured ONCE per chain of overlapping
// calls (found necessary by testing: firing this endpoint twice in a row on
// the same machine — exactly the intended way to demo cascade clustering —
// otherwise has the 2nd call's revert restore the 1ST call's simulated alarm
// object instead of the machine's true prior state, "resurrecting" it as a
// phantom 3rd alarm event and inflating the cluster count).
const _simBaseline = new Map();
app.post('/api/fleet/:id/simulate-alarm', requirePerm('connectors:manage'), (req, res) => {
  const m = findMachine(req.params.id);
  if (!m) return res.status(404).json({ error: `Machine ${req.params.id} introuvable` });
  const seconds = Math.min(Math.max(Number((req.body && req.body.seconds) || 20), 5), 120);
  if (!_simBaseline.has(m.id)) _simBaseline.set(m.id, { status: m.status, currentAlarm: m.currentAlarm });
  // Unique id per call (not a fixed 'ALM-SIM'): the tick-loop's transition
  // detector (index.js, feeding both maintenance drift-check and alarm
  // clustering) keys on id change, so firing several different simulated
  // alarm types back-to-back on the same machine — the whole point of
  // demonstrating cascade clustering — needs each occurrence to actually
  // register as a distinct event.
  const simId = 'ALM-SIM-' + Date.now();
  m.status = 'ALARM';
  m.currentAlarm = {
    id: simId, type: (req.body && req.body.type) || 'Alarme simulée (démonstration escalade)',
    priority: 'HIGH', timestamp: new Date().toTimeString().split(' ')[0],
  };
  writeAudit({ user: req.user.role, machine: m.id, action: 'ALARM_SIMULATED', data: `Alarme simulée ${seconds}s`, ai: 'Démonstration', network: 'SIMULATION' });
  setTimeout(() => {
    if (m.status === 'ALARM' && m.currentAlarm && m.currentAlarm.id === simId) {
      const base = _simBaseline.get(m.id) || {};
      m.status = base.status || 'NORMAL';
      m.currentAlarm = base.currentAlarm || null;
      _simBaseline.delete(m.id); // only the call whose timer actually reverts clears it — chained calls in between never do
    }
  }, seconds * 1000);
  res.json({ ok: true, machine: m.id, alarmForSeconds: seconds });
});

// ---------------------------------------------------------------------------
// Audit trail (tamper-evident hash chain)
// ---------------------------------------------------------------------------
function writeAudit(entry) {
  const now = new Date();
  const row = {
    time: entry.time || now.toTimeString().split(' ')[0],
    user: entry.user || 'INCONNU',
    machine: entry.machine || 'HD-ALL',
    action: entry.action,
    data: entry.data == null ? '' : String(entry.data),
    ai: entry.ai || 'Traitement conforme',
    network: entry.network || 'READ-ONLY (Aucune écriture machine)',
    created_at: now.toISOString(),
  };
  const prev = tipHash();
  const hash = hashRow(prev, row);
  const info = db.prepare(
    `INSERT INTO audit (time, user, machine, action, data, ai, network, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.time, row.user, row.machine, row.action, row.data, row.ai, row.network, row.created_at, prev, hash);
  const saved = { id: Number(info.lastInsertRowid), ...row, prev_hash: prev, hash };
  if (sseClients.size) sseBroadcast('audit', saved);
  return saved;
}

app.get('/api/audit', requirePerm('audit:read'), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const rows = db.prepare(
    `SELECT id, time, user, machine, action, data, ai, network, created_at, prev_hash, hash
     FROM audit ORDER BY id DESC LIMIT ?`
  ).all(limit);
  res.json(rows);
});

app.post('/api/audit', requirePerm('audit:write'), (req, res) => {
  const b = req.body || {};
  if (!b.action || typeof b.action !== 'string') return res.status(400).json({ error: 'Champ "action" (string) requis' });
  // Trust the authenticated identity for the user column, not the client-supplied one.
  const saved = writeAudit({ ...b, user: req.user.role });
  res.status(201).json(saved);
});

app.get('/api/audit/verify', requirePerm('audit:verify'), (req, res) => {
  res.json(verifyChain());
});

// ---------------------------------------------------------------------------
// Server-side secrets (Gemini key never returned to the browser)
// ---------------------------------------------------------------------------
app.get('/api/config/gemini-key', requirePerm('config:read'), (req, res) => {
  res.json(secrets.secretMeta('gemini_api_key'));
});

app.put('/api/config/gemini-key', requirePerm('config:write'), (req, res) => {
  const key = (req.body && req.body.key) || '';
  if (!key || key.length < 20) return res.status(400).json({ error: 'clé invalide' });
  secrets.setSecret('gemini_api_key', key);
  writeAudit({ user: req.user.role, machine: 'HD-ALL', action: 'SECRET_UPDATED', data: 'Clé API Gemini mise à jour (coffre-fort serveur, AES-256-GCM)', ai: 'Secret chiffré au repos', network: 'CONFIG' });
  res.json(secrets.secretMeta('gemini_api_key'));
});

app.delete('/api/config/gemini-key', requirePerm('config:write'), (req, res) => {
  secrets.setSecret('gemini_api_key', '');
  res.json({ configured: false });
});

// ---------------------------------------------------------------------------
// Gemini Live — ephemeral token minting. The browser connects DIRECTLY to
// Google's WebSocket with this short-lived token; the real API key is only
// ever read here, server-side. Any authenticated clinical role may use the
// copilot (fleet:read — the broadest read permission every role has).
// ---------------------------------------------------------------------------
app.post('/api/ai/live-token', requirePerm('fleet:read'), async (req, res) => {
  if (!gemini.isConfigured()) {
    return res.status(400).json({ error: 'Aucune clé Gemini configurée côté serveur (rôle ADMIN requis pour en enregistrer une).', code: 'NO_KEY' });
  }
  try {
    const t = await gemini.mintEphemeralToken();
    writeAudit({ user: req.user.role, machine: 'HD-ALL', action: 'AI_LIVE_TOKEN_ISSUED', data: `Jeton Gemini Live émis (modèle ${t.model})`, ai: 'Session copilote vocal temps réel', network: 'AUTH' });
    res.json(t);
  } catch (e) {
    console.warn('[gemini] échec émission jeton:', e.message);
    res.status(e.code === 'NETWORK' ? 502 : 502).json({ error: e.message, code: e.code || 'UNKNOWN' });
  }
});

// ---------------------------------------------------------------------------
// DPI/DPH prescription IMPORT — HL7 FHIR R4, strictly read-only. Complements
// the existing export: pulls dry weight, session duration, anticoagulation
// and target blood flow from the hospital's FHIR server so clinicians don't
// re-key it. Same live-config/demo-fallback shape as gemini.js — see
// dpi-import.js for the FHIR resource mapping and why.
// ---------------------------------------------------------------------------
app.get('/api/config/dpi-fhir', requirePerm('config:read'), (req, res) => {
  res.json(dpiImport.configMeta());
});

app.put('/api/config/dpi-fhir', requirePerm('config:write'), (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    return res.status(400).json({ error: 'URL de serveur FHIR invalide (http/https requis)' });
  }
  dpiImport.setConfig({ baseUrl, apiKey });
  writeAudit({ user: req.user.role, machine: 'HD-ALL', action: 'SECRET_UPDATED', data: `Serveur FHIR DPI configuré (${new URL(baseUrl).host})`, ai: 'Config interopérabilité DPI (import prescription)', network: 'CONFIG' });
  res.json(dpiImport.configMeta());
});

app.delete('/api/config/dpi-fhir', requirePerm('config:write'), (req, res) => {
  dpiImport.clearConfig();
  res.json({ configured: false });
});

app.get('/api/dpi/prescription/:patientId', requirePerm('fleet:read'), async (req, res) => {
  try {
    const result = await dpiImport.getPrescription(req.params.patientId);
    writeAudit({ user: req.user.role, machine: 'HD-ALL', action: 'DPI_PRESCRIPTION_IMPORTED', data: `Prescription importée pour patient ${req.params.patientId} (source : ${result.source})`, ai: 'Import lecture seule DPI/FHIR — aucun paramètre machine modifié', network: 'CONFIG' });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message, code: e.code || 'UNKNOWN' });
  }
});

app.post('/api/dpi/prescription/import', requirePerm('fleet:read'), (req, res) => {
  try {
    const bundle = req.body && req.body.bundle;
    const result = dpiImport.parseBundle(bundle);
    result.source = 'manual-import';
    result.fetchedAt = new Date().toISOString();
    writeAudit({ user: req.user.role, machine: 'HD-ALL', action: 'DPI_PRESCRIPTION_IMPORTED', data: `Prescription importée manuellement (fichier Bundle FHIR, patient ${result.patientId || '?'})`, ai: 'Import lecture seule DPI/FHIR — aucun paramètre machine modifié', network: 'CONFIG' });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: "Échec de l'analyse du Bundle FHIR : " + e.message });
  }
});

// ---------------------------------------------------------------------------
// Alarm cascade clustering — groups a burst of distinct alarm types on one
// machine into a single root-cause "mother alert". See alarm-clustering.js.
// ---------------------------------------------------------------------------
app.get('/api/alarms/clusters', requirePerm('fleet:read'), (req, res) => {
  res.json(alarmClustering.detectClusters());
});

// "À regarder maintenant" — pilotage par exception. Joins the existing signals
// (clusters, drift tickets, device connectivity, machine status) into one
// ranked list. See priorities.js.
app.get('/api/priorities', requirePerm('fleet:read'), (req, res) => {
  const snap = connectors.snapshot();
  res.json(priorities.computePriorities(fleet, {
    clusters: alarmClustering.detectClusters(),
    tickets: maintenance.listTickets(),
    deviceList: devices.listDevices(fleet, snap),
  }));
});

// ---------------------------------------------------------------------------
// Maintenance tickets — manual + auto-generated on repeated alarm drift.
// See maintenance.js for the detection logic (hooked into the tick loop above).
// ---------------------------------------------------------------------------
app.get('/api/maintenance/tickets', requirePerm('maintenance:read'), (req, res) => {
  res.json(maintenance.listTickets({ machineId: req.query.machine, status: req.query.status }));
});

app.post('/api/maintenance/tickets', requirePerm('maintenance:write'), (req, res) => {
  const b = req.body || {};
  if (!b.machineId || !b.title) return res.status(400).json({ error: 'Champs "machineId" et "title" requis' });
  if (!findMachine(b.machineId)) return res.status(404).json({ error: `Machine ${b.machineId} introuvable` });
  const ticket = maintenance.createTicket({
    machineId: b.machineId, title: b.title, detail: b.detail, priority: b.priority, assignedTo: b.assignedTo, source: 'manual',
  });
  writeAudit({ user: req.user.role, machine: ticket.machine_id, action: 'MAINTENANCE_TICKET_CREATED', data: `Ticket ${ticket.ticket_ref} créé manuellement : ${ticket.title}`, ai: 'Création manuelle', network: 'MAINTENANCE' });
  res.status(201).json(ticket);
});

app.patch('/api/maintenance/tickets/:id', requirePerm('maintenance:write'), (req, res) => {
  const existing = maintenance.getTicket(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket introuvable' });
  const b = req.body || {};
  if (b.status && !['OUVERT', 'PLANIFIE', 'RESOLU'].includes(b.status)) {
    return res.status(400).json({ error: 'status doit être OUVERT, PLANIFIE ou RESOLU' });
  }
  const ticket = maintenance.updateTicket(req.params.id, { status: b.status, priority: b.priority, assignedTo: b.assignedTo });
  writeAudit({ user: req.user.role, machine: ticket.machine_id, action: 'MAINTENANCE_TICKET_UPDATED', data: `Ticket ${ticket.ticket_ref} mis à jour (statut : ${ticket.status})`, ai: 'Mise à jour manuelle', network: 'MAINTENANCE' });
  res.json(ticket);
});

// ---------------------------------------------------------------------------
// OpenAPI + Swagger UI (public)
// ---------------------------------------------------------------------------
try {
  const YAML = require('yaml');
  const swaggerUi = require('swagger-ui-express');
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
  app.get('/api/openapi.json', (req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'HADJ Fleet API' }));
} catch (err) {
  console.warn('[openapi] Swagger UI indisponible :', err.message);
}

// ---------------------------------------------------------------------------
// Front-end (same origin)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'HADJ-ASSISTANT.html')));

// Service Worker (P3 — offline-first shell caching). Must be served from the root
// so its default scope covers the whole app. No-cache so an updated sw.js is
// picked up on next reload instead of being stuck behind the browser's own cache.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'sw.js'));
});

// PWA Web App Manifest and static icon assets
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, '..', 'manifest.json'));
});
app.use('/icons', express.static(path.join(__dirname, '..', 'icons')));


// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '0.0.0.0';
const { server, protocol } = createServer(app);
server.listen(PORT, HOST, () => {
  const base = `${protocol}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`HADJ Fleet API   → ${base}/api/fleet   (auth requise)`);
  console.log(`Front-end        → ${base}/`);
  console.log(`API docs         → ${base}/api/docs`);
  if (protocol === 'http') console.log('⚠  HTTP en clair — placez certs/key.pem + certs/cert.pem pour activer HTTPS (scripts/gen-cert).');
  try {
    readiness.logBootSummary(readiness.computeReadiness(fleet, devices, connectors.snapshot()));
  } catch (e) { console.warn('[readiness] check indisponible:', e.message); }
});

async function shutdown() {
  console.log('\n[shutdown] stop connectors + flush fleet → SQLite');
  try { await connectors.stop(); } catch (e) { console.error(e); }
  try { flushFleet(); } catch (e) { console.error(e); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
