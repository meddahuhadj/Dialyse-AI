# HADJ Fleet & Audit API

Backend du prototype HADJ : remplace les constantes figées `FLEET` / `AUDIT_LOG`
de `HADJ-ASSISTANT.html` par une API HTTP adossée à SQLite, alimentée par des
connecteurs multi-protocoles, et protégée par authentification + RBAC.

- **Phase 1** — API fleet + audit persistant · **Phase 2** — front-end sur l'API
- **Phase 3** — connecteurs réels ([connectors/README.md](connectors/README.md))
- **Phase 4** — auth JWT + RBAC, audit infalsifiable, secrets serveur ([SECURITY.md](SECURITY.md))

## Stack

- Node.js ≥ 22.5 — `node:sqlite` + `node:crypto` intégrés, **aucun module natif**
- Express + CORS + Swagger UI (`/api/docs`)

## Démarrage

```bash
cd server
npm install
npm start          # http://localhost:4310
```

Premier lancement : `hadj.db` est créée et peuplée depuis `seed-data.json`, et
5 comptes de démonstration sont créés (`users.seed.json`). Ouvrez
`http://localhost:4310/` et connectez-vous (`nephro` / `hadj-nephro`).

| Commande | Effet |
|----------|-------|
| `npm start` | Lance l'API (seed auto si base vide) |
| `npm run dev` | Idem avec rechargement à chaud (`node --watch`) |
| `npm run seed` | Peuple la base si elle est vide |
| `npm run seed:force` | Réinitialise et re-peuple la base |

### Variables d'environnement

| Variable | Défaut | Rôle |
|----------|--------|------|
| `PORT` | `4310` | Port HTTP |
| `HADJ_DB` | `server/hadj.db` | Chemin du fichier SQLite |
| `HADJ_SEED` | `server/seed-data.json` | Source du seed initial |
| `HADJ_TICK_MS` | `2000` | Période du simulateur de télémétrie |
| `HADJ_CONNECTORS` | `connectors/connectors.config.json` | Chemin de la config des connecteurs (Phase 3) |
| `HADJ_JWT_SECRET` / `HADJ_TOKEN_TTL` | `.jwt-secret` / `28800` | Secret et durée de vie des jetons (Phase 4) |
| `HADJ_SECRET_KEY` / `HADJ_SECRETS` | `.secret-key` / `secrets.enc.json` | Coffre-fort de secrets (Phase 4) |

## Endpoints

**Toutes les routes `/api/*` exigent `Authorization: Bearer <jwt>`**, sauf
`/api/health`, `/api/auth/login`, `/api/docs`, `/api/openapi.json`.

| Méthode | Route | Permission | Description |
|---|---|---|---|
| `GET` | `/api/health` | — | Liveness + infos runtime |
| `POST` | `/api/auth/login` | — | `{id,password}` → `{token, user}` |
| `GET` | `/api/auth/me` | (auth) | Identité + permissions du jeton |
| `GET` | `/api/fleet` | `fleet:read` | Liste complète des machines |
| `GET` | `/api/fleet/:id` | `fleet:read` | Détail d'une machine (`404` si inconnue) |
| `GET` | `/api/fleet/:id/alarms` | `fleet:read` | Historique des alarmes |
| `GET` | `/api/audit?limit=200` | `audit:read` | Registre d'audit, plus récent d'abord |
| `POST` | `/api/audit` | `audit:write` | Ajoute une entrée (chaînée par hash ; `user` = rôle du jeton) |
| `GET` | `/api/audit/verify` | `audit:verify` | Vérifie la chaîne de hachage |
| `GET` | `/api/connectors` | `connectors:read` | État des sources live |
| `GET` | `/api/connectors/catalogue` | `connectors:read` | Adaptateurs + modèles |
| `GET`/`PUT`/`DELETE` | `/api/config/gemini-key` | `config:read` / `config:write` | Statut / dépôt de la clé Gemini (jamais renvoyée) |
| `POST` | `/api/ai/live-token` | `fleet:read` | Jeton éphémère Gemini Live (usage unique) — voir `gemini.js` |
| `GET` | `/api/docs`, `/api/openapi.json` | — | Swagger UI / spec |
| `GET` | `/` | — | Sert `HADJ-ASSISTANT.html` |

### Exemple

```bash
TOKEN=$(curl -s -X POST localhost:4310/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"id":"nephro","password":"hadj-nephro"}' | jq -r .token)

curl -s localhost:4310/api/fleet -H "authorization: Bearer $TOKEN" | jq length   # 12
curl -s localhost:4310/api/audit/verify -H "authorization: Bearer $TOKEN"        # 403 (nephro)
```

Comptes de démo : `admin` / `nephro` / `nurse` / `tech` / `auditor`, mot de passe `hadj-<id>`
(`users.seed.json`). **À remplacer avant tout usage réel** — voir `SECURITY.md`.

## Modèle de données

- `machines(id, data JSON, updated_at)` — l'objet machine complet est stocké en JSON ;
  le **schéma reste la propriété du front-end**, le backend ne le contraint pas.
- `audit(id, time, user, machine, action, data, ai, network, created_at, prev_hash, hash)` — chaîne de hachage SHA-256.
- `alarms(id, machine_id, alarm_id, type, priority, timestamp, duration, status, note)`
- `users(id, name, role, pw_hash, disabled, created_at)` — mots de passe `scrypt`.

L'état télémétrique vit en mémoire (hydraté depuis la base), varie au tick, et est
flushé vers SQLite toutes les 15 s + à l'arrêt.

## Phases

- **Phase 1 ✅** — cette API + persistance SQLite.
- **Phase 2 ✅** — `HADJ-ASSISTANT.html` consomme l'API (fetch + polling, `addAuditEntry` → `POST /api/audit`).
- **Phase 3 ✅** — couche de connecteurs multi-modèles / multi-protocoles :
  `connectors/` (adaptateurs `hl7v2`, `fhir`, `tcp-ascii`, `serial`, `modbus-tcp`,
  `file-poll`, `opcua`, `simulator`). Voir **[connectors/README.md](connectors/README.md)**
  pour le mapping par modèle de générateur et la configuration.
- **Phase 4 ✅** — authentification JWT + RBAC (`auth.js`, remplace le `<select>` de rôle),
  audit trail infalsifiable par chaîne de hachage (`audit-chain.js`), secrets côté
  serveur chiffrés AES-256-GCM (`secrets.js`, clé Gemini hors `localStorage`),
  en-têtes de sécurité + HTTPS optionnel (`security.js`, `scripts/gen-cert.*`).
  **Rapport complet + check-list de conformité : [SECURITY.md](SECURITY.md).**
