'use strict';

// SQLite persistence layer built on Node's built-in `node:sqlite` (no native build step).
// Node >= 22.5. The module prints one ExperimentalWarning on load — harmless.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.HADJ_DB || path.join(__dirname, 'hadj.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id          TEXT PRIMARY KEY,
    data        TEXT NOT NULL,          -- full machine object as JSON (schema owned by the front-end)
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    time        TEXT NOT NULL,          -- HH:MM:SS wall clock shown in the UI
    user        TEXT,
    machine     TEXT,
    action      TEXT NOT NULL,
    data        TEXT,
    ai          TEXT,
    network     TEXT,
    created_at  TEXT NOT NULL,          -- ISO timestamp, authoritative ordering
    prev_hash   TEXT,                   -- tamper-evident hash chain (Phase 4)
    hash        TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL,          -- ADMIN | NEPHROLOGIST | NURSE | TECHNICIAN | AUDITOR | TRAINING
    pw_hash     TEXT NOT NULL,          -- scrypt$salt$dk
    pin_hash    TEXT,                   -- scrypt$salt$dk — 2nd factor for critical actions (Phase 4b)
    disabled    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alarms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT NOT NULL,
    alarm_id    TEXT,
    type        TEXT,
    priority    TEXT,
    timestamp   TEXT,
    duration    TEXT,
    status      TEXT,                   -- ACTIVE | MONITORING | RESOLVED
    note        TEXT,
    created_at  TEXT                    -- ISO, set on real-time inserts (NULL on old/seeded rows)
  );

  CREATE TABLE IF NOT EXISTS maintenance_tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_ref  TEXT NOT NULL,          -- display id, e.g. BM-2026-101
    machine_id  TEXT NOT NULL,
    alarm_type  TEXT,                   -- recurring alarm type that triggered an AUTO ticket
    title       TEXT NOT NULL,
    detail      TEXT,
    priority    TEXT NOT NULL DEFAULT 'MODERATE',  -- LOW | MODERATE | HIGH
    status      TEXT NOT NULL DEFAULT 'OUVERT',    -- OUVERT | PLANIFIE | RESOLU
    source      TEXT NOT NULL DEFAULT 'manual',    -- manual | auto
    assigned_to TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id             TEXT PRIMARY KEY,     -- = machine id (HD-07)
    manufacturer   TEXT,
    model          TEXT,
    serial         TEXT,
    firmware       TEXT,
    ip             TEXT,
    port           TEXT,
    protocol       TEXT,
    interface_type TEXT,                 -- ethernet | serial | tcp | usb | vendor-api
    gateway_id     TEXT,
    approval_state TEXT NOT NULL DEFAULT 'NOT_APPROVED',  -- NOT_APPROVED|TESTING|APPROVED|ACTIVE|DISABLED
    data_mode      TEXT NOT NULL DEFAULT 'READ_ONLY',
    safety_checks  TEXT,                 -- JSON: the §30 13-point gate, each true/false
    authorized_by  TEXT,
    authorized_at  TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_ref       TEXT NOT NULL,
    machine_id        TEXT NOT NULL,
    patient_id        TEXT,
    model             TEXT,
    started_at        TEXT NOT NULL,
    ended_at          TEXT NOT NULL,
    duration_min      INTEGER,
    status            TEXT NOT NULL DEFAULT 'completed',  -- completed | aborted
    target_ufv        REAL,
    delivered_ufv     REAL,
    telemetry_summary TEXT,   -- JSON: per field {min,max,last,samples}
    alarm_count       INTEGER DEFAULT 0,
    alarm_types       TEXT,   -- JSON array
    events            TEXT,   -- JSON timeline [{t,label}]
    summary           TEXT,   -- auto-generated narrative
    validated_by      TEXT,
    validated_at      TEXT,
    created_at        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_alarms_machine ON alarms(machine_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit(created_at);
  CREATE INDEX IF NOT EXISTS idx_tickets_machine ON maintenance_tickets(machine_id, status);
  CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(machine_id, patient_id, id);
`);

// Migrate an existing pre-Phase-4 database in place.
for (const col of ['prev_hash TEXT', 'hash TEXT']) {
  try { db.exec(`ALTER TABLE audit ADD COLUMN ${col};`); } catch { /* already there */ }
}
try { db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT;'); } catch { /* already there */ }
try { db.exec('ALTER TABLE alarms ADD COLUMN created_at TEXT;'); } catch { /* already there */ }

/** Run `fn` inside a transaction (node:sqlite has no `.transaction()` helper). */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, tx, DB_PATH };
