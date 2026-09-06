'use strict';

// Phase 4 — server-side secret store. Secrets (e.g. the Gemini API key) never
// touch the browser's localStorage anymore. Values are encrypted at rest with
// AES-256-GCM; the master key comes from HADJ_SECRET_KEY, else a local key file
// generated on first run (dev). In production the master key belongs in a real
// secrets manager / KMS — see SECURITY.md.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_FILE = process.env.HADJ_SECRETS || path.join(__dirname, 'secrets.enc.json');
const KEY_FILE = path.join(__dirname, '.secret-key');

function masterKey() {
  const fromEnv = process.env.HADJ_SECRET_KEY;
  if (fromEnv) return crypto.createHash('sha256').update(fromEnv).digest(); // 32 bytes
  try {
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } catch {
    const k = crypto.randomBytes(32);
    try { fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 }); } catch { /* ignore */ }
    return k;
  }
}
const KEY = masterKey();

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeStore(obj) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function decrypt(rec) {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(rec.iv, 'hex'));
  d.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(rec.data, 'hex')), d.final()]).toString('utf8');
}

function setSecret(name, value) {
  const store = readStore();
  store[name] = { ...encrypt(value), updated_at: new Date().toISOString() };
  writeStore(store);
}
function getSecret(name) {
  const rec = readStore()[name];
  if (!rec) return null;
  try { return decrypt(rec); } catch { return null; }
}
function hasSecret(name) {
  return !!readStore()[name];
}
function secretMeta(name) {
  const rec = readStore()[name];
  return rec ? { configured: true, updated_at: rec.updated_at } : { configured: false };
}

module.exports = { setSecret, getSecret, hasSecret, secretMeta };
