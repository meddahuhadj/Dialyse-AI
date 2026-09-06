'use strict';

// "WHY THIS SCORE?" — the machine health score, recomputed from real signals
// with a fully transparent derivation instead of a hand-picked demo number.
// Every review asked for this: the user must be able to click the score and
// see exactly which data produced it.
//
// 5 weighted components, each 0-100, each tied to a concrete data source:
//   alarmHistory  0.28  <- alarms30d
//   stability     0.25  <- Machine Fingerprint deviation count
//   maintenance   0.18  <- nextMaintenanceDays
//   reliability   0.15  <- device connectivity + aborted-session ratio
//   utilization   0.14  <- operating hours
//
// Output keeps the exact { reliability, alarmHistory, maintenance, stability,
// utilization } shape the front-end already reads, so nothing breaks — the
// values are just computed now, plus a `derivation` array explaining each.

const WEIGHTS = { alarmHistory: 0.28, stability: 0.25, maintenance: 0.18, reliability: 0.15, utilization: 0.14 };

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Linear interpolation over an anchor table [[x, y], ...] sorted by x asc.
function lerp(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1];
  if (x >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return anchors[anchors.length - 1][1];
}

/**
 * @param machine   the machine object (alarms30d, nextMaintenanceDays, hours)
 * @param ctx       { connectivityStatus, sessionStats:{total,aborted}, fingerprintDeviations:number|null }
 */
function computeHealth(machine, ctx = {}) {
  const alarms = Number(machine.alarms30d) || 0;
  const nextMaint = Number(machine.nextMaintenanceDays);
  const hours = Number(machine.hours) || 0;
  const conn = ctx.connectivityStatus || 'SIMULATION';
  const ss = ctx.sessionStats || { total: 0, aborted: 0 };
  const fpDev = ctx.fingerprintDeviations; // null if no fingerprint history yet

  // --- alarmHistory ---
  const alarmHistory = Math.round(clamp(100 - alarms * 2.5, 30, 100));
  const alarmBasis = `${alarms} alarme(s) sur 30 jours → 100 − ${alarms}×2,5 = ${100 - alarms * 2.5} (borné 30–100)`;

  // --- maintenance ---
  const maintAnchors = [[0, 25], [7, 40], [14, 55], [21, 68], [30, 80], [45, 92], [60, 100], [120, 100]];
  const maintenance = Number.isFinite(nextMaint) ? Math.round(lerp(maintAnchors, nextMaint)) : 80;
  const maintBasis = Number.isFinite(nextMaint)
    ? `Prochaine maintenance dans ${nextMaint} j (barème : 60 j→100, 30 j→80, 14 j→55, 0 j→25)`
    : 'Échéance de maintenance inconnue → valeur neutre 80';

  // --- utilization ---
  const utilAnchors = [[0, 100], [4000, 100], [8000, 82], [11000, 65], [14000, 48], [17000, 35], [30000, 35]];
  const utilization = Math.round(lerp(utilAnchors, hours));
  const utilBasis = `${hours.toLocaleString('fr-FR')} h de fonctionnement (barème : 4 000 h→100, 8 000 h→82, 11 000 h→65, 14 000 h→48)`;

  // --- stability (from fingerprint) ---
  let stability;
  let stabBasis;
  if (fpDev == null) {
    stability = 82;
    stabBasis = "Historique de séances insuffisant pour l'empreinte → valeur neutre 82";
  } else {
    stability = Math.round(clamp(100 - fpDev * 14, 45, 100));
    stabBasis = `${fpDev} métrique(s) hors de l'enveloppe historique de la machine → 100 − ${fpDev}×14 (borné 45–100)`;
  }

  // --- reliability (connectivity + aborted sessions) ---
  const connBase = { CONNECTED: 94, SIMULATION: 94, TESTING: 84, DEGRADED: 76, UNAUTHORIZED: 66, DISCONNECTED: 42 }[conn] ?? 90;
  const abortRatio = ss.total > 0 ? ss.aborted / ss.total : 0;
  const abortPenalty = Math.round(abortRatio * 25);
  const reliability = Math.round(clamp(connBase - abortPenalty, 20, 100));
  const relBasis = `Connectivité ${conn} → base ${connBase}` +
    (ss.total > 0 ? ` ; ${ss.aborted}/${ss.total} séance(s) interrompue(s) → −${abortPenalty}` : ' ; pas de séance interrompue');

  const breakdown = { reliability, alarmHistory, maintenance, stability, utilization };
  const healthScore = Math.round(
    breakdown.alarmHistory * WEIGHTS.alarmHistory +
    breakdown.stability * WEIGHTS.stability +
    breakdown.maintenance * WEIGHTS.maintenance +
    breakdown.reliability * WEIGHTS.reliability +
    breakdown.utilization * WEIGHTS.utilization
  );

  const derivation = [
    { component: 'alarmHistory', label: "Historique d'alarmes", weight: WEIGHTS.alarmHistory, value: alarmHistory, basis: alarmBasis },
    { component: 'stability', label: 'Stabilité (empreinte machine)', weight: WEIGHTS.stability, value: stability, basis: stabBasis },
    { component: 'maintenance', label: 'Maintenance', weight: WEIGHTS.maintenance, value: maintenance, basis: maintBasis },
    { component: 'reliability', label: 'Fiabilité (connectivité & séances)', weight: WEIGHTS.reliability, value: reliability, basis: relBasis },
    { component: 'utilization', label: 'Taux d\'utilisation', weight: WEIGHTS.utilization, value: utilization, basis: utilBasis },
  ];

  return { machineId: machine.id, healthScore, healthBreakdown: breakdown, derivation, weights: WEIGHTS };
}

module.exports = { computeHealth, WEIGHTS };
