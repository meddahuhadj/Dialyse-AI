'use strict';

const { EventEmitter } = require('node:events');

/**
 * Base class for every protocol adapter.
 *
 * A subclass connects to ONE data source for ONE machine and, whenever it has a
 * fresh sample, calls `this._reading({ rawKey: value, ... }, alarms?)`.
 * The ConnectorManager translates those raw keys via `connectors/models.js`.
 *
 * Events:
 *   'reading' → { machineId, model, signals, alarms, ts }
 *   'status'  → { machineId, connected, error }
 */
class BaseAdapter extends EventEmitter {
  constructor(binding) {
    super();
    this.binding = binding;                 // { machineId, model, adapter, params }
    this.machineId = binding.machineId;
    this.model = binding.model;
    this.params = binding.params || {};
    this.type = binding.adapter;
    this.connected = false;
    this.lastReadingAt = null;
    this.lastError = null;
  }

  /* eslint-disable class-methods-use-this */
  async start() { throw new Error(`${this.constructor.name}.start() non implémenté`); }
  async stop() {}
  /* eslint-enable class-methods-use-this */

  _reading(signals, alarms) {
    this.lastReadingAt = new Date();
    if (!this.connected) this._connected(true);
    this.emit('reading', {
      machineId: this.machineId,
      model: this.model,
      signals: signals || {},
      alarms: alarms || [],
      ts: this.lastReadingAt.toISOString(),
    });
  }

  _connected(v, err) {
    this.connected = !!v;
    this.lastError = err ? String(err && err.message ? err.message : err) : null;
    this.emit('status', { machineId: this.machineId, connected: this.connected, error: this.lastError });
  }

  _fail(err) {
    this._connected(false, err);
  }
}

/**
 * Parse one line/frame of an ASCII protocol into { key: value } pairs.
 * Shared by the serial and tcp-ascii adapters.
 *
 *   format 'kv'   → "QB=300;PV=180;TMP=90"        (pairDelim / kvDelim configurable)
 *   format 'csv'  → "300,180,90"  + params.columns: ['QB','PV','TMP']
 *   format 'json' → {"QB":300,"PV":180}
 */
function parseFrame(line, params = {}) {
  const raw = String(line).trim();
  if (!raw) return null;
  const fmt = params.format || 'kv';

  if (fmt === 'json') {
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : null;
    } catch { return null; }
  }

  if (fmt === 'csv') {
    const cols = params.columns || [];
    if (!cols.length) return null;
    const parts = raw.split(params.pairDelim || ',');
    const out = {};
    cols.forEach((c, i) => { if (parts[i] !== undefined) out[c] = parts[i].trim(); });
    return out;
  }

  // kv
  const pairDelim = params.pairDelim || ';';
  const kvDelim = params.kvDelim || '=';
  const out = {};
  for (const chunk of raw.split(pairDelim)) {
    const idx = chunk.indexOf(kvDelim);
    if (idx === -1) continue;
    const k = chunk.slice(0, idx).trim();
    const v = chunk.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Split "{signals, alarms}" out of a parsed frame using alarm-ish key names. */
function splitAlarms(obj, params = {}) {
  const alarmKeys = new Set((params.alarmKeys || ['alarm', 'alarm_text', 'alarmtext', 'alarm_code', 'alarmcode', 'errorcode'])
    .map((k) => k.toLowerCase()));
  const signals = {};
  const alarms = [];
  for (const [k, v] of Object.entries(obj)) {
    if (alarmKeys.has(k.toLowerCase())) {
      if (v && String(v).trim() && !/^(0|none|ok|no)$/i.test(String(v).trim())) {
        alarms.push({ code: /code/i.test(k) ? String(v) : undefined, text: /code/i.test(k) ? undefined : String(v), priority: params.alarmPriority || 'HIGH' });
      }
    } else {
      signals[k] = v;
    }
  }
  return { signals, alarms };
}

module.exports = { BaseAdapter, parseFrame, splitAlarms };
