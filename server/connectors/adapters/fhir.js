'use strict';

const { BaseAdapter } = require('../base');

/**
 * fhir — polls an HL7 FHIR R4 server for the latest Observations of one device.
 *
 * Used by: interoperability middleware / hospital integration engines that expose
 * dialysis telemetry as FHIR (Fresenius Nexadia Expert, vendor-neutral gateways).
 *
 * params:
 *   baseUrl        : FHIR base, e.g. https://fhir.chu-medical.fr/r4
 *   deviceId       : Device resource id  → Observation?device=Device/<id>
 *   patientId      : alternative selector → Observation?subject=Patient/<id>
 *   periodMs       : poll interval (default 5000)
 *   count          : Observations to pull per poll (default 25)
 *   token          : optional Bearer token
 *
 * Mapping: Observation.code.coding[].code (LOINC) → raw signal key ;
 *          valueQuantity.value → value. Device.status !== 'active' → alarm/offline.
 */
class FhirAdapter extends BaseAdapter {
  async start() {
    if (!this.params.baseUrl) throw new Error('params.baseUrl requis');
    this.base = this.params.baseUrl.replace(/\/$/, '');
    this.periodMs = Number(this.params.periodMs || 5000);
    this.count = Number(this.params.count || 25);
    this.headers = { accept: 'application/fhir+json' };
    if (this.params.token) this.headers.authorization = `Bearer ${this.params.token}`;
    this._timer = setInterval(() => this._poll().catch((e) => this._fail(e)), this.periodMs);
    this._timer.unref();
    await this._poll();
  }

  async _poll() {
    const sel = this.params.deviceId
      ? `device=Device/${encodeURIComponent(this.params.deviceId)}`
      : `subject=Patient/${encodeURIComponent(this.params.patientId || '')}`;
    const url = `${this.base}/Observation?${sel}&_sort=-date&_count=${this.count}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`FHIR HTTP ${res.status}`);
    const bundle = await res.json();

    const signals = {};
    for (const entry of bundle.entry || []) {
      const o = entry.resource || {};
      if (o.resourceType !== 'Observation') continue;
      const codes = (o.code && o.code.coding) || [];
      const key = (codes.find((c) => c.system && c.system.includes('loinc')) || codes[0] || {}).code
        || (o.code && o.code.text);
      const value = o.valueQuantity && o.valueQuantity.value;
      if (key && value !== undefined && !(key in signals)) signals[key] = value; // newest wins (sorted -date)
    }

    const alarms = [];
    if (this.params.deviceId) {
      try {
        const dRes = await fetch(`${this.base}/Device/${encodeURIComponent(this.params.deviceId)}`, { headers: this.headers });
        if (dRes.ok) {
          const dev = await dRes.json();
          if (dev.status && dev.status !== 'active') {
            alarms.push({ text: `Device FHIR status=${dev.status}`, code: 'FHIR-DEVICE', priority: 'HIGH' });
          }
        }
      } catch { /* device fetch optional */ }
    }

    if (Object.keys(signals).length || alarms.length) this._reading(signals, alarms);
    else if (!this.connected) this._connected(true);
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    this._connected(false);
  }
}

module.exports = FhirAdapter;
