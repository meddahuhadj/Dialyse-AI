# HADJ — Rapport de sécurisation (Phase 4)

Périmètre : **POC / démonstration interne**, sans données patient réelles. Ce
document décrit ce qui est en place et ce qui reste à faire **avant tout usage
clinique réel**.

---

## 1. Authentification & contrôle d'accès

| Élément | État | Détail |
|---|---|---|
| Auth réelle | ✅ | `POST /api/auth/login` → JWT HS256 (`server/auth.js`), TTL 8 h (`HADJ_TOKEN_TTL`). Secret de signature : `HADJ_JWT_SECRET` sinon généré dans `.jwt-secret` (git-ignoré). |
| Mots de passe | ✅ | `scrypt` (sel 16 o, clé 32 o), comparaison `timingSafeEqual`. Table `users`. |
| RBAC | ✅ | 6 rôles → permissions (`ROLE_PERMISSIONS`). Middleware `requireAuth` + `requirePerm(perm)` sur chaque route. Le faux `<select>` de rôle du front est désormais **désactivé** ; le rôle vient du compte. |
| Anti-bruteforce | ⚠️ POC | Throttle en mémoire (5 échecs / id / 5 min). En prod : rate-limit distribué + verrouillage compte + MFA. |
| Session front | ✅ | JWT en `sessionStorage` (effacé à la fermeture de l'onglet), jamais `localStorage`. En-tête `Authorization: Bearer` via `apiFetch()`. 401 → ré-affichage du login. |
| SSO / annuaire | ❌ à faire | Remplacer le user store local par OIDC/SAML (Keycloak, Azure AD…) + provisioning. |

**Matrice des permissions**

| Permission | ADMIN | NEPHROLOGIST | NURSE | TECHNICIAN | AUDITOR | TRAINING |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `fleet:read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `audit:read` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `audit:write` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `audit:verify` | ✅ | — | — | — | ✅ | — |
| `connectors:read` | ✅ | ✅ | — | ✅ | ✅ | — |
| `connectors:manage` | ✅ | — | — | ✅ | — | — |
| `config:read` / `config:write` | ✅ / ✅ | — | — | ✅ / — | — | — |
| `users:manage` | ✅ | — | — | — | — | — |

Comptes de démonstration : `users.seed.json` (`admin`/`nephro`/`nurse`/`tech`/`auditor`,
mot de passe `hadj-<id>`). **À supprimer / régénérer avant toute mise en ligne.**

---

## 2. Transport (TLS)

| Élément | État | Détail |
|---|---|---|
| HTTPS | ✅ opt-in | `server/security.js` : si `certs/key.pem` + `certs/cert.pem` présents → serveur HTTPS, sinon HTTP + avertissement. Générer un cert local : `scripts/gen-cert.sh` / `.ps1`. |
| HSTS | ✅ | En-tête `Strict-Transport-Security` émis dès que la requête est en HTTPS. |
| En-têtes de sécurité | ✅ | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`. `x-powered-by` désactivé. |
| CSP | ⚠️ différé | Le front mono-fichier repose sur `<script>`/`<style>` inline + esm.sh + Google Fonts. Une CSP stricte impose de : self-héberger la lib `@google/genai` et les polices, externaliser le JS/CSS ou poser des nonces. |
| CORS | ⚠️ POC | `cors()` ouvert (permet l'ouverture `file://`). En prod : liste blanche d'origines. |
| Reverse proxy | ❌ à faire | En prod, terminer le TLS sur un proxy (nginx/traefik) + certificats gérés (ACME). |

---

## 3. Secrets

| Élément | État | Détail |
|---|---|---|
| Clé API Gemini | ✅ | Retirée du `localStorage`. Stockée côté serveur, **chiffrée AES-256-GCM** (`server/secrets.js` → `secrets.enc.json`). `GET /api/config/gemini-key` ne renvoie que `{configured, updated_at}`, **jamais la valeur**. Écriture réservée à `config:write` (ADMIN). |
| Clé maître | ⚠️ POC | `HADJ_SECRET_KEY` (env) sinon fichier `.secret-key` (git-ignoré). En prod : KMS / HashiCorp Vault / AWS Secrets Manager / Azure Key Vault. |
| Secret JWT | ⚠️ POC | idem (`.jwt-secret`). En prod : secrets manager + rotation. |
| Appels Gemini | ✅ | **Gemini Live** (copilote vocal temps réel) : `POST /api/ai/live-token` (`server/gemini.js`) émet un **jeton éphémère** à usage unique (1 utilisation, expire sous 15 min, fenêtre de démarrage 1 min) à partir de la clé stockée côté serveur. Le navigateur se connecte **directement** au WebSocket Gemini avec ce jeton, jamais avec la vraie clé — cf. [ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens). Sans clé configurée → repli automatique sur la reconnaissance/synthèse vocale du navigateur. |
| Fichiers sensibles | ✅ | `.gitignore` couvre `.jwt-secret`, `.secret-key`, `secrets.enc.json`, `certs/*.pem`, `*.db`, `connectors/connectors.config.json`. |

---

## 4. Audit trail infalsifiable

| Élément | État | Détail |
|---|---|---|
| Persistance | ✅ | SQLite, survit au redémarrage (Phase 1). |
| Chaîne de hachage | ✅ | Chaque ligne : `hash = SHA256(hash_précédent ‖ time ‖ user ‖ machine ‖ action ‖ data ‖ ai ‖ network ‖ created_at)` (`server/audit-chain.js`). Toute modification / suppression / réordonnancement d'une ligne passée casse la chaîne à partir de ce point. |
| Vérification | ✅ | `GET /api/audit/verify` (perm `audit:verify`) rejoue toute la chaîne → `{ok, count}` ou `{ok:false, brokenAt}`. Bouton « Vérifier l'intégrité » dans l'onglet Audit. |
| Identité fiable | ✅ | Le champ `user` d'une entrée POST est **écrasé** par le rôle du jeton, pas celui fourni par le client. |
| Horodatage sûr | ⚠️ à faire | `created_at` = horloge serveur. Pour une valeur probante : horodatage qualifié (RFC 3161) ou ancrage périodique du dernier hash (journal WORM, transparency log). |
| Export signé | ⚠️ à faire | `Exporter Journal JSON` exporte le contenu ; ajouter une signature détachée du dernier hash. |

---

## 5. Chiffrement au repos

| Donnée | État | Détail |
|---|---|---|
| Secrets (`secrets.enc.json`) | ✅ | AES-256-GCM applicatif. |
| Base `hadj.db` (fleet, audit, users) | ⚠️ à faire | `node:sqlite` ne chiffre pas. Options prod : SQLCipher, chiffrement du volume (LUKS / BitLocker), ou base managée chiffrée (Postgres + TDE / cloud KMS). Les mots de passe sont déjà hachés (scrypt) ; l'audit est chaîné. |

---

## 6. Check-list de conformité — avant données patient réelles

- [ ] Remplacer le user store local par un **SSO** (OIDC/SAML) + MFA soignant (badge/PIN déjà maquetté côté UI).
- [ ] Supprimer les comptes de démonstration et les mots de passe par défaut.
- [ ] **HTTPS obligatoire** (redirection HTTP→HTTPS, HSTS preload), certificats gérés.
- [ ] Clé maître + secret JWT dans un **coffre-fort** (KMS/Vault) avec rotation.
- [x] **Aucune clé LLM côté navigateur** — Gemini Live utilise un jeton éphémère à usage unique (voir §3) plutôt qu'un proxy audio complet (le proxy ajouterait une latence significative à un flux temps réel).
- [ ] **Chiffrement au repos** de la base (SQLCipher / volume / base managée).
- [ ] Horodatage qualifié + ancrage/export signé de l'audit trail.
- [ ] CSP stricte (self-hosting lib + polices, nonces).
- [ ] Rate-limiting distribué, verrouillage de compte, journalisation des accès.
- [ ] Politique de **rétention / purge RGPD**, registre des traitements, base légale, DPO.
- [ ] Hébergement **HDS** (France) + convention, PCA/PRA, sauvegardes chiffrées testées.
- [ ] Analyse de risque **dispositif médical** (IEC 62304 classe B/C, ISO 14971, IEC 62366 UX), gestion des changements, dossier de conception.
- [ ] Tests de sécurité : SAST/DAST, revue de dépendances (`npm audit`), pentest externe.
- [ ] Cloisonnement réseau des générateurs (VLAN dédié), le principe **read-only / aucun contrôle machine** reste garanti et vérifié.
- [ ] Plan de réponse à incident + notification CNIL / ANSM le cas échéant.

---

## 7. Variables d'environnement (sécurité)

| Variable | Rôle |
|---|---|
| `HADJ_JWT_SECRET` | Secret de signature JWT (sinon `.jwt-secret`) |
| `HADJ_TOKEN_TTL` | Durée de vie du jeton en secondes (défaut 28800) |
| `HADJ_SECRET_KEY` | Clé maître du coffre-fort de secrets (sinon `.secret-key`) |
| `HADJ_SECRETS` | Chemin du store chiffré (défaut `server/secrets.enc.json`) |
| `HADJ_USERS` | Chemin du fichier de comptes initiaux (défaut `users.seed.json`) |
| `HADJ_CERT_DIR` | Répertoire des certificats TLS (défaut `server/certs`) |
