'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BaseAdapter, splitAlarms } = require('../base');

/**
 * file-poll — reads the newest export file dropped by a data manager.
 *
 * Used by: Fresenius TDMS batch exports, Gambro/Baxter Exalis CSV, Toray LAN
 * export, and any "watch folder" integration.
 *
 * params:
 *   dir           : directory to watch (UNC path OK on Windows)
 *   match         : filename substring / extension filter (default ".csv")
 *   format        : 'csv' (default) | 'json'
 *   delimiter     : CSV delimiter (default ",")
 *   machineField  : column identifying the machine; row is used only if it
 *                   equals this binding's machineId (omit for one-machine folders)
 *   row           : 'last' (default) | 'first'
 *   periodMs      : rescan interval (default 10000)
 *   alarmKeys     : columns carrying alarm text/codes
 */
class FilePollAdapter extends BaseAdapter {
  async start() {
    if (!this.params.dir) throw new Error('params.dir requis');
    this.dir = this.params.dir;
    this.match = this.params.match || '.csv';
    this.format = this.params.format || 'csv';
    this.delim = this.params.delimiter || ',';
    this.periodMs = Number(this.params.periodMs || 10000);
    this._seen = null;
    if (!fs.existsSync(this.dir)) throw new Error(`répertoire absent: ${this.dir}`);
    this._timer = setInterval(() => this._scan().catch((e) => this._fail(e)), this.periodMs);
    this._timer.unref();
    await this._scan();
  }

  async _scan() {
    const files = fs.readdirSync(this.dir)
      .filter((f) => f.toLowerCase().includes(this.match.toLowerCase()))
      .map((f) => ({ f, m: fs.statSync(path.join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) { if (!this.connected) this._connected(true); return; }

    const newest = files[0];
    if (this._seen === newest.f + newest.m) return;
    this._seen = newest.f + newest.m;

    const text = fs.readFileSync(path.join(this.dir, newest.f), 'utf8');
    const rows = this.format === 'json' ? this._parseJson(text) : this._parseCsv(text);
    if (!rows.length) return;

    let row;
    if (this.params.machineField) {
      const wanted = String(this.machineId).toLowerCase();
      const matches = rows.filter((r) => String(r[this.params.machineField] || '').toLowerCase() === wanted);
      row = (this.params.row === 'first' ? matches[0] : matches[matches.length - 1]);
    } else {
      row = (this.params.row === 'first' ? rows[0] : rows[rows.length - 1]);
    }
    if (!row) { if (!this.connected) this._connected(true); return; }

    const { signals, alarms } = splitAlarms(row, this.params);
    this._reading(signals, alarms);
  }

  _parseCsv(text) {
    const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const head = lines[0].split(this.delim).map((h) => h.trim());
    return lines.slice(1).map((l) => {
      const cells = l.split(this.delim);
      const o = {};
      head.forEach((h, i) => { o[h] = (cells[i] || '').trim(); });
      return o;
    });
  }

  _parseJson(text) {
    try {
      const j = JSON.parse(text);
      return Array.isArray(j) ? j : [j];
    } catch { return []; }
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    this._connected(false);
  }
}

module.exports = FilePollAdapter;
