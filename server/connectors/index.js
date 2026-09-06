'use strict';

const fs = require('node:fs');
const path = require('node:path');
const registry = require('./registry');
const { mapReading, resolveModel, MODELS } = require('./models');

/**
 * ConnectorManager
 *
 * Owns the live data plane. It:
 *   - gives EVERY machine a `simulator` adapter (so /api/fleet is always complete),
 *   - additionally starts the real adapter for each binding in the config,
 *   - merges adapter readings into the shared in-memory fleet array (Phase 1 schema),
 *   - lets a live source take priority: simulator readings are ignored while a
 *     real adapter for that machine produced something within `staleMs`.
 *
 * Config file (JSON), searched in order:
 *   $HADJ_CONNECTORS  →  server/connectors/connectors.config.json  →  .example.json
 *
 *   {
 *     "defaultSimulator": true,      // simulator fallback for every machine
 *     "staleMs": 15000,              // live source considered stale after this
 *     "bindings": [
 *       { "machineId":"HD-06", "model":"Nipro Surdial X",
 *         "adapter":"hl7v2", "params": { "port":2575, "deviceMatch":"HD-06" } }
 *     ]
 *   }
 */
class ConnectorManager {
  constructor(fleet, opts = {}) {
    this.fleet = fleet;
    this.byId = new Map(fleet.map((m) => [m.id, m]));
    this.configPath = opts.configPath
      || process.env.HADJ_CONNECTORS
      || path.join(__dirname, 'connectors.config.json');
    this.adapters = [];           // { adapter, binding, isSim }
    this.status = new Map();      // machineId -> status record
    this.staleMs = 15000;
  }

  _loadConfig() {
    // Only a real connectors.config.json activates live sources. Absent it, HADJ
    // runs fully simulated (clean boot). The .example.json is a template, never
    // auto-loaded.
    let cfg = { defaultSimulator: true, bindings: [] };
    try {
      cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      console.log(`[connectors] config: ${path.basename(this.configPath)}`);
    } catch {
      console.log('[connectors] pas de connectors.config.json → mode simulé intégral');
    }
    if (typeof cfg.staleMs === 'number') this.staleMs = cfg.staleMs;
    return cfg;
  }

  async start() {
    const cfg = this._loadConfig();
    const bindings = Array.isArray(cfg.bindings) ? cfg.bindings.slice() : [];
    const bound = new Set(bindings.map((b) => b.machineId));

    // simulator for every machine unless explicitly disabled
    if (cfg.defaultSimulator !== false) {
      for (const m of this.fleet) {
        bindings.push({ machineId: m.id, model: m.model, adapter: 'simulator', params: {}, __sim: true });
      }
    }

    for (const b of bindings) {
      const m = this.byId.get(b.machineId);
      if (!m) { console.warn(`[connectors] machine inconnue: ${b.machineId}`); continue; }
      b.model = b.model || m.model;
      b.params = b.params || {};
      const isSim = b.adapter === 'simulator';
      if (isSim) b.params = { seed: { ...m }, ...b.params };

      const Cls = registry[b.adapter];
      if (!Cls) { console.warn(`[connectors] adaptateur inconnu "${b.adapter}" (${b.machineId})`); continue; }

      if (!isSim) {
        this.status.set(b.machineId, {
          machineId: b.machineId, adapter: b.adapter,
          model: resolveModel(b.model), modelLabel: (MODELS[resolveModel(b.model)] || {}).label,
          connected: false, live: false, lastReadingAt: null, lastError: null,
        });
      }

      const adapter = new Cls(b);
      adapter.on('reading', (r) => this._onReading(r, isSim));
      adapter.on('status', (s) => this._onStatus(s, b, isSim));
      this.adapters.push({ adapter, binding: b, isSim });

      try {
        await adapter.start();
      } catch (e) {
        if (!isSim) {
          console.warn(`[connectors] ${b.machineId}/${b.adapter} KO: ${e.message} — repli simulateur`);
          this._onStatus({ connected: false, error: e.message }, b, false);
        }
      }
    }

    const real = this.adapters.filter((a) => !a.isSim).length;
    console.log(`[connectors] ${this.adapters.length} adaptateur(s) — dont ${real} source(s) live, ${this.adapters.length - real} simulateur(s)`);
  }

  _onReading(r, isSim) {
    const m = this.byId.get(r.machineId);
    if (!m) return;

    if (isSim) {
      const st = this.status.get(r.machineId);
      const liveFresh = st && st.lastReadingAt && (Date.now() - new Date(st.lastReadingAt).getTime() < this.staleMs);
      if (liveFresh) return; // a real source is driving this machine
    }

    const { modelKey, patch } = mapReading(r.model, r);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      m[k] = v; // includes explicit null (clears a stale currentAlarm)
    }
    m.dataSource = isSim ? 'simulator' : (this.status.get(r.machineId) || {}).adapter || 'live';
    m.lastReadingAt = r.ts;

    if (!isSim) {
      const st = this.status.get(r.machineId);
      if (st) { st.connected = true; st.live = true; st.lastReadingAt = r.ts; st.model = modelKey; st.lastError = null; }
    }
  }

  _onStatus(s, b, isSim) {
    if (isSim) return;
    const st = this.status.get(b.machineId) || { machineId: b.machineId, adapter: b.adapter };
    st.connected = !!s.connected;
    if (!s.connected) st.live = false;
    if (s.error) st.lastError = s.error;
    this.status.set(b.machineId, st);
  }

  /** For GET /api/connectors — one row per machine that has a real binding. */
  snapshot() {
    const now = Date.now();
    return [...this.status.values()].map((s) => ({
      ...s,
      live: !!(s.lastReadingAt && now - new Date(s.lastReadingAt).getTime() < this.staleMs),
      ageSec: s.lastReadingAt ? Math.round((now - new Date(s.lastReadingAt).getTime()) / 1000) : null,
    }));
  }

  /** Static catalogue for docs / the DPI tab. */
  static catalogue() {
    return {
      adapters: Object.keys(registry),
      models: Object.entries(MODELS).map(([key, d]) => ({
        key, vendor: d.vendor, label: d.label,
        nativeProtocols: d.nativeProtocols, recommendedAdapter: d.adapter,
      })),
    };
  }

  async stop() {
    for (const { adapter } of this.adapters) {
      try { await adapter.stop(); } catch { /* ignore */ }
    }
    this.adapters = [];
  }

  /** Re-read the config and restart every adapter (used after the wizard writes a binding). */
  async reload() {
    await this.stop();
    this.status = new Map();
    await this.start();
  }
}

/**
 * Really try one binding: instantiate its adapter, start it, wait up to
 * `timeoutMs` for a reading / connected status / error, then stop. Honest —
 * missing optional deps (serialport, modbus-serial, node-opcua) surface as a
 * real "module non installé" failure, not a fake success.
 */
async function testBinding(binding, timeoutMs = 8000) {
  const Cls = registry[binding.adapter];
  if (!Cls) return { ok: false, stage: 'adapter', detail: `Adaptateur inconnu : ${binding.adapter}` };

  let adapter;
  try { adapter = new Cls({ ...binding, params: binding.params || {} }); }
  catch (e) { return { ok: false, stage: 'init', detail: e.message }; }

  return await new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return; done = true;
      clearTimeout(timer);
      Promise.resolve().then(() => adapter.stop()).catch(() => {}).finally(() => resolve(r));
    };
    const timer = setTimeout(() => finish({ ok: false, stage: 'timeout', detail: `Aucune donnée ni connexion en ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);

    adapter.on('reading', (r) => finish({ ok: true, stage: 'reading', detail: 'Lecture reçue de la source', sampleSignals: Object.keys(r.signals || {}).slice(0, 12) }));
    adapter.on('status', (s) => { if (s.connected) finish({ ok: true, stage: 'connected', detail: 'Connexion établie (en attente de données)' }); });
    adapter.on('error', (e) => finish({ ok: false, stage: 'error', detail: (e && e.message) || String(e) }));

    Promise.resolve().then(() => adapter.start()).catch((e) => finish({ ok: false, stage: 'start', detail: e.message }));
  });
}

module.exports = { ConnectorManager, testBinding };
