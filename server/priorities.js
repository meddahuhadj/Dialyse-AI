'use strict';

// "À REGARDER MAINTENANT" — pilotage par exception.
//
// The app already computes a lot of intelligence in isolation (alarm cascade
// clusters, repeated-drift maintenance tickets, device connectivity, machine
// status). A nurse-in-charge doesn't want five tabs — they want one answer:
// "which handful of patients / machines / events need me right now?".
//
// This module aggregates the existing server-side signals into ONE ranked
// list. Nothing new is measured; it's a join + rank over what's already there.
// (Client-side IDH triage risk is merged in by the front-end, since that logic
// lives there.)

const SEVERITY_RANK = { critical: 0, high: 1, moderate: 2 };

/**
 * @param fleet       the in-memory fleet array
 * @param clusters    output of alarmClustering.detectClusters()
 * @param tickets     output of maintenance.listTickets() (all)
 * @param deviceList  output of devices.listDevices(fleet, snapshot)
 */
function computePriorities(fleet, { clusters = [], tickets = [], deviceList = [] } = {}) {
  const items = [];
  const clinicalCovered = new Set(); // machineId already has a clinical item

  // 1. Alarm cascade clusters — most informative clinical signal.
  for (const c of clusters) {
    clinicalCovered.add(c.machineId);
    items.push({
      id: `cluster:${c.machineId}`,
      kind: 'alarm-cascade',
      severity: 'critical',
      machineId: c.machineId,
      title: `${c.machineId} — ${c.hypothesis}`,
      detail: `${c.count} alarmes corrélées : ${c.types.join(' · ')}`,
      since: c.windowEnd || null,
      goto: 'alarmIntelligence',
    });
  }

  // 2. Machines in ALARM without a cluster.
  for (const m of fleet) {
    if (m.status !== 'ALARM' || clinicalCovered.has(m.id)) continue;
    clinicalCovered.add(m.id);
    items.push({
      id: `alarm:${m.id}`,
      kind: 'machine-alarm',
      severity: 'critical',
      machineId: m.id,
      title: `${m.id} — ${(m.currentAlarm && m.currentAlarm.type) || 'Alarme active'}`,
      detail: (m.currentAlarm && m.currentAlarm.priority) ? `Priorité ${m.currentAlarm.priority}` : 'Alarme générateur active',
      since: (m.currentAlarm && m.currentAlarm.timestamp) || null,
      goto: 'alarmIntelligence',
    });
  }

  // 3. Machines under monitoring / with a trend warning.
  for (const m of fleet) {
    if (clinicalCovered.has(m.id)) continue;
    if (m.status !== 'MONITORING' && m.status !== 'WARNING' && !m.trendWarning) continue;
    clinicalCovered.add(m.id);
    items.push({
      id: `trend:${m.id}`,
      kind: 'machine-trend',
      severity: 'moderate',
      machineId: m.id,
      title: `${m.id} — ${m.trendWarning || 'Sous surveillance'}`,
      detail: 'Surveillance prédictive continue — vérifier la tendance',
      since: null,
      goto: 'digitalTwin',
    });
  }

  // 4. Open auto maintenance tickets (repeated drift).
  for (const tk of tickets) {
    if (tk.status === 'RESOLU') continue;
    if (tk.source !== 'auto') continue; // manual tickets are already someone's job
    items.push({
      id: `ticket:${tk.id}`,
      kind: 'maintenance-drift',
      severity: tk.priority === 'HIGH' ? 'high' : 'moderate',
      machineId: tk.machine_id,
      title: `${tk.machine_id} — ${tk.title}`,
      detail: tk.detail || 'Ticket de maintenance ouvert automatiquement',
      since: tk.created_at || null,
      goto: 'predictiveMaintenance',
    });
  }

  // 5. Devices needing biomedical attention (connectivity, authorization).
  for (const d of deviceList) {
    const s = d.connectivityStatus;
    if (!['DISCONNECTED', 'DEGRADED', 'UNAUTHORIZED'].includes(s)) continue;
    items.push({
      id: `device:${d.id}`,
      kind: 'device-connectivity',
      severity: s === 'DISCONNECTED' ? 'high' : 'moderate',
      machineId: d.id,
      title: `${d.id} — ${s === 'DISCONNECTED' ? 'communication appareil perdue' : s === 'DEGRADED' ? 'données appareil obsolètes' : 'appareil non autorisé'}`,
      detail: `${d.manufacturer || ''} ${d.model || ''} · ${d.protocol || 'protocole ?'} · gateway ${d.gatewayId || '?'}`,
      since: d.lastCommunication || null,
      goto: 'deviceCenter',
    });
  }

  items.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return String(b.since || '').localeCompare(String(a.since || ''));
  });

  const counts = { critical: 0, high: 0, moderate: 0 };
  for (const it of items) counts[it.severity]++;

  return { generatedAt: new Date().toISOString(), counts, items: items.slice(0, 10) };
}

module.exports = { computePriorities };
