'use strict';

const { BaseAdapter } = require('../base');

/**
 * opcua — reads OPC-UA variable nodes.
 *
 * Used by: Fresenius 6008 CAREsystem ("Fresenius Connectivity eXtension"),
 * modern platform/edge gateways aggregating dialysis + water treatment.
 *
 * Requires the optional `node-opcua` package:  npm i node-opcua
 *
 * params:
 *   endpoint   : opc.tcp://host:4840
 *   securityMode, securityPolicy : optional (default None/None)
 *   user, password : optional
 *   periodMs   : poll interval (default 2000)
 *   nodes      : { <canonicalOrRawKey>: "ns=2;s=Machine.VenousPressure", ... }
 *   alarmNode  : "ns=2;s=Machine.ActiveAlarmText"  (optional)
 */
class OpcUaAdapter extends BaseAdapter {
  async start() {
    if (!this.params.endpoint) throw new Error('params.endpoint requis');
    if (!this.params.nodes || !Object.keys(this.params.nodes).length) throw new Error('params.nodes requis');

    let opcua;
    try { opcua = require('node-opcua'); }
    catch { throw new Error('paquet "node-opcua" non installé — exécuter: npm i node-opcua'); }

    this._opcua = opcua;
    this.client = opcua.OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 3 } });
    await this.client.connect(this.params.endpoint);

    const auth = this.params.user
      ? { userName: this.params.user, password: this.params.password }
      : undefined;
    this.session = await this.client.createSession(auth);
    this._connected(true);
    console.log(`[opcua] ${this.machineId} → ${this.params.endpoint}`);

    this._entries = Object.entries(this.params.nodes);
    this.periodMs = Number(this.params.periodMs || 2000);
    this._timer = setInterval(() => this._poll().catch((e) => this._fail(e)), this.periodMs);
    this._timer.unref();
    await this._poll();
  }

  async _poll() {
    const signals = {};
    for (const [key, nodeId] of this._entries) {
      try {
        const dv = await this.session.read({ nodeId, attributeId: this._opcua.AttributeIds.Value });
        if (dv && dv.value && dv.value.value !== undefined && dv.value.value !== null) signals[key] = dv.value.value;
      } catch { /* skip node */ }
    }
    const alarms = [];
    if (this.params.alarmNode) {
      try {
        const dv = await this.session.read({ nodeId: this.params.alarmNode, attributeId: this._opcua.AttributeIds.Value });
        const v = dv && dv.value && dv.value.value;
        if (v && String(v).trim() && !/^(0|none|ok)$/i.test(String(v))) alarms.push({ text: String(v), code: 'OPCUA', priority: 'HIGH' });
      } catch { /* ignore */ }
    }
    if (Object.keys(signals).length || alarms.length) this._reading(signals, alarms);
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    try { this.session && await this.session.close(); } catch {}
    try { this.client && await this.client.disconnect(); } catch {}
    this._connected(false);
  }
}

module.exports = OpcUaAdapter;
