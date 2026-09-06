# Passage en mode réel — runbook

De **SIMULATION (POC)** à un service d'hémodialyse connecté à de vrais générateurs.
L'état d'avancement est calculé en direct : **`GET /api/readiness`** (rôle ADMIN) ou
le panneau **« Passage en mode réel »** dans l'onglet *Device Center*. Un résumé
des points bloquants s'affiche aussi au démarrage du serveur.

---

## 1. Sécurité & infrastructure (bloquant)

| Point | Action |
|---|---|
| **HTTPS/TLS** | `certs/key.pem` + `certs/cert.pem` (dev : `scripts/gen-cert.sh` / `.ps1`), **ou** terminer le TLS sur un reverse-proxy (nginx/traefik + certificats ACME). |
| **Secret JWT** | `HADJ_JWT_SECRET` (≥ 32 octets aléatoires) depuis un coffre-fort (Vault / AWS Secrets Manager / Azure Key Vault). Prévoir la **rotation**. |
| **Clé maître des secrets** | `HADJ_SECRET_KEY` depuis le même coffre-fort. |
| **Comptes de démonstration** | `npm run users` pour l'état ; définir un vrai mot de passe fort par compte réel (`node scripts/set-password.js <id> "<pw>"`) ou créer les comptes (`--add`), puis `npm run harden` (supprime les comptes démo dont le mot de passe est resté `hadj-<id>`). **Cible : SSO OIDC/SAML + MFA** (le PIN soignant est déjà maquetté). |
| **CORS** | `HADJ_CORS_ORIGINS=https://hadj.mon-hopital.fr` |
| **Chiffrement au repos** | Chiffrement du volume (LUKS / BitLocker), SQLCipher, ou base managée chiffrée. |
| **Réseau** | VLAN dédié aux générateurs, la passerelle est le **seul** pont vers le SI. Jamais de générateur exposé à Internet. |

Copiez `server/.env.example` → `.env` et renseignez les variables.

---

## 2. Connecter un premier générateur (lecture seule)

Ordre recommandé — **un seul appareil d'abord** :

1. **Installer les libs de protocole** nécessaires : `npm i serialport modbus-serial node-opcua`
   (uniquement celles utilisées ; elles sont en `optionalDependencies`).
2. **Device Center → « + Ajouter une source de données »** (rôle ADMIN / TECHNICIEN) :
   machine → protocole **vérifié pour ce modèle** (voir `connectors/README.md`) →
   paramètres → **Tester la connexion** (tentative réelle) → **Autoriser**.
   La config est écrite dans `connectors/connectors.config.json` et les connecteurs
   sont rechargés à chaud.
3. **Porte de sécurité biomédicale** : ouvrir la fiche de l'appareil, cocher les
   **13 contrôles** (fabricant / modèle / interface / protocole / lecture seule /
   mapping données / unités / horodatage / mapping alarmes / gateway / revue
   sécurité / approbation biomédicale / test réalisé) → **APPROVED** → **ACTIVE**.
   L'appareil ne passe `CONNECTED` qu'une fois **ACTIVE** *et* des données réelles reçues.
4. Vérifier dans *Device Center* : `connectivityStatus = CONNECTED`, `dataType = REAL_DEVICE`,
   et la **provenance par paramètre** (valeur / source / protocole / gateway / qualité).
5. Le bandeau de mode global passe **🟠 MIXTE** puis **🔴 LIVE** quand tous les feeds sont réels.

> **Ne jamais** activer un connecteur dont l'interface/protocole n'est pas confirmé
> pour le couple fabricant/modèle exact. Vendeur propriétaire → adaptateur dédié.

---

## 3. Environnements

| Niveau | Équipement | Usage |
|---|---|---|
| **1 — Simulateur** | aucun | démo, formation (badge « SIMULATION » permanent) |
| **2 — Hardware-in-the-loop** | banc de test constructeur ou interface approuvée | qualification du connecteur |
| **3 — Clinique** | générateurs réels | déploiement progressif sous validation biomédicale |

Ne jamais tester un connecteur inconnu sur un générateur relié à un patient.

---

## 4. Conformité (avant données patient réelles)

- Analyse de risque **dispositif médical** (IEC 62304, ISO 14971, IEC 62366 UX),
  dossier de conception, gestion des changements.
- Hébergement **HDS** (France) + convention, PCA/PRA, sauvegardes chiffrées testées.
- Rétention / purge **RGPD**, registre des traitements, base légale, DPO.
- Horodatage qualifié + export signé de l'audit trail (chaîne SHA-256 déjà en place).
- SAST/DAST, `npm audit`, pentest externe.
- Plan de réponse à incident + notification CNIL / ANSM le cas échéant.

Détail et matrice des permissions : **`SECURITY.md`**.

---

## 5. Reste hors périmètre applicatif

**Passerelle biomédicale comme process séparé + buffer store-and-forward** : à
déployer entre les machines et cette API (isolation réseau, bufferisation locale
pendant une coupure Internet, synchro sécurisée au rétablissement). Décision
d'architecture de déploiement — la couche connecteurs actuelle en tient lieu tant
que l'API tourne sur un serveur local du service.
