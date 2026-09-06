'use strict';

// Prescribed vs Delivered — reconciles the imported FHIR prescription against
// what the last archived session actually delivered. Both pieces already
// exist: dpi-import.js (prescription) and sessions.js (delivered). This is the
// join the reviews asked for: "prescription attendue vs séance réellement
// délivrée".
//
// Strictly read-only and honest: parameters the platform cannot measure
// (patient weight, anticoagulation actually given) are shown as REFERENCE
// only, never scored as a gap.

function pct(a, b) {
  if (!b) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

function classifyDuration(gapMin, gapPct) {
  const g = Math.abs(gapMin);
  if (g >= 20 || Math.abs(gapPct) >= 15) return 'significant';
  if (g >= 8) return 'minor';
  return 'ok';
}
function classifyBfr(gap) {
  const g = Math.abs(gap);
  if (g >= 30) return 'significant';
  if (g >= 15) return 'minor';
  return 'ok';
}
function classifyUf(deliveredPct) {
  if (deliveredPct == null) return 'ok';
  if (deliveredPct < 90) return 'significant';
  if (deliveredPct < 95) return 'minor';
  return 'ok';
}

/**
 * @param machine       current machine object
 * @param prescription  dpi-import.getPrescription() result (or null)
 * @param session       last completed session for this patient (or null)
 */
function reconcile(machine, prescription, session) {
  const out = {
    machineId: machine.id,
    patientId: (prescription && prescription.patientId) || machine.patientId || null,
    prescriptionSource: prescription ? prescription.source : null,
    sessionRef: session ? session.session_ref : null,
    sessionEndedAt: session ? session.ended_at : null,
    items: [],
    reference: [],
    overall: null,
  };

  if (!prescription) { out.noPrescription = true; return out; }
  if (!session) { out.noSession = true; return out; }

  const ts = session.telemetry_summary || {};

  // 1. Session duration
  if (typeof prescription.sessionDurationMin === 'number' && typeof session.duration_min === 'number') {
    const gap = session.duration_min - prescription.sessionDurationMin;
    const gp = pct(session.duration_min, prescription.sessionDurationMin);
    out.items.push({
      parameter: 'Durée de séance', unit: 'min',
      prescribed: prescription.sessionDurationMin, delivered: session.duration_min,
      gap, gapPct: gp, status: classifyDuration(gap, gp || 0),
      note: gap < 0 ? 'Séance écourtée par rapport à la prescription' : gap > 0 ? 'Séance prolongée' : null,
    });
  }

  // 2. Blood flow (BFR) — prescribed target vs session mean
  const bfr = ts.bfr;
  if (typeof prescription.targetBloodFlowMlMin === 'number' && bfr && typeof bfr.min === 'number') {
    const deliveredMean = Math.round((bfr.min + bfr.max) / 2);
    const gap = deliveredMean - prescription.targetBloodFlowMlMin;
    out.items.push({
      parameter: 'Débit sang (BFR)', unit: 'mL/min',
      prescribed: prescription.targetBloodFlowMlMin, delivered: deliveredMean,
      gap, gapPct: pct(deliveredMean, prescription.targetBloodFlowMlMin), status: classifyBfr(gap),
      note: Math.abs(gap) >= 15 ? `BFR moyen délivré ${gap > 0 ? 'supérieur' : 'inférieur'} au débit cible` : null,
    });
  }

  // 3. Ultrafiltration — machine-set target vs delivered (from the session record)
  if (typeof session.target_ufv === 'number' && typeof session.delivered_ufv === 'number' && session.target_ufv > 0) {
    const dp = Math.round((session.delivered_ufv / session.target_ufv) * 100);
    out.items.push({
      parameter: 'Volume UF', unit: 'L',
      prescribed: session.target_ufv, delivered: session.delivered_ufv,
      gap: Math.round((session.delivered_ufv - session.target_ufv) * 100) / 100,
      gapPct: dp - 100, status: classifyUf(dp),
      note: dp < 95 ? `Objectif UF atteint à ${dp} %` : `Objectif UF atteint (${dp} %)`,
    });
  }

  // Reference-only (not scored — platform can't measure these)
  if (typeof prescription.dryWeightKg === 'number') {
    out.reference.push({ parameter: 'Poids sec cible', value: `${prescription.dryWeightKg} kg`, note: 'Poids patient non mesuré par la plateforme — référence prescription' });
  }
  if (prescription.anticoagulation && prescription.anticoagulation.drug) {
    const a = prescription.anticoagulation;
    out.reference.push({
      parameter: 'Anticoagulation',
      value: `${a.drug}${a.doseValue ? ' — ' + a.doseValue + ' ' + (a.doseUnit || '') : ''}${a.route ? ' (' + a.route + ')' : ''}`,
      note: 'Administration non tracée par la plateforme — référence prescription',
    });
  }

  const worst = out.items.reduce((acc, it) => {
    if (it.status === 'significant') return 'significant';
    if (it.status === 'minor' && acc !== 'significant') return 'minor';
    return acc;
  }, 'ok');
  out.overall = worst === 'significant' ? 'écarts significatifs' : worst === 'minor' ? 'écarts mineurs' : 'conforme à la prescription';

  return out;
}

module.exports = { reconcile };
