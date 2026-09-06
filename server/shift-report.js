'use strict';

// End-of-shift report — the "SHIFT SUMMARY" several reviews asked for, now
// that the pieces exist: session archive, alarms table, maintenance tickets,
// alarm clusters, fleet analytics, device connectivity. Structured + a
// ready-to-copy French narrative for the oral/written handover.
//
// Read-only aggregation; the outgoing team still owns the handover.

const { db } = require('./db');

function buildShiftReport(fleet, deps, opts = {}) {
  const { sessions, maintenance, alarmClustering, fleetAnalytics, devices, connectorsSnapshot } = deps;
  const hours = Math.min(Math.max(Number(opts.hours) || 8, 1), 24);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  // --- Sessions ---
  const allSessions = sessions.listSessions({ limit: 500 });
  const shiftSessions = allSessions.filter((s) => s.ended_at >= since);
  const completed = shiftSessions.filter((s) => s.status !== 'aborted');
  const aborted = shiftSessions.filter((s) => s.status === 'aborted');
  const active = fleet.filter((m) => m.sessionActive).length;
  const unvalidated = completed.filter((s) => !s.validated_by);
  const ufShort = completed.filter((s) => s.target_ufv && s.delivered_ufv != null && (s.delivered_ufv / s.target_ufv) < 0.9);

  // --- Alarms in the window (real-time-logged rows carry created_at) ---
  const alarmRows = db.prepare(
    `SELECT machine_id, type, status, created_at FROM alarms
     WHERE created_at IS NOT NULL AND created_at >= ? AND type IS NOT NULL AND type != ''`
  ).all(since);
  const alarmActiveNow = fleet.filter((m) => m.status === 'ALARM').map((m) => m.id);
  const alarmsResolved = alarmRows.filter((r) => !alarmActiveNow.includes(r.machine_id)).length;

  // --- Technical events ---
  const deviceList = devices.listDevices(fleet, connectorsSnapshot);
  const connIssues = deviceList.filter((d) => ['DEGRADED', 'DISCONNECTED', 'UNAUTHORIZED'].includes(d.connectivityStatus));
  const clusters = alarmClustering.detectClusters();
  const patterns = fleetAnalytics.detectPatterns(fleet, deviceList).patterns;

  // --- Maintenance ---
  const tickets = maintenance.listTickets();
  const openTickets = tickets.filter((tk) => tk.status !== 'RESOLU');

  const structured = {
    shiftWindowHours: hours,
    since,
    generatedAt: new Date().toISOString(),
    activity: {
      sessionsCompleted: completed.length,
      sessionsActive: active,
      sessionsAborted: aborted.length,
    },
    alarms: {
      total: alarmRows.length,
      resolved: alarmsResolved,
      stillActive: alarmActiveNow.length,
      activeMachines: alarmActiveNow,
    },
    review: {
      unvalidatedSessions: unvalidated.map((s) => s.session_ref),
      ufShortSessions: ufShort.map((s) => ({ ref: s.session_ref, deliveredPct: Math.round((s.delivered_ufv / s.target_ufv) * 100) })),
    },
    technical: {
      connectivityIssues: connIssues.map((d) => `${d.id} (${d.connectivityStatus})`),
      clusters: clusters.map((c) => `${c.machineId} — ${c.hypothesis}`),
      fleetPatterns: patterns.map((p) => p.insight),
    },
    maintenance: {
      openTickets: openTickets.length,
      tickets: openTickets.map((tk) => `${tk.machine_id} — ${tk.title} (${tk.source})`),
    },
  };

  // --- Narrative ---
  const L = [];
  L.push(`RAPPORT DE RELÈVE — ${hours} DERNIÈRES HEURES`);
  L.push(`Horodatage : ${structured.generatedAt.replace('T', ' ').substring(0, 16)}`);
  L.push('');
  L.push('1. ACTIVITÉ');
  L.push(`   • Séances terminées sur le poste : ${completed.length}`);
  L.push(`   • Séances encore en cours        : ${active}`);
  L.push(`   • Séances interrompues           : ${aborted.length}`);
  L.push('');
  L.push('2. ALARMES');
  L.push(`   • Alarmes sur le poste : ${alarmRows.length}   (résolues : ${alarmsResolved}   |   encore actives : ${alarmActiveNow.length})`);
  if (alarmActiveNow.length) L.push(`   • Machines en alarme maintenant : ${alarmActiveNow.join(', ')}`);
  clusters.forEach((c) => L.push(`   • ⚠️ ${c.machineId} — ${c.hypothesis} (alarmes en cascade)`));
  L.push('');
  L.push('3. À REVOIR PAR LE POSTE SUIVANT');
  if (!unvalidated.length && !ufShort.length) {
    L.push('   • Rien à signaler');
  } else {
    unvalidated.forEach((s) => L.push(`   • Séance ${s.session_ref} — résumé non encore relu/validé`));
    ufShort.forEach((s) => L.push(`   • Séance ${s.session_ref} — objectif UF atteint à ${Math.round((s.delivered_ufv / s.target_ufv) * 100)} %`));
  }
  L.push('');
  L.push('4. ÉVÉNEMENTS TECHNIQUES / BIOMÉDICAL');
  if (!connIssues.length && !patterns.length && !openTickets.length) {
    L.push('   • Aucun');
  } else {
    connIssues.forEach((d) => L.push(`   • Connectivité : ${d.id} — ${d.connectivityStatus}`));
    patterns.forEach((p) => L.push(`   • Motif parc : ${p.insight}`));
    openTickets.forEach((tk) => L.push(`   • Ticket maintenance ouvert : ${tk.machine_id} — ${tk.title}`));
  }
  L.push('');
  L.push('— Rapport généré automatiquement par HADJ AI • aide à la décision, lecture seule.');

  structured.narrative = L.join('\n');
  return structured;
}

module.exports = { buildShiftReport };
