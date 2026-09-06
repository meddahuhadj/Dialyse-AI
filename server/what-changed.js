'use strict';

// "WHAT CHANGED?" — compares a machine's telemetry NOW against its state
// ~5 min and ~30 min ago and surfaces only the notable deltas. Pure read-only
// situational awareness ("what's different from before that I should look at?").
// The AI never says what to DO — that's the protocol + the clinician.
//
// Storage: an in-memory ring buffer of periodic snapshots, same spirit as the
// _prevStatus / _simBaseline maps in index.js. A 30-minute horizon doesn't
// justify a SQLite time-series table; after a restart a machine simply has
// "insufficient history" for a few minutes, exactly like a cold boot.
//
// NOT covered here: "vs previous session" — there is no archived per-session
// telemetry model yet, so that comparison is deliberately omitted rather than
// faked.

const SNAPSHOT_EVERY_MS = Number(process.env.HADJ_WC_SNAPSHOT_MS || 30_000);
// Comparison windows (env-overridable so tests don't have to wait real minutes,
// same convention as CLUSTER_WINDOW_MS / DRIFT_THRESHOLD in the sibling modules).
const WINDOW_SHORT_MS = Number(process.env.HADJ_WC_SHORT_MS || 5 * 60 * 1000);
const WINDOW_LONG_MS = Number(process.env.HADJ_WC_LONG_MS || 30 * 60 * 1000);
const HISTORY_MS = Math.max(WINDOW_LONG_MS * 1.35, 40 * 60 * 1000); // keep a bit more than the longest window

// Clinically-meaningful "notable change" thresholds for a dialysis session.
const FIELDS = [
  { key: 'pven', label: 'Pression veineuse', unit: 'mmHg', threshold: 10 },
  { key: 'part', label: 'Pression artérielle', unit: 'mmHg', threshold: 15, abs: true },
  { key: 'tmp', label: 'Pression transmembranaire (TMP)', unit: 'mmHg', threshold: 15 },
  { key: 'bfr', label: 'Débit sang (BFR)', unit: 'mL/min', threshold: 20 },
  { key: 'ufr', label: "Débit d'ultrafiltration (UFR)", unit: 'mL/h', threshold: 100 },
  { key: 'cond', label: 'Conductivité dialysat', unit: 'mS/cm', threshold: 0.3 },
  { key: 'temp', label: 'Température dialysat', unit: '°C', threshold: 0.3 },
];

const _history = new Map(); // machineId -> [{ ts, snap }]

function snapOf(m) {
  const s = {};
  for (const f of FIELDS) s[f.key] = typeof m[f.key] === 'number' ? m[f.key] : null;
  s.status = m.status || null;
  s.alarmType = m.currentAlarm ? (m.currentAlarm.type || null) : null;
  s.ufv = typeof m.ufv === 'number' ? m.ufv : null;
  return s;
}

function recordSnapshot(fleet) {
  const now = Date.now();
  for (const m of fleet) {
    if (!_history.has(m.id)) _history.set(m.id, []);
    const buf = _history.get(m.id);
    buf.push({ ts: now, snap: snapOf(m) });
    const cutoff = now - HISTORY_MS;
    while (buf.length && buf[0].ts < cutoff) buf.shift();
  }
}

function nearest(buf, targetTs) {
  let best = null;
  let bestGap = Infinity;
  for (const e of buf) {
    const gap = Math.abs(e.ts - targetTs);
    if (gap < bestGap) { bestGap = gap; best = e; }
  }
  return best;
}

function diff(fromSnap, toSnap) {
  const changes = [];
  for (const f of FIELDS) {
    const a = fromSnap[f.key];
    const b = toSnap[f.key];
    if (a == null || b == null) continue;
    const delta = b - a;
    const mag = f.abs ? Math.abs(Math.abs(b) - Math.abs(a)) : Math.abs(delta);
    if (mag < f.threshold) continue;
    changes.push({
      field: f.key, label: f.label, unit: f.unit,
      from: a, to: b,
      delta: Math.round(delta * 100) / 100,
      direction: delta > 0 ? 'up' : 'down',
    });
  }
  if (fromSnap.status !== toSnap.status) {
    changes.push({ field: 'status', label: 'Statut machine', from: fromSnap.status, to: toSnap.status, direction: 'change' });
  }
  if ((fromSnap.alarmType || null) !== (toSnap.alarmType || null)) {
    changes.push({
      field: 'alarm', label: 'Alarme',
      from: fromSnap.alarmType || '—', to: toSnap.alarmType || '—',
      direction: toSnap.alarmType ? 'appeared' : 'cleared',
    });
  }
  return changes;
}

function whatChanged(machineId, machine, prevSession) {
  const buf = _history.get(machineId) || [];
  const now = Date.now();
  const current = snapOf(machine);
  const windows = [
    { window: '5min', ms: WINDOW_SHORT_MS },
    { window: '30min', ms: WINDOW_LONG_MS },
  ];
  const comparisons = windows.map((w) => {
    const base = nearest(buf, now - w.ms);
    // A baseline only counts if it's at least halfway back into the window.
    if (!base || (now - base.ts) < w.ms * 0.5) {
      return { window: w.window, insufficientHistory: true };
    }
    return {
      window: w.window,
      baselineAgoSec: Math.round((now - base.ts) / 1000),
      changes: diff(base.snap, current),
    };
  });

  // "vs previous session" — compare against that session's end-of-run values.
  if (prevSession && prevSession.telemetry_summary) {
    const ts = prevSession.telemetry_summary;
    const prevSnap = {};
    for (const f of FIELDS) prevSnap[f.key] = ts[f.key] ? ts[f.key].last : null;
    prevSnap.status = null; // status/alarm aren't meaningful across sessions
    prevSnap.alarmType = null;
    comparisons.push({
      window: 'prevSession',
      sessionRef: prevSession.session_ref,
      sessionEndedAt: prevSession.ended_at,
      changes: diff(prevSnap, current).filter((c) => c.field !== 'status' && c.field !== 'alarm'),
    });
  } else {
    comparisons.push({ window: 'prevSession', insufficientHistory: true });
  }

  return { machineId, generatedAt: new Date().toISOString(), comparisons };
}

module.exports = { recordSnapshot, whatChanged, SNAPSHOT_EVERY_MS };
