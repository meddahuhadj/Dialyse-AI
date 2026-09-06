'use strict';

// Phase 1 seed: the backend starts life with the SAME data the front-end used to
// hold in its hardcoded `FLEET` / `AUDIT_LOG` constants.
//
// Source of truth: server/seed-data.json (those constants were removed from the
// HTML in Phase 2). Legacy fallback: extract the literals from an old HTML that
// still carries them.

const fs = require('node:fs');
const path = require('node:path');
const { db, tx } = require('./db');
const { GENESIS, hashRow } = require('./audit-chain');
const { seedUsersIfEmpty, backfillDemoPins } = require('./auth');

const SEED_JSON = process.env.HADJ_SEED || path.join(__dirname, 'seed-data.json');
const HTML_PATH = process.env.HADJ_HTML || path.join(__dirname, '..', 'HADJ-ASSISTANT.html');

/** Legacy path: pull `const <name> = [ ... ];` out of an old HTML and evaluate it. */
function extractLiteral(src, name) {
  const re = new RegExp('const ' + name + ' = (\\[[\\s\\S]*?\\n {4}\\]);');
  const m = src.match(re);
  if (!m || m[1].replace(/\s/g, '') === '[]') {
    throw new Error(`"${name}" absent de ${path.basename(HTML_PATH)} (retiré en Phase 2)`);
  }
  return Function('"use strict"; return (' + m[1] + ');')();
}

function loadSeed() {
  if (fs.existsSync(SEED_JSON)) {
    const j = JSON.parse(fs.readFileSync(SEED_JSON, 'utf8'));
    if (Array.isArray(j.fleet) && j.fleet.length) return { fleet: j.fleet, audit: j.audit || [] };
  }
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  return { fleet: extractLiteral(src, 'FLEET'), audit: extractLiteral(src, 'AUDIT_LOG') };
}

// kept for external callers / tests
const loadSeedFromHtml = loadSeed;

function seed({ force = false } = {}) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM machines').get().n;
  if (existing > 0 && !force) {
    return { seeded: false, reason: 'déjà peuplée', machines: existing };
  }

  const { fleet, audit } = loadSeedFromHtml();
  const now = new Date().toISOString();

  tx(() => {
    db.exec('DELETE FROM machines; DELETE FROM audit; DELETE FROM alarms; DELETE FROM maintenance_tickets; DELETE FROM devices; DELETE FROM sessions;');
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('audit','alarms','maintenance_tickets','sessions');");

    const insM = db.prepare('INSERT INTO machines (id, data, updated_at) VALUES (?, ?, ?)');
    for (const m of fleet) insM.run(m.id, JSON.stringify(m), now);

    // AUDIT_LOG is authored oldest→newest; insert in that order so id ASC == time ASC.
    // Each row is linked into the tamper-evident hash chain (Phase 4).
    const insA = db.prepare(
      'INSERT INTO audit (time, user, machine, action, data, ai, network, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let prev = GENESIS;
    for (const e of audit) {
      const row = { time: e.time, user: e.user, machine: e.machine, action: e.action, data: e.data, ai: e.ai, network: e.network, created_at: now };
      const hash = hashRow(prev, row);
      insA.run(row.time, row.user, row.machine, row.action, row.data, row.ai, row.network, row.created_at, prev, hash);
      prev = hash;
    }

    const insAl = db.prepare(
      'INSERT INTO alarms (machine_id, alarm_id, type, priority, timestamp, duration, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const m of fleet) {
      if (m.currentAlarm) {
        insAl.run(m.id, m.currentAlarm.id, m.currentAlarm.type, m.currentAlarm.priority,
          m.currentAlarm.timestamp, m.currentAlarm.duration || null, 'ACTIVE', null);
      }
      if (m.trendWarning) {
        insAl.run(m.id, 'TREND-' + m.id, m.trendWarning, 'MONITORING', null, null, 'MONITORING', null);
      }
      // Synthetic resolved history, proportional to the 30-day alarm count (POC only).
      const hist = Math.max(0, Math.min(3, Math.round((m.alarms30d || 0) / 6)));
      for (let i = 0; i < hist; i++) {
        insAl.run(m.id, `HIST-${m.id}-${i + 1}`, 'Alarme résolue (historique 30 j)', 'LOW',
          null, null, 'RESOLVED', 'Entrée historique synthétique (POC)');
      }
    }
  });

  return { seeded: true, machines: fleet.length, audit: audit.length };
}

function ensureSeeded() {
  const r = seed({ force: false });
  if (r.seeded) console.log(`[seed] DB peuplée : ${r.machines} machines, ${r.audit} entrées d'audit`);
  seedUsersIfEmpty();
  backfillDemoPins();   // renseigne pin_hash pour les comptes créés avant l'ajout du PIN
  return r;
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  const r = seed({ force });
  const u = seedUsersIfEmpty();
  const p = backfillDemoPins();
  console.log(force ? '[seed --force]' : '[seed]', r, '| users:', u, '| pins:', p);
}

module.exports = { seed, ensureSeeded, loadSeedFromHtml };
