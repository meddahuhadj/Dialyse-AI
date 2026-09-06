'use strict';

// Device Center — the backbone of "moving from SIMULATION to REAL" (master
// prompt §4, §10-12, §30, §38). A `devices` row per machine holds the
// device-management metadata that is NOT telemetry: manufacturer/model/serial,
// firmware/IP/port/protocol/interface/gateway, the biomedical approval
// lifecycle (NOT_APPROVED → TESTING → APPROVED → ACTIVE → DISABLED), and the
// 13-point safety gate that must be fully green before a device can go ACTIVE.
//
// The *connectivity status* shown to users is DERIVED at read time from the
// approval state + the live connector snapshot, using the precise vocabulary
// §38 asks for (CONNECTED / DEGRADED / DISCONNECTED / SIMULATION / UNAUTHORIZED
// / TESTING) — never an ambiguous "Normal" / "Safe".
//
// A simulated device is a legitimate, clearly-labelled state (SIMULATION), not
// a failure — so the app keeps working with zero real hardware while making it
// unmistakable which feed is real.

const { db } = require('./db');
const models = require('./connectors/models');

const STATES = ['NOT_APPROVED', 'TESTING', 'APPROVED', 'ACTIVE', 'DISABLED'];

// §30 safety gate — all 13 must be true to reach APPROVED, and the device must
// be APPROVED with all 13 true to reach ACTIVE.
const SAFETY_CHECKS = [
  'manufacturer_verified', 'model_verified', 'interface_verified', 'protocol_verified',
  'read_only_verified', 'data_mapping_verified', 'units_verified', 'timestamp_verified',
  'alarm_mapping_verified', 'gateway_verified', 'security_reviewed', 'biomedical_approval',
  'test_completed',
];
const EMPTY_CHECKS = () => Object.fromEntries(SAFETY_CHECKS.map((k) => [k, false]));

function ensureRows(fleet) {
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO devices
    (id, manufacturer, model, serial, approval_state, data_mode, safety_checks, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'NOT_APPROVED', 'READ_ONLY', ?, ?, ?)`);
  for (const m of fleet) {
    const key = models.resolveModel(m.model);
    const vendor = (models.MODELS[key] || {}).vendor || String(m.model || '').split(' ')[0] || null;
    ins.run(m.id, vendor, m.model || null, m.serial || null, JSON.stringify(EMPTY_CHECKS()), now, now);
  }
}

function getRow(id) {
  const r = db.prepare('SELECT * FROM devices WHERE lower(id) = lower(?)').get(String(id));
  if (!r) return null;
  try { r.safety_checks = { ...EMPTY_CHECKS(), ...JSON.parse(r.safety_checks || '{}') }; }
  catch { r.safety_checks = EMPTY_CHECKS(); }
  return r;
}

/** §38 — precise, unambiguous connectivity status. `conn` = connector snapshot row, or undefined. */
function connectivityStatus(row, conn) {
  if (row.approval_state === 'DISABLED') return 'DISCONNECTED';
  if (!conn) return 'SIMULATION';                 // no live binding → simulator feed
  if (row.approval_state === 'NOT_APPROVED') return 'UNAUTHORIZED';
  if (row.approval_state === 'TESTING') return 'TESTING';
  if (!conn.connected) return 'DISCONNECTED';
  if (!conn.live) return 'DEGRADED';              // connected but data stale
  return 'CONNECTED';
}

/** §11 — data-type classification for that device's telemetry. */
function dataType(status) {
  if (status === 'CONNECTED' || status === 'DEGRADED') return 'REAL_DEVICE';
  if (status === 'SIMULATION' || status === 'TESTING') return 'SIMULATED';
  return 'UNAVAILABLE';
}

function dataQuality(status) {
  if (status === 'CONNECTED') return 'VALID';
  if (status === 'DEGRADED') return 'STALE';
  if (status === 'SIMULATION' || status === 'TESTING') return 'SIMULATED';
  return 'N/A';
}

function toDevice(m, row, conn) {
  const status = connectivityStatus(row, conn);
  const key = models.resolveModel(m.model);
  return {
    id: m.id,
    manufacturer: row.manufacturer,
    model: row.model || m.model,
    serial: row.serial || m.serial,
    firmware: row.firmware || null,
    ip: row.ip || null,
    port: row.port || null,
    protocol: row.protocol || (conn ? conn.adapter : null),
    interfaceType: row.interface_type || null,
    gatewayId: row.gateway_id || null,
    station: m.bed || null,
    location: m.room || null,
    approvalState: row.approval_state || 'NOT_APPROVED',
    dataMode: row.data_mode || 'READ_ONLY',
    connectivityStatus: status,
    dataType: dataType(status),
    dataQuality: dataQuality(status),
    lastCommunication: (conn && conn.lastReadingAt) || m.lastReadingAt || null,
    ageSec: conn ? conn.ageSec : null,
    authorizedBy: row.authorized_by || null,
    authorizedAt: row.authorized_at || null,
    safetyChecks: row.safety_checks,
    notes: row.notes || null,
    nativeProtocols: (models.MODELS[key] || {}).nativeProtocols || [],
  };
}

function listDevices(fleet, connSnapshot) {
  const byMachine = new Map((connSnapshot || []).map((c) => [c.machineId, c]));
  return fleet.map((m) => {
    const row = getRow(m.id) || { approval_state: 'NOT_APPROVED', data_mode: 'READ_ONLY', safety_checks: EMPTY_CHECKS() };
    return toDevice(m, row, byMachine.get(m.id));
  });
}

// §10 — one full provenance record per parameter.
const PARAMS = [
  { field: 'part', name: 'arterial_pressure', unit: 'mmHg' },
  { field: 'pven', name: 'venous_pressure', unit: 'mmHg' },
  { field: 'tmp', name: 'tmp', unit: 'mmHg' },
  { field: 'bfr', name: 'blood_flow_rate', unit: 'mL/min' },
  { field: 'ufr', name: 'uf_rate', unit: 'mL/h' },
  { field: 'ufv', name: 'uf_volume', unit: 'L' },
  { field: 'cond', name: 'dialysate_conductivity', unit: 'mS/cm' },
  { field: 'temp', name: 'dialysate_temp', unit: '°C' },
];
function parameters(machine, connSnapshot) {
  const dev = listDevices([machine], connSnapshot)[0];
  const now = new Date().toISOString();
  return PARAMS.map((p) => {
    const v = machine[p.field];
    const available = typeof v === 'number';
    return {
      deviceId: machine.id,
      parameter: p.name,
      value: available ? v : null,
      unit: p.unit,
      timestamp: dev.lastCommunication || now,
      source: available ? dev.dataType : 'UNAVAILABLE',
      protocol: dev.protocol || null,
      gateway: dev.gatewayId || null,
      quality: available ? dev.dataQuality : 'UNAVAILABLE',
      mode: dev.dataMode,
      note: available ? null : 'Not provided by device interface',
    };
  });
}

function updateDevice(id, patch, actor) {
  const row = getRow(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const next = {
    firmware: row.firmware, ip: row.ip, port: row.port, protocol: row.protocol,
    interface_type: row.interface_type, gateway_id: row.gateway_id, notes: row.notes,
    approval_state: row.approval_state, safety_checks: { ...row.safety_checks },
    authorized_by: row.authorized_by, authorized_at: row.authorized_at,
  };

  for (const k of ['firmware', 'ip', 'port', 'protocol', 'notes']) {
    if (patch[k] !== undefined) next[k] = patch[k] === '' ? null : patch[k];
  }
  if (patch.interfaceType !== undefined) next.interface_type = patch.interfaceType || null;
  if (patch.gatewayId !== undefined) next.gateway_id = patch.gatewayId || null;
  if (patch.safetyChecks && typeof patch.safetyChecks === 'object') {
    for (const k of SAFETY_CHECKS) if (k in patch.safetyChecks) next.safety_checks[k] = !!patch.safetyChecks[k];
  }

  if (patch.approvalState !== undefined) {
    const target = String(patch.approvalState);
    if (!STATES.includes(target)) return { error: `État invalide : ${target}` };
    const allGreen = SAFETY_CHECKS.every((k) => next.safety_checks[k] === true);
    if (target === 'APPROVED' && !allGreen) {
      return { error: 'Passage à APPROVED refusé : les 13 contrôles de sécurité doivent tous être validés.' };
    }
    if (target === 'ACTIVE' && !(next.approval_state === 'APPROVED' && allGreen)) {
      return { error: "Passage à ACTIVE refusé : l'appareil doit être APPROVED avec les 13 contrôles validés." };
    }
    next.approval_state = target;
    if (target === 'ACTIVE') { next.authorized_by = actor; next.authorized_at = now; }
  }

  db.prepare(`UPDATE devices SET firmware=?, ip=?, port=?, protocol=?, interface_type=?, gateway_id=?,
    notes=?, approval_state=?, safety_checks=?, authorized_by=?, authorized_at=?, updated_at=? WHERE lower(id)=lower(?)`)
    .run(next.firmware, next.ip, next.port, next.protocol, next.interface_type, next.gateway_id,
      next.notes, next.approval_state, JSON.stringify(next.safety_checks),
      next.authorized_by, next.authorized_at, now, String(id));
  return getRow(id);
}

/** §12 — global LIVE / SIMULATION / MIXED. */
function globalMode(fleet, connSnapshot) {
  const devs = listDevices(fleet, connSnapshot);
  const real = devs.some((d) => d.dataType === 'REAL_DEVICE');
  const sim = devs.some((d) => d.dataType === 'SIMULATED');
  if (real && sim) return 'MIXED';
  if (real) return 'LIVE';
  return 'SIMULATION';
}

module.exports = {
  STATES, SAFETY_CHECKS,
  ensureRows, getRow, listDevices, parameters, updateDevice, globalMode, connectivityStatus,
};
