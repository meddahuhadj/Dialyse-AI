'use strict';

// Alarm cascade clustering — closes the #1 gap flagged by the 4th expert
// review: a mechanical issue (kinked venous line, dislodged needle…) fires
// 3-5 separate alarms in quick succession, and each is shown as its own
// disconnected alert. Real nurses read the FIRST one, learn nothing new from
// the rest, and start ignoring alarms altogether ("alarm fatigue" — the very
// problem this whole app was built to fight).
//
// Model: every real alarm transition is already logged to the `alarms` table
// with a true ISO `created_at` (see maintenance.js's logAlarmEvent(), hooked
// into the same tick loop in index.js). This module looks, per machine, at
// the alarm types seen within a short rolling window; when 2+ DISTINCT types
// land close together, it matches their combined text against a small table
// of known clinical co-occurrence patterns and synthesizes ONE "mother alert"
// with a root-cause hypothesis + a short action checklist — instead of N
// separate alarms competing for attention. No match → an honest generic
// fallback ("needs manual assessment"), never a fabricated diagnosis.
//
// Deliberately stateless/query-driven (no separate table): clusters are
// recomputed from the alarms table on each read, so there's nothing to keep
// in sync or garbage-collect — a cluster simply stops existing once its
// members age out of the window.

const { db } = require('./db');

const CLUSTER_WINDOW_MS = Number(process.env.HADJ_CLUSTER_WINDOW_MS || 3 * 60 * 1000); // 3 min

// Order matters: first matching pattern wins. Matching is on the union of
// alarm `type` strings seen in the window, lowercased substring search —
// same style already used elsewhere in this app (see executeVoiceCommand()).
const ROOT_CAUSE_PATTERNS = [
  {
    id: 'venous-obstruction',
    needs: [['veineuse haute', 'pven'], ['pompe', 'arrêt pompe', 'arret pompe']],
    hypothesis: "Obstacle du retour veineux immédiat (plicature de ligne, clamp fermé, ou déplacement d'aiguille)",
    checklist: [
      'Vérifier le clamp de la ligne veineuse',
      "Contrôler la position du biseau de l'aiguille",
      'Examiner la chambre veineuse (recherche de fibrine)',
    ],
  },
  {
    id: 'filter-clotting',
    needs: [['tmp', 'transmembranaire'], ['veineuse haute', 'pven', 'coagulation']],
    hypothesis: 'Coagulation du filtre / dialyseur colmaté',
    checklist: [
      "Vérifier l'anticoagulation en cours (dose, débit)",
      'Inspecter visuellement le dialyseur (couleur, stries sombres)',
      'Envisager un rinçage au sérum physiologique ou un changement de circuit',
    ],
  },
  {
    id: 'arterial-line-air',
    needs: [['air', 'microbulle', 'piège à air', 'piege a air'], ['artérielle basse', 'arterielle basse', 'part']],
    hypothesis: "Défaut d'amorçage ou prise d'air sur la ligne artérielle",
    checklist: [
      'Vérifier les raccords de la ligne artérielle',
      "Contrôler le niveau du piège à bulles",
      'Inspecter le site de ponction artérielle',
    ],
  },
];

const FALLBACK = {
  id: 'generic-cascade',
  hypothesis: 'Alarmes multiples corrélées sur une courte période — évaluation manuelle requise',
  checklist: [
    'Se rendre au poste immédiatement',
    "Vérifier l'état clinique du patient en priorité",
    'Consulter l\'historique détaillé des alarmes de la machine',
  ],
};

function textMatchesGroup(texts, group) {
  return group.some((kw) => texts.some((t) => t.includes(kw)));
}
function matchPattern(types) {
  const texts = types.map((t) => t.toLowerCase());
  for (const p of ROOT_CAUSE_PATTERNS) {
    if (p.needs.every((group) => textMatchesGroup(texts, group))) return p;
  }
  return null;
}

/**
 * Active clusters right now: machines with 2+ distinct real alarm types
 * logged within CLUSTER_WINDOW_MS of each other (using the most recent one
 * as the window anchor, so a cluster naturally expires as time passes).
 */
function detectClusters() {
  const rows = db.prepare(
    `SELECT machine_id, type, created_at FROM alarms
     WHERE created_at IS NOT NULL AND type IS NOT NULL AND type != ''
     ORDER BY created_at DESC`
  ).all();

  const byMachine = new Map();
  for (const r of rows) {
    if (!byMachine.has(r.machine_id)) byMachine.set(r.machine_id, []);
    byMachine.get(r.machine_id).push(r);
  }

  const now = Date.now();
  const clusters = [];
  for (const [machineId, events] of byMachine) {
    if (!events.length) continue;
    const anchor = new Date(events[0].created_at).getTime();
    if (now - anchor > CLUSTER_WINDOW_MS) continue; // most recent event itself already stale
    const inWindow = events.filter((e) => anchor - new Date(e.created_at).getTime() <= CLUSTER_WINDOW_MS);
    const distinctTypes = [...new Set(inWindow.map((e) => e.type))];
    if (distinctTypes.length < 2) continue;

    const pattern = matchPattern(distinctTypes) || FALLBACK;
    clusters.push({
      machineId,
      types: distinctTypes,
      count: inWindow.length,
      windowStart: inWindow[inWindow.length - 1].created_at,
      windowEnd: inWindow[0].created_at,
      patternId: pattern.id,
      hypothesis: pattern.hypothesis,
      checklist: pattern.checklist,
    });
  }
  return clusters;
}

module.exports = { detectClusters, CLUSTER_WINDOW_MS };
