'use strict';

// Machine Fingerprint — a per-machine behavioural baseline built from its own
// archived sessions, then a comparison of the machine's CURRENT behaviour
// against that historical norm. The point (asked for by three separate
// reviews): catch "this machine isn't behaving the way IT usually does",
// which a fixed threshold can't — a generator that always runs venous
// pressure at 90 mmHg is drifting if it's now at 140, even though 140 is well
// inside the global "safe" band.
//
// Complements maintenance.js drift detection: that watches for the SAME alarm
// type recurring; this watches the telemetry envelope moving away from the
// machine's personal history.
//
// Needs sessions.js archives to have accumulated. With < MIN_SESSIONS of
// history the fingerprint is returned with low confidence and no deviation
// claims — never a fabricated baseline.

const MIN_SESSIONS = Number(process.env.HADJ_FP_MIN_SESSIONS || 3);
const Z_DEVIATION = Number(process.env.HADJ_FP_Z || 2);

const METRICS = [
  { field: 'pven', label: 'Pression veineuse', unit: 'mmHg' },
  { field: 'part', label: 'Pression artérielle', unit: 'mmHg' },
  { field: 'tmp', label: 'Pression transmembranaire (TMP)', unit: 'mmHg' },
  { field: 'bfr', label: 'Débit sang (BFR)', unit: 'mL/min' },
  { field: 'ufr', label: "Débit d'ultrafiltration (UFR)", unit: 'mL/h' },
  { field: 'cond', label: 'Conductivité dialysat', unit: 'mS/cm' },
  { field: 'temp', label: 'Température dialysat', unit: '°C' },
];

function meanStd(vals) {
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * @param machine       current machine object (live telemetry)
 * @param sessionList    that machine's archived sessions (newest first), each
 *                       with parsed telemetry_summary {field:{min,max,last}}
 */
function computeFingerprint(machine, sessionList) {
  const completed = (sessionList || []).filter((s) => s.status !== 'aborted' && s.telemetry_summary);
  const used = completed.slice(0, 20); // last 20 sessions
  const n = used.length;
  const enough = n >= MIN_SESSIONS;

  const metrics = METRICS.map((m) => {
    // historical: use each session's mean-of-(min,max) as its representative value
    const hist = [];
    for (const s of used) {
      const t = s.telemetry_summary[m.field];
      if (t && typeof t.min === 'number' && typeof t.max === 'number') hist.push((t.min + t.max) / 2);
    }
    const current = typeof machine[m.field] === 'number' ? machine[m.field] : null;
    if (hist.length < MIN_SESSIONS || current === null) {
      return { field: m.field, label: m.label, unit: m.unit, current, mean: null, std: null, z: null, deviating: false };
    }
    const { mean, std } = meanStd(hist);
    const z = std > 0.001 ? (current - mean) / std : 0;
    return {
      field: m.field, label: m.label, unit: m.unit,
      current: Math.round(current * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      std: Math.round(std * 100) / 100,
      z: Math.round(z * 100) / 100,
      deviating: enough && Math.abs(z) >= Z_DEVIATION,
    };
  });

  // behavioural aggregates
  const alarmCounts = used.map((s) => s.alarm_count || 0);
  const durations = used.map((s) => s.duration_min || 0).filter((d) => d > 0);
  const ufRatios = used
    .filter((s) => s.target_ufv && s.delivered_ufv != null)
    .map((s) => s.delivered_ufv / s.target_ufv);

  const profile = {
    alarmRatePerSession: alarmCounts.length ? Math.round((alarmCounts.reduce((a, b) => a + b, 0) / alarmCounts.length) * 100) / 100 : null,
    meanDurationMin: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    meanUfDeliveryPct: ufRatios.length ? Math.round((ufRatios.reduce((a, b) => a + b, 0) / ufRatios.length) * 100) : null,
  };

  // normalised bars (0..100) for a visual fingerprint — lower std = more stable
  const bars = metrics
    .filter((mm) => mm.mean !== null)
    .map((mm) => {
      const rel = mm.std / (Math.abs(mm.mean) || 1);            // coefficient of variation
      const stability = Math.max(0, Math.min(100, Math.round(100 - rel * 400)));
      return { field: mm.field, label: mm.label, stability, deviating: mm.deviating };
    });

  const deviations = metrics.filter((mm) => mm.deviating).map((mm) => ({
    field: mm.field, label: mm.label,
    current: mm.current, expected: mm.mean, z: mm.z, unit: mm.unit,
    direction: mm.z > 0 ? 'up' : 'down',
  }));

  return {
    machineId: machine.id,
    basedOnSessions: n,
    confidence: enough ? (n >= 8 ? 'high' : 'moderate') : 'low',
    note: enough ? null : `Historique insuffisant (${n}/${MIN_SESSIONS} séances) — profil affiché à titre indicatif, aucune déviation revendiquée.`,
    metrics,
    profile,
    bars,
    deviations,
  };
}

module.exports = { computeFingerprint, MIN_SESSIONS };
