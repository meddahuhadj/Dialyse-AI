'use strict';

// Production readiness — what still stands between "SIMULATION POC" and a real
// deployment connected to real dialysis equipment. Every check is concrete and
// carries a `fix`. Surfaced at GET /api/readiness (admin) and as a loud console
// summary at boot.

const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
const auth = require('./auth');

const CERT_DIR = process.env.HADJ_CERT_DIR || path.join(__dirname, 'certs');
const CONNECTORS_CFG = process.env.HADJ_CONNECTORS || path.join(__dirname, 'connectors', 'connectors.config.json');
const DEMO_USERS = ['admin', 'nephro', 'nurse', 'tech', 'auditor'];

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }

function computeReadiness(fleet, devices, connectorsSnapshot) {
  const checks = [];
  const add = (id, label, severity, status, detail, fix) => checks.push({ id, label, severity, status, detail, fix });

  // --- TLS ---
  const tls = fileExists(path.join(CERT_DIR, 'key.pem')) && fileExists(path.join(CERT_DIR, 'cert.pem'));
  add('tls', 'HTTPS / TLS', tls ? 'ok' : 'critical',
    tls ? 'Certificats présents' : 'HTTP en clair',
    tls ? `certs/ dans ${CERT_DIR}` : 'Le trafic (jetons, données) circule en clair.',
    tls ? null : 'Placer certs/key.pem + certs/cert.pem (scripts/gen-cert.*) ou terminer le TLS sur un reverse-proxy (nginx/traefik + ACME).');

  // --- JWT signing secret ---
  const jwtEnv = !!process.env.HADJ_JWT_SECRET;
  add('jwt', 'Secret de signature JWT', jwtEnv ? 'ok' : 'warning',
    jwtEnv ? 'Fourni par l\'environnement' : 'Généré localement (.jwt-secret)',
    jwtEnv ? 'HADJ_JWT_SECRET défini' : 'Un secret auto-généré est perdu si le fichier est supprimé → toutes les sessions invalidées.',
    jwtEnv ? null : 'Définir HADJ_JWT_SECRET (≥ 32 octets aléatoires) depuis un coffre-fort (Vault/KMS), avec rotation.');

  // --- Master key for the encrypted secret store ---
  const keyEnv = !!process.env.HADJ_SECRET_KEY;
  add('masterkey', 'Clé maître du coffre-fort de secrets', keyEnv ? 'ok' : 'warning',
    keyEnv ? 'Fournie par l\'environnement' : 'Générée localement (.secret-key)',
    keyEnv ? 'HADJ_SECRET_KEY défini' : 'La clé Gemini chiffrée devient illisible si .secret-key est perdu.',
    keyEnv ? null : 'Définir HADJ_SECRET_KEY depuis un KMS / Vault / Secrets Manager.');

  // --- Demo accounts still present / default passwords ---
  let demoPresent = 0;
  let defaultPw = 0;
  for (const id of DEMO_USERS) {
    const row = db.prepare('SELECT id, pw_hash FROM users WHERE id = ?').get(id);
    if (!row) continue;
    demoPresent++;
    try { if (auth.verifyPassword(`hadj-${id}`, row.pw_hash)) defaultPw++; } catch { /* ignore */ }
  }
  add('demo-users', 'Comptes de démonstration', defaultPw > 0 ? 'critical' : demoPresent > 0 ? 'warning' : 'ok',
    defaultPw > 0 ? `${defaultPw} compte(s) avec le mot de passe par défaut` : demoPresent > 0 ? `${demoPresent} compte(s) de démo présent(s)` : 'Aucun compte de démo',
    defaultPw > 0 ? 'N\'importe qui connaissant le schéma hadj-«identifiant» peut se connecter.' : 'Comptes de démo encore actifs.',
    defaultPw > 0 || demoPresent > 0
      ? 'node scripts/set-password.js  ID  "mot de passe fort"  pour chaque compte réel, puis  node scripts/set-password.js --remove-demo. Idéal : remplacer par un SSO (OIDC/SAML) + MFA.'
      : null);

  // --- CORS ---
  const corsRestricted = !!process.env.HADJ_CORS_ORIGINS;
  add('cors', 'CORS', corsRestricted ? 'ok' : 'warning',
    corsRestricted ? 'Liste blanche d\'origines' : 'Ouvert (toutes origines)',
    corsRestricted ? process.env.HADJ_CORS_ORIGINS : 'Toute page web peut appeler l\'API avec le jeton de l\'utilisateur.',
    corsRestricted ? null : 'Définir HADJ_CORS_ORIGINS="https://hadj.mon-hopital.fr" (séparées par des virgules).');

  // --- Optional protocol dependencies ---
  const optDeps = [
    ['serialport', 'RS-232 série'],
    ['modbus-serial', 'Modbus TCP'],
    ['node-opcua', 'OPC-UA'],
  ];
  const missing = optDeps.filter(([m]) => { try { require.resolve(m); return false; } catch { return true; } });
  add('protocol-deps', 'Bibliothèques de protocole optionnelles', missing.length ? 'info' : 'ok',
    missing.length ? `${missing.length} non installée(s)` : 'Toutes installées',
    missing.length ? missing.map(([m, l]) => `${l} (${m})`).join(', ') : 'serialport, modbus-serial, node-opcua',
    missing.length ? `npm i ${missing.map(([m]) => m).join(' ')} — uniquement si vous utilisez ces protocoles.` : null);

  // --- Connectors config + fleet composition ---
  const cfgExists = fileExists(CONNECTORS_CFG);
  const liveBindings = (() => {
    try { return (JSON.parse(fs.readFileSync(CONNECTORS_CFG, 'utf8')).bindings || []).length; } catch { return 0; }
  })();
  const devList = devices.listDevices(fleet, connectorsSnapshot);
  const activeDevices = devList.filter((d) => d.approvalState === 'ACTIVE').length;
  const connected = devList.filter((d) => d.connectivityStatus === 'CONNECTED').length;
  add('connectors', 'Sources de données', connected > 0 ? 'ok' : liveBindings > 0 ? 'warning' : 'info',
    `${liveBindings} liaison(s) configurée(s) · ${connected} appareil(s) CONNECTÉ(s) · ${activeDevices} ACTIF(s)`,
    cfgExists ? `connectors.config.json présent` : 'Aucun connectors.config.json → parc 100 % simulé.',
    connected === 0
      ? 'Device Center → « + Ajouter une source de données » : choisir le protocole vérifié pour le modèle, tester, autoriser, puis passer l\'appareil par les 13 contrôles de la porte de sécurité → APPROVED → ACTIVE.'
      : null);

  // --- DB at rest ---
  add('db-encryption', 'Chiffrement de la base au repos', 'warning', 'Non chiffrée',
    'node:sqlite ne chiffre pas hadj.db (fleet, audit, users). Les mots de passe sont hachés (scrypt), l\'audit est chaîné.',
    'Chiffrement du volume (LUKS / BitLocker), SQLCipher, ou base managée chiffrée (Postgres + TDE / KMS cloud).');

  const criticals = checks.filter((c) => c.severity === 'critical');
  const warnings = checks.filter((c) => c.severity === 'warning');
  const overall = criticals.length ? 'not-ready' : warnings.length ? 'caution' : 'ready';

  return {
    generatedAt: new Date().toISOString(),
    overall,
    counts: { critical: criticals.length, warning: warnings.length, ok: checks.filter((c) => c.severity === 'ok').length },
    checks,
  };
}

function logBootSummary(report) {
  const crit = report.checks.filter((c) => c.severity === 'critical');
  if (!crit.length) {
    console.log(`[readiness] ${report.overall} — ${report.counts.warning} avertissement(s), 0 bloquant`);
    return;
  }
  console.warn('┌─ [readiness] PASSAGE EN MODE RÉEL — points BLOQUANTS ─────────────');
  for (const c of crit) console.warn(`│  ✗ ${c.label} : ${c.status} — ${c.detail}`);
  console.warn('│  Détail complet : GET /api/readiness (rôle ADMIN) ou server/GO-LIVE.md');
  console.warn('└─────────────────────────────────────────────────────────────────');
}

module.exports = { computeReadiness, logBootSummary };
