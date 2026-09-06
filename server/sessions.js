'use strict';

// Session history — the longitudinal archive that several reviews flagged as
// the missing foundation. It unlocks "vs previous session" in What Changed,
// prescription-vs-delivered, per-patient trends, and auto end-of-session
// summaries.
//
// A session = one treatment run on one machine for one patient. Lifecycle:
//   start  : machine has sessionActive=true + a patientId, not already tracked
//   end    : sessionActive flips false, OR the patientId changes, OR the
//            machine goes offline for a while
// While live, we accumulate telemetry samples, alarm types seen, and a
// timeline of notable events. On end we compute a summary record + a short
// French narrative and persist it.
//
// Live state is in memory (like _prevStatus / _simBaseline in index.js); only
// finalized sessions hit SQLite. A restart loses in-flight sessions — the same
// pragmatic trade-off used elsewhere for short-horizon state.

const { db } = require('./db');

const TELEM_FIELDS = ['bfr', 'ufr', 'ufv', 'part', 'pven', 'tmp', 'cond', 'temp'];
const OFFLINE_GRACE_MS = Number(process.env.HADJ_SESSION_OFFLINE_MS || 90_000);

const _live = new Map(); // machineId -> live accumulator

function _ref(machineId) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `S-${machineId}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function _startLive(m) {
  _live.set(m.id, {
    ref: _ref(m.id),
    machineId: m.id,
    patientId: m.patientId,
    model: m.model || null,
    startedAt: Date.now(),
    ufvStart: typeof m.ufv === 'number' ? m.ufv : 0,
    targetUfv: typeof m.targetUfv === 'number' ? m.targetUfv : null,
    samples: Object.fromEntries(TELEM_FIELDS.map((f) => [f, []])),
    alarmTypes: new Set(),
    alarmCount: 0,
    lastAlarmId: null,
    prevStatus: m.status,
    events: [{ t: new Date().toISOString(), label: 'Début de séance (branchement)' }],
    lastSeen: Date.now(),
  });
}

function _summarize(vals) {
  if (!vals.length) return null;
  let min = vals[0];
  let max = vals[0];
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  return { min: Math.round(min * 100) / 100, max: Math.round(max * 100) / 100, last: Math.round(vals[vals.length - 1] * 100) / 100, samples: vals.length };
}

function _narrative(rec) {
  const bits = [];
  bits.push(`Séance ${rec.session_ref} — patient ${rec.patient_id}, ${rec.machine_id} (${rec.model || 'modèle ?'}).`);
  bits.push(`Durée ${rec.duration_min} min.`);
  if (rec.target_ufv != null && rec.delivered_ufv != null) {
    const pct = rec.target_ufv ? Math.round((rec.delivered_ufv / rec.target_ufv) * 100) : null;
    bits.push(`UF délivrée ${rec.delivered_ufv} L / cible ${rec.target_ufv} L${pct != null ? ` (${pct} %)` : ''}.`);
  }
  const ts = rec.telemetry_summary || {};
  if (ts.pven) bits.push(`Pression veineuse ${ts.pven.min}–${ts.pven.max} mmHg (fin ${ts.pven.last}).`);
  if (ts.tmp) bits.push(`TMP ${ts.tmp.min}–${ts.tmp.max} mmHg.`);
  bits.push(rec.alarm_count ? `${rec.alarm_count} alarme(s) : ${rec.alarm_types.join(', ')}.` : 'Aucune alarme pendant la séance.');
  bits.push(rec.status === 'aborted' ? 'Séance interrompue (machine hors ligne).' : 'Séance menée à terme.');
  bits.push('Synthèse générée automatiquement — à relire et valider par le soignant.');
  return bits.join(' ');
}

function _finalize(acc, status) {
  const endedAt = Date.now();
  const durationMin = Math.max(1, Math.round((endedAt - acc.startedAt) / 60000));
  const telemetrySummary = {};
  for (const f of TELEM_FIELDS) {
    const s = _summarize(acc.samples[f]);
    if (s) telemetrySummary[f] = s;
  }
  const deliveredUfv = telemetrySummary.ufv
    ? Math.round((telemetrySummary.ufv.last - acc.ufvStart) * 100) / 100
    : null;
  const rec = {
    session_ref: acc.ref,
    machine_id: acc.machineId,
    patient_id: acc.patientId,
    model: acc.model,
    started_at: new Date(acc.startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    duration_min: durationMin,
    status,
    target_ufv: acc.targetUfv,
    delivered_ufv: deliveredUfv,
    telemetry_summary: telemetrySummary,
    alarm_count: acc.alarmCount,
    alarm_types: [...acc.alarmTypes],
    events: acc.events.concat([{ t: new Date(endedAt).toISOString(), label: status === 'aborted' ? 'Séance interrompue' : 'Fin de séance (débranchement)' }]),
  };
  rec.summary = _narrative(rec);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions
    (session_ref, machine_id, patient_id, model, started_at, ended_at, duration_min, status,
     target_ufv, delivered_ufv, telemetry_summary, alarm_count, alarm_types, events, summary, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    rec.session_ref, rec.machine_id, rec.patient_id, rec.model, rec.started_at, rec.ended_at,
    rec.duration_min, rec.status, rec.target_ufv, rec.delivered_ufv,
    JSON.stringify(rec.telemetry_summary), rec.alarm_count, JSON.stringify(rec.alarm_types),
    JSON.stringify(rec.events), rec.summary, now);
  return rec;
}

/** Called on the tick loop. Returns finalized sessions (usually none). */
function tick(fleet, { writeAudit } = {}) {
  const finalized = [];
  const seen = new Set();
  for (const m of fleet) {
    seen.add(m.id);
    const acc = _live.get(m.id);
    const hasSession = !!(m.sessionActive && m.patientId);

    if (acc && (!hasSession || acc.patientId !== m.patientId)) {
      const rec = _finalize(acc, 'completed');
      _live.delete(m.id);
      finalized.push(rec);
      if (writeAudit) writeAudit({ user: 'SYSTEM', machine: m.id, action: 'SESSION_ARCHIVED', data: `Séance ${rec.session_ref} archivée (${rec.duration_min} min, ${rec.alarm_count} alarme(s))`, ai: 'Historique de séances', network: 'SESSION' });
      if (hasSession) _startLive(m); // new patient right after → new session
      continue;
    }
    if (!acc && hasSession) { _startLive(m); continue; }
    if (!acc) continue;

    // live session — accumulate
    acc.lastSeen = Date.now();
    for (const f of TELEM_FIELDS) if (typeof m[f] === 'number') acc.samples[f].push(m[f]);
    const curAlarmId = m.currentAlarm ? m.currentAlarm.id : null;
    if (curAlarmId && curAlarmId !== acc.lastAlarmId) {
      acc.alarmCount++;
      if (m.currentAlarm.type) acc.alarmTypes.add(m.currentAlarm.type);
      acc.events.push({ t: new Date().toISOString(), label: `Alarme : ${(m.currentAlarm.type) || 'type inconnu'}` });
    }
    acc.lastAlarmId = curAlarmId;
    if (m.status !== acc.prevStatus) {
      acc.events.push({ t: new Date().toISOString(), label: `Statut ${acc.prevStatus} → ${m.status}` });
      acc.prevStatus = m.status;
    }
  }
  // machine vanished from fleet for too long → abort its live session
  for (const [mid, acc] of _live) {
    if (!seen.has(mid) && Date.now() - acc.lastSeen > OFFLINE_GRACE_MS) {
      const rec = _finalize(acc, 'aborted');
      _live.delete(mid);
      finalized.push(rec);
    }
  }
  return finalized;
}

/** Demo/test: end the current session on a machine and immediately start a fresh one. */
function cycleSession(m, { writeAudit } = {}) {
  const acc = _live.get(m.id);
  let archived = null;
  if (acc) {
    archived = _finalize(acc, 'completed');
    _live.delete(m.id);
    if (writeAudit) writeAudit({ user: 'SYSTEM', machine: m.id, action: 'SESSION_ARCHIVED', data: `Séance ${archived.session_ref} archivée (cycle manuel)`, ai: 'Historique de séances', network: 'SESSION' });
  }
  if (m.sessionActive && m.patientId) _startLive(m);
  return archived;
}

function _row(r) {
  if (!r) return null;
  for (const k of ['telemetry_summary', 'alarm_types', 'events']) {
    try { r[k] = JSON.parse(r[k] || 'null'); } catch { r[k] = null; }
  }
  return r;
}

function listSessions({ machineId, patientId, limit = 50 } = {}) {
  let sql = 'SELECT * FROM sessions WHERE 1=1';
  const p = [];
  if (machineId) { sql += ' AND machine_id = ?'; p.push(machineId); }
  if (patientId) { sql += ' AND patient_id = ?'; p.push(patientId); }
  sql += ' ORDER BY id DESC LIMIT ?';
  p.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
  return db.prepare(sql).all(...p).map(_row);
}

function getSession(id) {
  return _row(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
}

/** Most recent completed session for this machine+patient (for "vs previous session"). */
function previousSession(machineId, patientId) {
  return _row(db.prepare(
    `SELECT * FROM sessions WHERE machine_id = ? AND (? IS NULL OR patient_id = ?) AND status != 'aborted'
     ORDER BY id DESC LIMIT 1`
  ).get(machineId, patientId || null, patientId || null));
}

function machineSessionStats(machineId) {
  const r = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status='aborted' THEN 1 ELSE 0 END) AS aborted
     FROM sessions WHERE machine_id = ?`
  ).get(machineId);
  return { total: r.total || 0, aborted: r.aborted || 0 };
}

function validateSession(id, actor) {
  const s = getSession(id);
  if (!s) return null;
  const now = new Date().toISOString();
  db.prepare('UPDATE sessions SET validated_by = ?, validated_at = ? WHERE id = ?').run(actor, now, id);
  return getSession(id);
}

module.exports = { tick, cycleSession, listSessions, getSession, previousSession, validateSession, machineSessionStats, TELEM_FIELDS };
