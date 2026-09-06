'use strict';

// Automated maintenance ticket generation — closes the gap the 3rd expert
// review flagged: the Maintenance tab only ever showed a static demo list;
// nothing actually reacted to a machine drifting.
//
// Model: every time a machine's status transitions into ALARM, the event is
// logged to the `alarms` table (real history, not synthetic). After each such
// log, we check whether any (machine, alarm type) pair has crossed
// DRIFT_THRESHOLD occurrences — if so, and no OPEN auto-ticket already exists
// for that exact pair (never spam duplicates), a ticket is opened automatically.
// Manual tickets (the existing "+ Créer un Ticket" flow) go through the same
// table/routes with source:'manual'.

const { db } = require('./db');

const DRIFT_THRESHOLD = Number(process.env.HADJ_MAINT_DRIFT_THRESHOLD || 3);

function nextTicketRef() {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM maintenance_tickets WHERE ticket_ref LIKE ?`).get(`BM-${year}-%`);
  return `BM-${year}-${100 + row.n}`;
}

function priorityForCount(n) {
  if (n >= 8) return 'HIGH';
  if (n >= 5) return 'MODERATE';
  return 'LOW';
}

function hasOpenAutoTicket(machineId, alarmType) {
  return !!db.prepare(
    `SELECT 1 FROM maintenance_tickets WHERE machine_id = ? AND alarm_type = ? AND source = 'auto' AND status != 'RESOLU' LIMIT 1`
  ).get(machineId, alarmType);
}

function listTickets({ machineId, status } = {}) {
  let sql = 'SELECT * FROM maintenance_tickets WHERE 1=1';
  const params = [];
  if (machineId) { sql += ' AND machine_id = ?'; params.push(machineId); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...params);
}

function getTicket(id) {
  return db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
}

function createTicket({ machineId, alarmType, title, detail, priority, source, assignedTo }) {
  const now = new Date().toISOString();
  const ref = nextTicketRef();
  const info = db.prepare(
    `INSERT INTO maintenance_tickets (ticket_ref, machine_id, alarm_type, title, detail, priority, status, source, assigned_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OUVERT', ?, ?, ?, ?)`
  ).run(ref, machineId, alarmType || null, title, detail || '', priority || 'MODERATE', source || 'manual', assignedTo || null, now, now);
  return getTicket(info.lastInsertRowid);
}

function updateTicket(id, { status, priority, assignedTo }) {
  const t = getTicket(id);
  if (!t) return null;
  const now = new Date().toISOString();
  const next = {
    status: status || t.status,
    priority: priority || t.priority,
    assigned_to: assignedTo !== undefined ? assignedTo : t.assigned_to,
    resolved_at: (status === 'RESOLU') ? now : (status && status !== 'RESOLU' ? null : t.resolved_at),
  };
  db.prepare('UPDATE maintenance_tickets SET status=?, priority=?, assigned_to=?, resolved_at=?, updated_at=? WHERE id=?')
    .run(next.status, next.priority, next.assigned_to, next.resolved_at, now, id);
  return getTicket(id);
}

/** Log a real alarm occurrence (call on a NORMAL/MONITORING → ALARM transition). */
function logAlarmEvent(machine) {
  const a = machine.currentAlarm;
  if (!a || !a.type) return;
  db.prepare(
    `INSERT INTO alarms (machine_id, alarm_id, type, priority, timestamp, duration, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'ACTIVE', NULL, ?)`
  ).run(machine.id, a.id || null, a.type, a.priority || null, a.timestamp || null, new Date().toISOString());
}

/**
 * Scan alarm history per (machine, type); auto-open a ticket for any pair at
 * or beyond DRIFT_THRESHOLD occurrences that doesn't already have an open
 * auto-ticket. Returns newly-created tickets (usually none).
 */
function runDriftCheck(fleet, { writeAudit } = {}) {
  // RESOLVED rows are closed-out history, not an ongoing problem — only
  // ACTIVE/MONITORING occurrences count toward "still recurring" drift.
  // (Caught by direct testing: seeded synthetic history rows share one
  // generic RESOLVED "historique 30 j" type and would otherwise falsely
  // trigger a ticket for any machine whose demo alarms30d is high enough.)
  const rows = db.prepare(
    `SELECT machine_id, type, COUNT(*) AS n FROM alarms
     WHERE type IS NOT NULL AND type != '' AND status != 'RESOLVED'
     GROUP BY machine_id, type HAVING n >= ?`
  ).all(DRIFT_THRESHOLD);

  const created = [];
  for (const row of rows) {
    if (hasOpenAutoTicket(row.machine_id, row.type)) continue;
    const machine = fleet.find((m) => m.id === row.machine_id);
    const priority = priorityForCount(row.n);
    const title = `Dérive répétée détectée : ${row.type}`;
    const detail = `${row.n} occurrence(s) de « ${row.type} » enregistrée(s) pour ${row.machine_id}` +
      (machine && machine.model ? ` (${machine.model}` + (machine.hours ? `, ${machine.hours.toLocaleString('fr-FR')} h` : '') + ')' : '') +
      '. Inspection biomédicale recommandée — ticket ouvert automatiquement par Maintenance AI.';
    const ticket = createTicket({ machineId: row.machine_id, alarmType: row.type, title, detail, priority, source: 'auto' });
    created.push(ticket);
    if (writeAudit) {
      writeAudit({
        user: 'SYSTEM', machine: row.machine_id, action: 'MAINTENANCE_TICKET_AUTO_CREATED',
        data: `Ticket ${ticket.ticket_ref} auto-généré (${row.n}× "${row.type}")`,
        ai: 'Détection de dérive répétée (Maintenance AI)', network: 'AUTOMATION',
      });
    }
  }
  return created;
}

module.exports = { listTickets, getTicket, createTicket, updateTicket, logAlarmEvent, runDriftCheck, DRIFT_THRESHOLD };
