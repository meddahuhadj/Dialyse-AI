'use strict';

// Harden the user store before going real.
//
//   node scripts/set-password.js <id> "<new password>"     set one user's password
//   node scripts/set-password.js --list                    list accounts
//   node scripts/set-password.js --remove-demo             delete the demo accounts
//                                                          that still use hadj-<id>
//   node scripts/set-password.js --add <id> <name> <role> "<pw>" [pin]   create a user
//
// Roles: ADMIN | NEPHROLOGIST | NURSE | TECHNICIAN | AUDITOR | TRAINING

const path = require('node:path');
const { db } = require(path.join('..', 'db'));
const auth = require(path.join('..', 'auth'));

const DEMO = ['admin', 'nephro', 'nurse', 'tech', 'auditor'];
const args = process.argv.slice(2);

function list() {
  const rows = db.prepare('SELECT id, name, role, disabled FROM users ORDER BY id').all();
  for (const r of rows) {
    const row = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(r.id);
    let def = false;
    try { def = auth.verifyPassword(`hadj-${r.id}`, row.pw_hash); } catch { /* ignore */ }
    console.log(`  ${r.id.padEnd(12)} ${String(r.role).padEnd(13)} ${r.disabled ? '[désactivé] ' : ''}${def ? '⚠ mot de passe par défaut' : ''}`);
  }
}

if (!args.length || args[0] === '--help') {
  console.log('node scripts/set-password.js <id> "<pw>" | --list | --remove-demo | --add <id> <name> <role> "<pw>" [pin]');
  process.exit(0);
}

if (args[0] === '--list') { list(); process.exit(0); }

if (args[0] === '--remove-demo') {
  let removed = 0;
  for (const id of DEMO) {
    const row = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(id);
    if (!row) continue;
    let def = false;
    try { def = auth.verifyPassword(`hadj-${id}`, row.pw_hash); } catch { /* ignore */ }
    if (def) { db.prepare('DELETE FROM users WHERE id = ?').run(id); removed++; console.log(`  supprimé : ${id}`); }
    else console.log(`  conservé : ${id} (mot de passe déjà changé)`);
  }
  console.log(`${removed} compte(s) de démo supprimé(s).`);
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1").get()) {
    console.warn('⚠  Plus aucun compte ADMIN ! Recréez-en un : node scripts/set-password.js --add admin "Nom" ADMIN "<pw>"');
  }
  process.exit(0);
}

if (args[0] === '--add') {
  const [, id, name, role, pw, pin] = args;
  if (!id || !name || !role || !pw) { console.error('usage: --add <id> <name> <role> "<pw>" [pin]'); process.exit(1); }
  if (!auth.ROLES.includes(role)) { console.error(`rôle inconnu: ${role} (attendus: ${auth.ROLES.join(', ')})`); process.exit(1); }
  db.prepare('INSERT OR REPLACE INTO users (id, name, role, pw_hash, pin_hash, disabled, created_at) VALUES (?,?,?,?,?,0,?)')
    .run(id, name, role, auth.hashPassword(pw), pin ? auth.hashPassword(String(pin)) : null, new Date().toISOString());
  console.log(`compte ${id} (${role}) créé/mis à jour.`);
  process.exit(0);
}

// default: <id> "<pw>"
const [id, pw] = args;
if (!id || !pw) { console.error('usage: node scripts/set-password.js <id> "<nouveau mot de passe>"'); process.exit(1); }
const row = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
if (!row) { console.error(`utilisateur inconnu: ${id}`); process.exit(1); }
if (pw.length < 10) { console.warn('⚠  mot de passe court (< 10 caractères).'); }
db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(auth.hashPassword(pw), id);
console.log(`mot de passe de ${id} mis à jour.`);
