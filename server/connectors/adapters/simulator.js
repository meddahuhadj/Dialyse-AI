'use strict';

const { BaseAdapter } = require('../base');

/**
 * simulator — no real device. Produces a bounded random-walk seeded from the
 * machine's current values. This is the default binding for every machine so
 * `GET /api/fleet` is always complete; a real adapter's readings take priority
 * (see ConnectorManager: simulator readings are dropped while a live source is
 * fresh).
 *
 * params:
 *   seed      : machine object snapshot (injected by ConnectorManager)
 *   periodMs  : tick period (default HADJ_TICK_MS or 2000)
 *   frozen    : if true, values don't drift (auto-true when seed.status === 'ALARM')
 */
class SimulatorAdapter extends BaseAdapter {
  async start() {
    const s = this.params.seed || {};
    this.v = {
      QB: s.bfr, PV: s.pven, PA: s.part, TMP: s.tmp,
      UFR: s.ufr, UFV: s.ufv, COND: s.cond, TD: s.temp,
    };
    this.frozen = this.params.frozen === true || s.status === 'ALARM' || !s.sessionActive;
    this.periodMs = Number(this.params.periodMs || process.env.HADJ_TICK_MS || 2000);
    this._connected(true);
    this._timer = setInterval(() => this._tick(), this.periodMs);
    this._timer.unref();
    this._tick();
  }

  _tick() {
    if (!this.frozen) {
      const j = (x, d) => (typeof x === 'number' ? Math.round((x + (Math.random() - 0.5) * d) * 10) / 10 : x);
      this.v.PV = j(this.v.PV, 1.5);
      this.v.PA = j(this.v.PA, 2);
      this.v.TMP = j(this.v.TMP, 1.2);
    }
    const signals = {};
    for (const [k, val] of Object.entries(this.v)) if (val !== null && val !== undefined) signals[k] = val;
    this._reading(signals);
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    this._connected(false);
  }
}

module.exports = SimulatorAdapter;
