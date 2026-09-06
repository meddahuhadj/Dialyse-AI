'use strict';

const { BaseAdapter, parseFrame, splitAlarms } = require('../base');

/**
 * serial — RS-232 / USB-serial ASCII stream.
 *
 * Used by: Nipro Surdial, Nikkiso DBB, Gambro AK, Toray TR-8000, Fresenius
 * 4008/5008 service port, and any machine exposing a serial telemetry frame.
 *
 * Requires the optional `serialport` package:  npm i serialport
 *
 * params:
 *   path         : COM3 (Windows) | /dev/ttyUSB0 (Linux)
 *   baudRate     : default 9600
 *   dataBits, stopBits, parity : standard serialport options
 *   delimiter    : frame delimiter (default "\r\n")
 *   format       : 'kv' (default) | 'csv' | 'json'
 *   pairDelim, kvDelim, columns, alarmKeys : parsing options
 */
class SerialAdapter extends BaseAdapter {
  async start() {
    if (!this.params.path) throw new Error('params.path requis (ex: COM5 ou /dev/ttyUSB0)');

    let SerialPort;
    let ReadlineParser;
    try {
      ({ SerialPort } = require('serialport'));
      ({ ReadlineParser } = require('@serialport/parser-readline'));
    } catch {
      throw new Error('paquet "serialport" non installé — exécuter: npm i serialport');
    }

    this._port = new SerialPort({
      path: this.params.path,
      baudRate: Number(this.params.baudRate || 9600),
      dataBits: Number(this.params.dataBits || 8),
      stopBits: Number(this.params.stopBits || 1),
      parity: this.params.parity || 'none',
      autoOpen: false,
    });

    const parser = this._port.pipe(new ReadlineParser({ delimiter: this.params.delimiter || '\r\n' }));
    parser.on('data', (line) => {
      const obj = parseFrame(line, this.params);
      if (!obj) return;
      const { signals, alarms } = splitAlarms(obj, this.params);
      this._reading(signals, alarms);
    });
    this._port.on('error', (e) => this._fail(e));
    this._port.on('close', () => this._connected(false));

    await new Promise((resolve, reject) => {
      this._port.open((err) => (err ? reject(err) : resolve()));
    });
    this._connected(true);
    console.log(`[serial] ${this.machineId} ← ${this.params.path} @ ${this.params.baudRate || 9600}`);
  }

  async stop() {
    try { this._port && this._port.isOpen && this._port.close(); } catch {}
    this._connected(false);
  }
}

module.exports = SerialAdapter;
