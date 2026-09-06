'use strict';

// DPI/DPH prescription IMPORT — HL7 FHIR R4, read-only.
//
// The existing DPI tab only ever EXPORTED session telemetry outward (see
// buildFhirBundle() in HADJ-ASSISTANT.html). This module closes the other
// direction: pulling the medical PRESCRIPTION (dry weight, session duration,
// anticoagulation, target blood flow) from the hospital's EHR, so clinicians
// don't have to re-key it into HADJ.
//
// Same architecture as the machine connectors and Gemini Live: a real,
// configurable upstream (here: the hospital's FHIR server) with an explicit,
// clearly-labeled DEMO fallback when nothing is configured or the server is
// unreachable. Never silently fabricate a real clinical value — every field
// that isn't found in the Bundle comes back `null`, not a guess.
//
// Two ways in, same normalizer:
//   1. Live pull  — GET {baseUrl}/ServiceRequest|MedicationRequest|Observation
//                   (configured via PUT /api/config/dpi-fhir, ADMIN only).
//   2. Manual import — a clinician uploads/pastes a FHIR Bundle JSON exported
//                   from the DPI (common when there's no live API access).
//      POST /api/dpi/prescription/import
//
// FHIR has no single universal code for "target dry weight" or "target blood
// flow rate" as a *prescribed* value (only LOINC 29463-7 for a *measured*
// body weight exists generically) — real deployments use a local
// CodeSystem for the dialysis-specific prescription fields, which is what we
// look for here (LOCAL_SYSTEM below). A real integration would agree on this
// system/these codes with the hospital's DPI team; ours is documented and
// used consistently between the demo bundle and the parser so the round trip
// is verifiable.

const secrets = require('./secrets');
const demoBundle = require('./dpi-demo-bundle.json');

const LOCAL_SYSTEM = 'http://hadj.local/fhir/CodeSystem/dialysis-parameter';
const CODE_DRY_WEIGHT = 'dry-weight';
const CODE_TARGET_BFR = 'target-blood-flow';
const ANTICOAG_KEYWORDS = ['héparine', 'heparin', 'héparinate', 'enoxaparine', 'enoxaparin'];

function getConfig() {
  const raw = secrets.getSecret('dpi_fhir_config');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function setConfig({ baseUrl, apiKey }) {
  secrets.setSecret('dpi_fhir_config', JSON.stringify({ baseUrl, apiKey: apiKey || '' }));
}
function clearConfig() {
  secrets.setSecret('dpi_fhir_config', '');
}
function isConfigured() {
  const c = getConfig();
  return !!(c && c.baseUrl);
}
function safeHost(url) {
  try { return new URL(url).host; } catch { return null; }
}
function configMeta() {
  const c = getConfig();
  const meta = secrets.secretMeta('dpi_fhir_config');
  return {
    configured: isConfigured(),
    host: c && c.baseUrl ? safeHost(c.baseUrl) : null,
    updated_at: c && c.baseUrl ? meta.updated_at : null,
  };
}

function hasCoding(concept, system, code) {
  return !!(concept && Array.isArray(concept.coding) &&
    concept.coding.some((c) => c.system === system && c.code === code));
}
function textIncludesAny(concept, keywords) {
  const text = ((concept && concept.text) || '').toLowerCase();
  const codingDisplays = (concept && concept.coding || []).map((c) => (c.display || '').toLowerCase());
  return keywords.some((kw) => text.includes(kw) || codingDisplays.some((d) => d.includes(kw)));
}

/**
 * Normalize a FHIR Bundle (searchset or collection) containing any mix of
 * ServiceRequest / MedicationRequest / Observation / Patient resources into
 * the flat shape the front-end prescription card displays. Missing fields
 * stay `null` — never guessed.
 */
function parseBundle(bundle) {
  if (!bundle || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) {
    const err = new Error('Bundle FHIR invalide : resourceType "Bundle" avec un tableau "entry" attendu');
    err.code = 'BAD_BUNDLE';
    throw err;
  }
  const resources = bundle.entry.map((e) => e.resource).filter(Boolean);

  const patient = resources.find((r) => r.resourceType === 'Patient');
  const serviceRequest = resources.find((r) => r.resourceType === 'ServiceRequest');
  const medicationRequest = resources.find((r) =>
    r.resourceType === 'MedicationRequest' &&
    textIncludesAny(r.medicationCodeableConcept, ANTICOAG_KEYWORDS));
  const dryWeightObs = resources.find((r) =>
    r.resourceType === 'Observation' && hasCoding(r.code, LOCAL_SYSTEM, CODE_DRY_WEIGHT));
  const targetBfrObs = resources.find((r) =>
    r.resourceType === 'Observation' && hasCoding(r.code, LOCAL_SYSTEM, CODE_TARGET_BFR));

  let sessionDurationMin = null;
  if (serviceRequest && serviceRequest.occurrenceTiming && serviceRequest.occurrenceTiming.repeat) {
    const rep = serviceRequest.occurrenceTiming.repeat;
    if (typeof rep.duration === 'number') {
      const unit = rep.durationUnit;
      sessionDurationMin = unit === 'h' ? rep.duration * 60 : unit === 's' ? rep.duration / 60 : rep.duration;
    }
  }

  let anticoagulation = null;
  if (medicationRequest) {
    const dose = medicationRequest.dosageInstruction && medicationRequest.dosageInstruction[0];
    const doseQty = dose && dose.doseAndRate && dose.doseAndRate[0] && dose.doseAndRate[0].doseQuantity;
    anticoagulation = {
      drug: (medicationRequest.medicationCodeableConcept && medicationRequest.medicationCodeableConcept.text) || null,
      doseValue: doseQty ? doseQty.value : null,
      doseUnit: doseQty ? doseQty.unit : null,
      route: (dose && dose.route && dose.route.text) || null,
    };
  }

  return {
    patientId: (patient && (patient.id || (patient.identifier && patient.identifier[0] && patient.identifier[0].value))) || null,
    patientRef: patient ? `Patient/${patient.id}` : null,
    dryWeightKg: dryWeightObs ? dryWeightObs.valueQuantity.value : null,
    sessionDurationMin,
    targetBloodFlowMlMin: targetBfrObs ? targetBfrObs.valueQuantity.value : null,
    anticoagulation,
    prescriber: (serviceRequest && serviceRequest.requester && serviceRequest.requester.display) || null,
    prescriptionDate: (serviceRequest && serviceRequest.authoredOn) || null,
  };
}

/** Real HTTP pull against the configured hospital FHIR server. */
async function fetchLivePrescription(patientId) {
  const cfg = getConfig();
  if (!cfg || !cfg.baseUrl) {
    const err = new Error('Aucun serveur FHIR DPI configuré côté serveur');
    err.code = 'NO_CONFIG';
    throw err;
  }
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers = { accept: 'application/fhir+json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const searches = [
    `${base}/ServiceRequest?patient=${encodeURIComponent(patientId)}&status=active`,
    `${base}/MedicationRequest?patient=${encodeURIComponent(patientId)}&status=active`,
    `${base}/Observation?patient=${encodeURIComponent(patientId)}&category=procedure`,
    `${base}/Patient/${encodeURIComponent(patientId)}`,
  ];

  let responses;
  try {
    responses = await Promise.all(searches.map((u) =>
      fetch(u, { headers, signal: AbortSignal.timeout(8000) }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })));
  } catch (e) {
    const err = new Error(`Serveur FHIR DPI injoignable ou en erreur : ${e.message}`);
    err.code = 'NETWORK';
    throw err;
  }

  // First 3 responses are Bundles (searchsets); the 4th is a bare Patient resource.
  const [srBundle, mrBundle, obsBundle, patientResource] = responses;
  const merged = {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      ...(srBundle.entry || []),
      ...(mrBundle.entry || []),
      ...(obsBundle.entry || []),
      ...(patientResource && patientResource.resourceType === 'Patient' ? [{ resource: patientResource }] : []),
    ],
  };
  return parseBundle(merged);
}

/** Live-if-configured, demo fallback otherwise — same shape either way. */
async function getPrescription(patientId) {
  if (isConfigured()) {
    try {
      const result = await fetchLivePrescription(patientId);
      result.source = 'live';
      result.fetchedAt = new Date().toISOString();
      return result;
    } catch (e) {
      console.warn('[dpi-import] échec du pull live, bascule démo :', e.message);
    }
  }
  const result = parseBundle(demoBundle);
  result.source = 'demo';
  result.fetchedAt = new Date().toISOString();
  result.note = "Aucun serveur FHIR DPI configuré (ou injoignable) — exemple de démonstration affiché, pas une vraie donnée patient.";
  return result;
}

module.exports = {
  isConfigured, configMeta, setConfig, clearConfig,
  parseBundle, fetchLivePrescription, getPrescription,
};
