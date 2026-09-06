'use strict';

// Fleet Analytics — cross-machine pattern detection. The per-machine modules
// (drift tickets, fingerprint) answer "is THIS machine drifting?". This one
// answers "are SEVERAL machines showing the same thing?" — which points at a
// batch of consumables, a dialysate-supply issue, a firmware regression, or a
// gateway/network problem rather than one failing generator.
//
// Signal sources, all already collected:
//   - the `alarms` table (real events logged on the tick loop)
//   - device connectivity (Device Center), cross-referenced by gateway
//
// A pattern is only surfaced, never acted on: every result carries
// "biomedical verification required before any technical intervention".

const { db } = require('./db');
const models = require('./connectors/models');

const MIN_MACHINES = Number(process.env.HADJ_FA_MIN_MACHINES || 2);
// Seed placeholder types that aren't real distinct alarms — don't treat as a pattern.
const PLACEHOLDER_RE = /historique|synth[ée]tique|\bPOC\b|d[ée]monstration/i;

function detectPatterns(fleet, deviceList = []) {
  const modelOf = (mid) => {
    const m = fleet.find((x) => x.id === mid);
    if (!m) return null;
    const key = models.resolveModel(m.model);
    return (models.MODELS[key] || {}).label || m.model || null;
  };

  const patterns = [];

  // 1. Same alarm TYPE across multiple machines.
  const rows = db.prepare(
    `SELECT machine_id, type, COUNT(*) AS n, MIN(COALESCE(created_at, timestamp)) AS first_seen, MAX(COALESCE(created_at, timestamp)) AS last_seen
     FROM alarms
     WHERE type IS NOT NULL AND type != ''
     GROUP BY machine_id, type`
  ).all();

  const byType = new Map();
  for (const r of rows) {
    if (PLACEHOLDER_RE.test(r.type)) continue;
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }

  for (const [type, machineRows] of byType) {
    if (machineRows.length < MIN_MACHINES) continue;
    const machines = machineRows
      .map((mr) => ({ id: mr.machine_id, model: modelOf(mr.machine_id), count: mr.n }))
      .sort((a, b) => b.count - a.count);
    const modelsInvolved = [...new Set(machines.map((m) => m.model).filter(Boolean))];
    const sameModel = modelsInvolved.length === 1;
    const totalOccurrences = machines.reduce((s, m) => s + m.count, 0);
    const firstSeen = machineRows.map((r) => r.first_seen).filter(Boolean).sort()[0] || null;

    let insight = `Motif commun : « ${type} » observé sur ${machines.length} générateurs (${machines.map((m) => m.id).join(', ')})`;
    if (sameModel && modelsInvolved[0]) {
      insight += ` — tous du même modèle ${modelsInvolved[0]}. Une vérification technique comparative (lot de consommables, révision, firmware) peut être pertinente.`;
    } else {
      insight += `. Répartition multi-modèles — évaluer une cause commune côté eau/dialysat, réseau ou environnement.`;
    }

    patterns.push({
      id: `alarm-type:${type}`,
      kind: 'alarm-type',
      alarmType: type,
      machines,
      modelsInvolved,
      sameModel,
      model: sameModel ? modelsInvolved[0] : null,
      totalOccurrences,
      sinceOldest: firstSeen,
      severity: sameModel && machines.length >= 3 ? 'high' : 'moderate',
      insight,
      verification: 'Vérification biomédicale requise avant toute intervention technique.',
    });
  }

  // 2. Connectivity pattern: multiple devices degraded/disconnected on the same gateway.
  const byGateway = new Map();
  for (const d of deviceList) {
    if (!['DEGRADED', 'DISCONNECTED'].includes(d.connectivityStatus)) continue;
    const gw = d.gatewayId || '(sans gateway)';
    if (!byGateway.has(gw)) byGateway.set(gw, []);
    byGateway.get(gw).push(d);
  }
  for (const [gw, ds] of byGateway) {
    if (ds.length < MIN_MACHINES) continue;
    patterns.push({
      id: `connectivity:${gw}`,
      kind: 'connectivity',
      alarmType: null,
      machines: ds.map((d) => ({ id: d.id, model: d.model, count: null })),
      modelsInvolved: [...new Set(ds.map((d) => d.model).filter(Boolean))],
      sameModel: false,
      model: null,
      totalOccurrences: ds.length,
      sinceOldest: null,
      severity: 'high',
      insight: `${ds.length} appareils en perte/dégradation de communication sur la gateway ${gw}. Suspicion de problème réseau ou de gateway — ce n'est PAS forcément une panne machine.`,
      verification: 'Vérification biomédicale requise avant toute intervention technique.',
    });
  }

  patterns.sort((a, b) => (a.severity === b.severity ? b.totalOccurrences - a.totalOccurrences : (a.severity === 'high' ? -1 : 1)));

  return { generatedAt: new Date().toISOString(), count: patterns.length, patterns };
}

module.exports = { detectPatterns, MIN_MACHINES };
