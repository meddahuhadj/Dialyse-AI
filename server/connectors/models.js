'use strict';

/**
 * Per-model data dictionary.
 *
 * An adapter parses its wire protocol and emits *raw* key/value pairs. This module
 * translates those raw keys into a small set of CANONICAL signals, then into the
 * machine-object fields owned by the front-end (Phase 1 schema).
 *
 *   raw key (OBX code / register / serial tag / LOINC / OPC node)
 *        │  signalAliases[model]  (falls back to COMMON_SIGNAL_ALIASES)
 *        ▼
 *   canonical signal  (blood_flow, venous_pressure, …)
 *        │  CANONICAL_TO_FIELD
 *        ▼
 *   machine field  (bfr, pven, …)
 *
 * Machine "state" strings and alarm codes are model-specific → statusAliases.
 */

// canonical signal  →  machine-object field
const CANONICAL_TO_FIELD = {
  blood_flow: 'bfr',
  venous_pressure: 'pven',
  arterial_pressure: 'part',
  tmp: 'tmp',
  uf_rate: 'ufr',
  uf_volume: 'ufv',
  target_uf_volume: 'targetUfv',
  dialysate_conductivity: 'cond',
  dialysate_temp: 'temp',
};

// Broad set of aliases every model understands out of the box. Keys are compared
// case-insensitively and stripped of spaces/underscores/dashes before lookup.
const COMMON_SIGNAL_ALIASES = {
  // blood flow rate
  bfr: 'blood_flow', qb: 'blood_flow', bloodflow: 'blood_flow', bloodflowrate: 'blood_flow',
  bloodpumpflow: 'blood_flow', '199914': 'blood_flow', // LOINC 19991-4
  // venous (return) pressure
  pv: 'venous_pressure', pven: 'venous_pressure', vp: 'venous_pressure', venous: 'venous_pressure',
  venouspressure: 'venous_pressure', returnpressure: 'venous_pressure', '764692': 'venous_pressure',
  // arterial (pre-pump) pressure
  pa: 'arterial_pressure', part: 'arterial_pressure', ap: 'arterial_pressure',
  arterialpressure: 'arterial_pressure', prepumppressure: 'arterial_pressure', '764700': 'arterial_pressure',
  // transmembrane pressure
  tmp: 'tmp', ptm: 'tmp', transmembranepressure: 'tmp', '764726': 'tmp',
  // ultrafiltration
  ufr: 'uf_rate', qf: 'uf_rate', ufrate: 'uf_rate', ultrafiltrationrate: 'uf_rate',
  ufv: 'uf_volume', uftotal: 'uf_volume', ufvolume: 'uf_volume', ultrafiltrationvolume: 'uf_volume',
  removedvolume: 'uf_volume', '202559': 'uf_volume',
  uftarget: 'target_uf_volume', targetuf: 'target_uf_volume', ufgoal: 'target_uf_volume',
  // dialysate
  cond: 'dialysate_conductivity', cd: 'dialysate_conductivity', conductivity: 'dialysate_conductivity',
  dialysateconductivity: 'dialysate_conductivity', '199757': 'dialysate_conductivity',
  temp: 'dialysate_temp', td: 'dialysate_temp', dialysatetemp: 'dialysate_temp',
  dialysatetemperature: 'dialysate_temp',
  // state / alarm (routed separately, see mapReading)
  state: 'machine_state', status: 'machine_state', mode: 'machine_state', phase: 'machine_state',
  machinestate: 'machine_state', treatmentphase: 'machine_state',
  alarm: 'alarm_text', alarmtext: 'alarm_text', alarmmessage: 'alarm_text',
  alarmcode: 'alarm_code', alarmid: 'alarm_code', errorcode: 'alarm_code',
  patient: 'patient_id', patientid: 'patient_id', pid: 'patient_id',
};

// raw machine-state string  →  front-end status enum
const COMMON_STATUS_ALIASES = {
  run: 'NORMAL', running: 'NORMAL', dialysis: 'NORMAL', treatment: 'NORMAL', therapy: 'NORMAL',
   hd: 'NORMAL', online: 'NORMAL', ok: 'NORMAL', normal: 'NORMAL', '0': 'NORMAL',
  warn: 'WARNING', warning: 'WARNING', caution: 'WARNING',
  advisory: 'MONITORING', attention: 'MONITORING', reminder: 'MONITORING',
  alarm: 'ALARM', alarmhigh: 'ALARM', highalarm: 'ALARM', fault: 'ALARM', error: 'ALARM',
  technical: 'ALARM', '1': 'ALARM',
  standby: 'MONITORING', preparation: 'MONITORING', priming: 'MONITORING', prime: 'MONITORING',
  selftest: 'MONITORING', rinse: 'MONITORING', reinfusion: 'MONITORING', connecting: 'MONITORING',
  disinfection: 'OFFLINE', cleaning: 'OFFLINE', off: 'OFFLINE', offline: 'OFFLINE',
  disconnected: 'OFFLINE', shutdown: 'OFFLINE', idle: 'OFFLINE',
};

const norm = (s) => String(s).toLowerCase().replace(/[\s_\-./]/g, '');

/**
 * Registry of supported generator families. `match` is a list of lowercase
 * substrings tested against the machine's `model` string. `nativeProtocols`
 * documents how the device actually exports data in the field; `adapter` is the
 * connector type we recommend wiring up. `signalAliases` / `statusAliases`
 * override or extend the COMMON_* tables for that family.
 */
const MODELS = {
  'fresenius-5008': {
    vendor: 'Fresenius Medical Care',
    label: 'Fresenius 4008 / 5008 / 5008S CorDiax',
    match: ['fresenius 4008', 'fresenius 5008', '5008s', '5008 cordiax', 'cordiax'],
    nativeProtocols: [
      'HL7 v2 ORU^R01 via Nexadia / Therapy Data Management System (TDMS)',
      'Serial RS-232 "F60 / DataLink" ASCII stream (4008/5008)',
      'CSV/XML export files (TDMS batch)',
    ],
    adapter: 'hl7v2',
    signalAliases: {
      qb: 'blood_flow', pven: 'venous_pressure', part: 'arterial_pressure', ptm: 'tmp',
      uf: 'uf_volume', ufgoal: 'target_uf_volume', ld: 'dialysate_conductivity', td: 'dialysate_temp',
    },
    statusAliases: { dial: 'NORMAL', 't1': 'NORMAL', prep: 'MONITORING', reinf: 'MONITORING' },
  },
  'fresenius-6008': {
    vendor: 'Fresenius Medical Care',
    label: 'Fresenius 6008 CAREsystem',
    match: ['fresenius 6008', '6008', 'caresystem'],
    nativeProtocols: [
      'OPC-UA server ("Fresenius Connectivity eXtension")',
      'HL7 v2 / HL7 FHIR via Nexadia Expert',
    ],
    adapter: 'opcua',
    signalAliases: {},
  },
  'baxter-artis': {
    vendor: 'Baxter (ex-Gambro)',
    label: 'Baxter Artis / Artis Physio',
    match: ['artis', 'baxter artis'],
    nativeProtocols: [
      'Ethernet ASCII stream to Exalis data manager (proprietary TCP)',
      'HL7 v2 ORU^R01 export from Exalis',
      'Serial RS-232 (service port)',
    ],
    adapter: 'tcp-ascii',
    signalAliases: { qb: 'blood_flow', pv: 'venous_pressure', pa: 'arterial_pressure' },
    statusAliases: { conn: 'NORMAL', hdf: 'NORMAL', end: 'MONITORING' },
  },
  'gambro-ak': {
    vendor: 'Baxter (ex-Gambro)',
    label: 'Gambro / Baxter AK 96 / AK 98 / AK 200',
    match: ['gambro ak', 'ak 96', 'ak 98', 'ak98', 'ak 200', 'ak200'],
    nativeProtocols: [
      'Serial RS-232 "Gambro Exalis" protocol',
      'CSV export files via Exalis',
    ],
    adapter: 'serial',
    signalAliases: {},
  },
  'nipro-surdial': {
    vendor: 'Nipro',
    label: 'Nipro Surdial / Surdial X / Surdial 55Plus',
    match: ['nipro', 'surdial'],
    nativeProtocols: [
      'Serial RS-232 ASCII frame ("Nipro communication protocol")',
      'LAN export to Nipro "Balance" / "Future" software',
    ],
    adapter: 'serial',
    signalAliases: { bf: 'blood_flow', vp: 'venous_pressure', ap: 'arterial_pressure' },
  },
  'nikkiso-dbb': {
    vendor: 'Nikkiso',
    label: 'Nikkiso DBB-07 / DBB-EXA / DBB-100',
    match: ['nikkiso', 'dbb-07', 'dbb07', 'dbb-exa', 'dbb-100'],
    nativeProtocols: [
      'Serial RS-232 ASCII stream',
      'LAN "Future Net Web" gateway (HL7 export)',
    ],
    adapter: 'serial',
    signalAliases: {},
  },
  'bbraun-dialog': {
    vendor: 'B. Braun',
    label: 'B. Braun Dialog+ / Dialog iQ',
    match: ['b.braun', 'bbraun', 'braun dialog', 'dialog iq', 'dialog+', 'dialogiq'],
    nativeProtocols: [
      'LAN data interface (proprietary TCP, JSON/ASCII) to Nexadia / DASH',
      'HL7 v2 ORU^R01 export',
      'Modbus TCP (some service configurations)',
    ],
    adapter: 'tcp-ascii',
    signalAliases: {},
  },
  'toray-tr': {
    vendor: 'Toray',
    label: 'Toray TR-8000 series',
    match: ['toray', 'tr-8000', 'tr8000'],
    nativeProtocols: ['Serial RS-232 ASCII stream', 'LAN CSV export'],
    adapter: 'serial',
    signalAliases: {},
  },
  'medtronic-bellco': {
    vendor: 'Medtronic (Bellco)',
    label: 'Bellco Formula / Flexya',
    match: ['bellco', 'formula', 'flexya'],
    nativeProtocols: ['Ethernet ASCII stream', 'CSV export'],
    adapter: 'tcp-ascii',
    signalAliases: {},
  },
  generic: {
    vendor: 'Générique',
    label: 'Modèle non listé — mapping commun (LOINC + mnémoniques usuelles)',
    match: [],
    nativeProtocols: ['dépend de l\'appareil — voir README'],
    adapter: 'tcp-ascii',
    signalAliases: {},
  },
};

/** Fuzzy-resolve a machine `model` string to a MODELS key. */
function resolveModel(modelString) {
  const s = String(modelString || '').toLowerCase();
  for (const [key, def] of Object.entries(MODELS)) {
    if (def.match.some((m) => s.includes(m))) return key;
  }
  return 'generic';
}

function aliasTablesFor(modelKey) {
  const def = MODELS[modelKey] || MODELS.generic;
  const signals = { ...COMMON_SIGNAL_ALIASES };
  for (const [k, v] of Object.entries(def.signalAliases || {})) signals[norm(k)] = v;
  const status = { ...COMMON_STATUS_ALIASES };
  for (const [k, v] of Object.entries(def.statusAliases || {})) status[norm(k)] = v;
  return { signals, status };
}

/** raw key → canonical signal (or null if unknown). */
function toCanonical(modelKey, rawKey) {
  const { signals } = aliasTablesFor(modelKey);
  return signals[norm(rawKey)] || null;
}

/** raw state string → status enum (or null). */
function toStatus(modelKey, rawState) {
  const { status } = aliasTablesFor(modelKey);
  return status[norm(rawState)] || null;
}

/**
 * Turn an adapter reading into a partial machine patch.
 * reading = { machineId, model, signals:{rawKey:value|{value}}, alarms:[{code,text,priority}], ts }
 */
function mapReading(modelString, reading) {
  const modelKey = resolveModel(modelString || reading.model);
  const patch = {};
  const signals = reading.signals || {};

  for (const [rawKey, rawVal] of Object.entries(signals)) {
    const value = rawVal && typeof rawVal === 'object' ? rawVal.value : rawVal;
    const canon = toCanonical(modelKey, rawKey);
    if (!canon) continue;

    if (canon === 'machine_state') {
      const st = toStatus(modelKey, value);
      if (st) patch.status = st;
      continue;
    }
    if (canon === 'patient_id') {
      if (value) patch.patientId = String(value);
      continue;
    }
    if (canon === 'alarm_text' || canon === 'alarm_code') continue; // handled below

    const field = CANONICAL_TO_FIELD[canon];
    if (!field) continue;
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isFinite(num)) patch[field] = Math.round(num * 10) / 10;
  }

  const alarms = (reading.alarms || []).filter(Boolean);
  if (alarms.length) {
    const a = alarms[0];
    patch.status = 'ALARM';
    patch.currentAlarm = {
      id: a.code || 'ALM-LIVE',
      type: a.text || a.code || 'Alarme générateur',
      priority: (a.priority || 'HIGH').toUpperCase(),
      timestamp: reading.ts ? reading.ts.substring(11, 19) : new Date().toTimeString().split(' ')[0],
    };
  } else if (patch.status && patch.status !== 'ALARM') {
    // live source says the machine is no longer alarming → clear stale alarm
    patch.currentAlarm = null;
  }

  return { modelKey, patch };
}

module.exports = {
  MODELS,
  CANONICAL_TO_FIELD,
  COMMON_SIGNAL_ALIASES,
  COMMON_STATUS_ALIASES,
  resolveModel,
  toCanonical,
  toStatus,
  mapReading,
  norm,
};
