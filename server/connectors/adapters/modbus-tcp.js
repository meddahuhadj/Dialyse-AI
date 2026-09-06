'use strict';

const { BaseAdapter } = require('../base');

/**
 * modbus-tcp — polls Modbus holding/input registers.
 *
 * Used by: B. Braun Dialog iQ (some service configs), building-management / IoT
 * gateways in front of dialysis machines, water-treatment loops.
 *
 * Requires the optional `modbus-serial` package:  npm i modbus-serial
 *
 * params:
 *   host, port(=502), unitId(=1)
 *   periodMs   : poll interval (default 3000)
 *   registers  : { <canonicalOrRawKey>: { addr, type:'holding'|'input', count?:1,
 *                  scale?:1, offset?:0, signed?:false } }
 *   alarmRegister : { addr, type, nonZeroMeansAlarm:true }  (optional)
 */
class ModbusTcpAdapter extends BaseAdapter {
  async start() {
    if (!this.params.host) throw new Error('params.host requis');
    if (!this.params.registers || !Object.keys(this.params.registers).length) {
      throw new Error('params.registers requis');
    }
    let ModbusRTU;
    try { ModbusRTU = require('modbus-serial'); }
    catch { throw new Error('paquet "modbus-serial" non installé — exécuter: npm i modbus-serial'); }

    this.client = new ModbusRTU();
    await this.client.connectTCP(this.params.host, { port: Number(this.params.port || 502) });
    this.client.setID(Number(this.params.unitId || 1));
    this.client.setTimeout(2000);
    this._connected(true);
    console.log(`[modbus-tcp] ${this.machineId} → ${this.params.host}:${this.params.port || 502} unit ${this.params.unitId || 1}`);

    this.periodMs = Number(this.params.periodMs || 3000);
    this._timer = setInterval(() => this._poll().catch((e) => this._fail(e)), this.periodMs);
    this._timer.unref();
    await this._poll();
  }

  async _read(spec) {
    const count = spec.count || 1;
    const r = spec.type === 'input'
      ? await this.client.readInputRegisters(spec.addr, count)
      : await this.client.readHoldingRegisters(spec.addr, count);
    let v = r.data[0];
    if (spec.signed && v > 0x7fff) v -= 0x10000;
    return v * (spec.scale ?? 1) + (spec.offset ?? 0);
  }

  async _poll() {
    const signals = {};
    for (const [key, spec] of Object.entries(this.params.registers)) {
      try { signals[key] = await this._read(spec); } catch { /* skip this register */ }
    }
    const alarms = [];
    if (this.params.alarmRegister) {
      try {
        const v = await this._read(this.params.alarmRegister);
        if (v) alarms.push({ code: `MODBUS-${this.params.alarmRegister.addr}`, text: `Registre alarme = ${v}`, priority: 'HIGH' });
      } catch { /* ignore */ }
    }
    if (Object.keys(signals).length || alarms.length) this._reading(signals, alarms);
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    try { this.client && this.client.close(() => {}); } catch {}
    this._connected(false);
  }
}

module.exports = ModbusTcpAdapter;
