'use strict';

const net = require('node:net');
const { BaseAdapter } = require('../base');

/**
 * hl7v2 — receives HL7 v2 ORU^R01 result messages over MLLP (TCP).
 *
 * Used by: Fresenius (Nexadia / TDMS), B. Braun (Nexadia / DASH), and any
 * middleware that exports observations as HL7 v2. Typically ONE port receives the
 * whole fleet; bindings sharing a port are fanned out by `deviceMatch`.
 *
 * params:
 *   port        : TCP port to listen on (default 2575)
 *   host        : bind address (default 0.0.0.0)
 *   deviceMatch : substring identifying this machine in MSH/OBR (e.g. "HD-06",
 *                 a serial number, or an AE title). Omit if the port is dedicated.
 *   ack         : send an HL7 ACK (default true)
 *
 * OBX mapping: OBX-3 (identifier^text) → raw signal key ; OBX-5 → value ;
 * OBX-8 abnormal flags H/HH/A/AA raise an alarm. PID-3 → patientId.
 */

const VT = 0x0b, FS = 0x1c, CR = 0x0d;

// One net.Server per port, shared by every hl7v2 binding on that port.
const servers = new Map(); // port -> { server, handlers:Set<fn(msgObj,rawSegs)->bool> }

function getServer(port, host) {
  let entry = servers.get(port);
  if (entry) return entry;

  const handlers = new Set();
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let start;
      while ((start = buf.indexOf(VT)) !== -1) {
        const end = buf.indexOf(FS, start + 1);
        if (end === -1) break;
        const body = buf.slice(start + 1, end).toString('utf8');
        buf = buf.slice(end + 2); // skip FS + CR
        const segs = body.split(/\r\n|\r|\n/).filter(Boolean).map((l) => l.split('|'));
        let consumed = false;
        for (const h of handlers) { try { if (h(segs)) consumed = true; } catch { /* ignore */ } }
        // ACK (AA) regardless — the message was well-formed
        const msh = segs.find((s) => s[0] === 'MSH') || [];
        const ctrlId = msh[9] || String(Date.now());
        const ack = `MSH|^~\\&|HADJ|HADJ|${msh[2] || ''}|${msh[3] || ''}|${new Date().toISOString()}||ACK|${ctrlId}|P|2.5\rMSA|${consumed ? 'AA' : 'AR'}|${ctrlId}\r`;
        sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(ack, 'utf8'), Buffer.from([FS, CR])]));
      }
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => { entry && entry.handlers.forEach((h) => h.__onServerError && h.__onServerError(e)); });
  server.listen(port, host || '0.0.0.0');
  entry = { server, handlers };
  servers.set(port, entry);
  return entry;
}

class Hl7v2Adapter extends BaseAdapter {
  async start() {
    const port = Number(this.params.port || 2575);
    const match = this.params.deviceMatch ? String(this.params.deviceMatch).toLowerCase() : null;

    this._handler = (segs) => {
      const raw = segs.map((s) => s.join('|')).join('\r').toLowerCase();
      if (match && !raw.includes(match)) return false;

      const signals = {};
      const alarms = [];
      let patientId;
      for (const s of segs) {
        if (s[0] === 'PID') {
          const pid3 = (s[3] || '').split('^')[0];
          if (pid3) patientId = pid3;
        }
        if (s[0] === 'OBX') {
          const idField = s[3] || '';
          const [code, text] = idField.split('^');
          const key = code || text;
          const value = s[5];
          const flag = (s[8] || '').toUpperCase();
          if (!key) continue;
          if (/^alarm|^alm/i.test(key) || /alarm/i.test(text || '')) {
            if (value && !/^(0|none|ok)$/i.test(value)) alarms.push({ text: value, code: code, priority: flag.includes('HH') || flag.includes('AA') ? 'CRITICAL' : 'HIGH' });
          } else {
            signals[key] = value;
            if (['H', 'HH', 'A', 'AA'].includes(flag)) {
              alarms.push({ text: `${text || key} hors limites (${value})`, code: `OBX-${code}`, priority: flag.length === 2 ? 'CRITICAL' : 'HIGH' });
            }
          }
        }
      }
      if (patientId) signals.PID = patientId;
      if (Object.keys(signals).length || alarms.length) this._reading(signals, alarms);
      return true;
    };
    this._handler.__onServerError = (e) => this._fail(e);

    this._entry = getServer(port, this.params.host);
    this._entry.handlers.add(this._handler);
    this._connected(true);
    console.log(`[hl7v2] ${this.machineId} ← MLLP :${port}${match ? ` (match "${this.params.deviceMatch}")` : ''}`);
  }

  async stop() {
    if (this._entry && this._handler) {
      this._entry.handlers.delete(this._handler);
      const port = Number(this.params.port || 2575);
      if (this._entry.handlers.size === 0) {
        try { this._entry.server.close(); } catch {}
        servers.delete(port);
      }
    }
    this._connected(false);
  }
}

module.exports = Hl7v2Adapter;
