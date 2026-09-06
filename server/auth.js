'use strict';

// Phase 4 — real authentication + RBAC. Replaces the front-end's cosmetic role
// <select>. No dependency: HS256 JWT + scrypt password hashing via node:crypto.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, tx } = require('./db');

// ---------------------------------------------------------------------------
// JWT signing secret — from env, else generated once and persisted (dev).
// ---------------------------------------------------------------------------
const SECRET_FILE = path.join(__dirname, '.jwt-secret');
let JWT_SECRET = process.env.HADJ_JWT_SECRET || '';
if (!JWT_SECRET) {
  try {
    JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, JWT_SECRET, { mode: 0o600 }); } catch { /* ignore */ }
  }
}
const TOKEN_TTL_SEC = Number(process.env.HADJ_TOKEN_TTL || 8 * 3600); // 8h

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------
const ROLE_PERMISSIONS = {
  ADMIN:        ['fleet:read', 'audit:read', 'audit:write', 'audit:verify', 'connectors:read', 'connectors:manage', 'config:read', 'config:write', 'users:manage', 'maintenance:read', 'maintenance:write'],
  NEPHROLOGIST: ['fleet:read', 'audit:read', 'audit:write', 'connectors:read', 'maintenance:read'],
  NURSE:        ['fleet:read', 'audit:read', 'audit:write', 'maintenance:read'],
  TECHNICIAN:   ['fleet:read', 'audit:read', 'audit:write', 'connectors:read', 'connectors:manage', 'config:read', 'maintenance:read', 'maintenance:write'],
  AUDITOR:      ['fleet:read', 'audit:read', 'audit:verify', 'connectors:read', 'maintenance:read'],
  TRAINING:     ['fleet:read', 'audit:write'],
};
const ROLES = Object.keys(ROLE_PERMISSIONS);
const permsFor = (role) => ROLE_PERMISSIONS[role] || [];

// ---------------------------------------------------------------------------
// Passwords (scrypt)
// ---------------------------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [scheme, saltHex, dkHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const dk = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32);
  const ref = Buffer.from(dkHex, 'hex');
  return dk.length === ref.length && crypto.timingSafeEqual(dk, ref);
}

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload, ttlSec = TOKEN_TTL_SEC) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('format');
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('signature');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (claims.exp && Math.floor(Date.now() / 1000) > claims.exp) throw new Error('expiré');
  return claims;
}

// ---------------------------------------------------------------------------
// User store
// ---------------------------------------------------------------------------
function seedUsersIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return { seeded: false, users: n };

  const file = process.env.HADJ_USERS || path.join(__dirname, 'users.seed.json');
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { list = [{ id: 'admin', name: 'Administrateur', role: 'ADMIN', password: 'hadj-admin', pin: '1234' }]; }

  const now = new Date().toISOString();
  tx(() => {
    const ins = db.prepare('INSERT INTO users (id, name, role, pw_hash, pin_hash, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)');
    for (const u of list) {
      if (!ROLES.includes(u.role)) { console.warn(`[auth] rôle inconnu ignoré: ${u.role}`); continue; }
      ins.run(u.id, u.name, u.role, hashPassword(u.password), u.pin ? hashPassword(String(u.pin)) : null, now);
    }
  });
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`[auth] ${users} utilisateur(s) de démonstration créés (voir users.seed.json)`);
  return { seeded: true, users };
}

function authenticate(id, password) {
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(String(id || ''));
  if (!row || !verifyPassword(password, row.pw_hash)) return null;
  return { id: row.id, name: row.name, role: row.role };
}

/** Second-factor PIN check for critical actions (needle-check ack, escalation…). */
function verifyPin(userId, pin) {
  const row = db.prepare('SELECT pin_hash FROM users WHERE id = ? AND disabled = 0').get(String(userId || ''));
  if (!row || !row.pin_hash) return false;
  return verifyPassword(String(pin || ''), row.pin_hash);
}

/** Backfill pin_hash for pre-existing demo users (DB created before PINs existed). */
function backfillDemoPins() {
  const file = process.env.HADJ_USERS || path.join(__dirname, 'users.seed.json');
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { updated: 0 }; }
  const byId = new Map(list.map((u) => [u.id, u]));
  const rows = db.prepare('SELECT id FROM users WHERE pin_hash IS NULL').all();
  const upd = db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?');
  let updated = 0;
  for (const r of rows) {
    const seedUser = byId.get(r.id);
    if (seedUser && seedUser.pin) { upd.run(hashPassword(String(seedUser.pin)), r.id); updated++; }
  }
  if (updated) console.log(`[auth] PIN de démonstration renseigné pour ${updated} compte(s) existant(s)`);
  return { updated };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'authentification requise' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    res.status(401).json({ error: `jeton invalide (${e.message})` });
  }
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (permsFor(req.user && req.user.role).includes(perm)) return next();
    res.status(403).json({ error: `permission "${perm}" refusée pour le rôle ${req.user && req.user.role}` });
  };
}

// naive in-memory throttle (POC): lenient so demo typos don't lock you out.
// Prod: distributed rate-limit + account lockout + MFA (see SECURITY.md).
function makeThrottle(maxFails, lockMs) {
  const store = new Map();
  return {
    allow: (key) => { const r = store.get(String(key || '')); return !(r && r.until > Date.now()); },
    note: (key, ok) => {
      const k = String(key || '');
      if (ok) { store.delete(k); return; }
      const r = store.get(k) || { n: 0, until: 0 };
      r.n += 1;
      if (r.n >= maxFails) { r.until = Date.now() + lockMs; r.n = 0; }
      store.set(k, r);
    },
  };
}

const LOGIN_MAX_FAILS = Number(process.env.HADJ_LOGIN_MAX_FAILS || 12);
const LOGIN_LOCK_MS = Number(process.env.HADJ_LOGIN_LOCK_MS || 30_000);
const loginThrottle = makeThrottle(LOGIN_MAX_FAILS, LOGIN_LOCK_MS);
function throttleLogin(id) { return loginThrottle.allow(id); }
function noteLoginResult(id, ok) { return loginThrottle.note(id, ok); }

// PIN space is tiny (4-6 digits) — the lock is the actual security, not the hash.
const PIN_MAX_FAILS = Number(process.env.HADJ_PIN_MAX_FAILS || 5);
const PIN_LOCK_MS = Number(process.env.HADJ_PIN_LOCK_MS || 60_000);
const pinThrottle = makeThrottle(PIN_MAX_FAILS, PIN_LOCK_MS);
function throttlePin(userId) { return pinThrottle.allow(userId); }
function notePinResult(userId, ok) { return pinThrottle.note(userId, ok); }

module.exports = {
  ROLES, ROLE_PERMISSIONS, permsFor,
  hashPassword, verifyPassword,
  signToken, verifyToken,
  seedUsersIfEmpty, authenticate, verifyPin, backfillDemoPins,
  requireAuth, requirePerm,
  throttleLogin, noteLoginResult,
  throttlePin, notePinResult,
  TOKEN_TTL_SEC,
};
