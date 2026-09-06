'use strict';

const net = require('node:net');
const { BaseAdapter, parseFrame, splitAlarms } = require('../base');

/**
 * tcp-ascii — generic ASCII stream over TCP (proprietary Ethernet).
 *
 * Used by: Baxter Artis (Exalis), B. Braun Dialog iQ (LAN data interface),
 * Bellco Formula/Flexya, and most machines that push a line-delimited telemetry
 * stream, whether we connect to them (client) or they connect to us (listen).
 *
 * params:
 *   host, port       : target when acting as a TCP client
 *   listen           : true → we listen on `port` and the device connects to us
 *   delimiter        : frame delimiter (default "\n"; "\r" also common)
 *   format           : 'kv' (default) | 'csv' | 'json'   (see base.parseFrame)
 *   pairDelim, kvDelim, columns : format options
 *   alarmKeys        : field names carrying alarm text/codes
 *   reconnectMs      : client reconnect backoff (default 5000)
 */
class TcpAsciiAdapter extends BaseAdapter {
  async start() {
    this.delim = this.params.delimiter || '\n';
    this.reconnectMs = Number(this.params.reconnectMs || 5000);
    if (this.params.listen) this._listen();
    else this._connect();
  }

  _wire(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf(this.delim)) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + this.delim.length);
        const obj = parseFrame(line, this.params);
        if (!obj) continue;
        const { signals, alarms } = splitAlarms(obj, this.params);
        this._reading(signals, alarms);
      }
    });
    sock.on('close', () => { if (!this.params.listen) this._retry(); });
    sock.on('error', (e) => this._fail(e));
  }

  _connect() {
    const sock = net.connect({ host: this.params.host, port: Number(this.params.port) }, () => {
      this._connected(true);
      console.log(`[tcp-ascii] ${this.machineId} → ${this.params.host}:${this.params.port}`);
    });
    this._sock = sock;
    this._wire(sock);
  }

  _retry() {
    this._connected(false);
    if (this._stopped) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => this._connect(), this.reconnectMs);
    this._t.unref();
  }

  _listen() {
    this._server = net.createServer((sock) => {
      this._connected(true);
      console.log(`[tcp-ascii] ${this.machineId} ← device connected on :${this.params.port}`);
      this._wire(sock);
      sock.on('close', () => this._connected(false));
    });
    this._server.on('error', (e) => this._fail(e));
    this._server.listen(Number(this.params.port), this.params.host || '0.0.0.0');
  }

  async stop() {
    this._stopped = true;
    clearTimeout(this._t);
    try { this._sock && this._sock.destroy(); } catch {}
    try { this._server && this._server.close(); } catch {}
    this._connected(false);
  }
}

module.exports = TcpAsciiAdapter;
