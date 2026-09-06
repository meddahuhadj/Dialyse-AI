# HADJ – Dialysis Intelligence Platform 🩺⚡

> **Plateforme IA d'Assistance Clinique & Jumeaux Numériques pour l'Hémodialyse**  
> Surveillance temps réel de la flotte de générateurs, détection prédictive d'alarmes, interopérabilité HL7 FHIR R4 et support PWA (Progressive Web App) offline-first.

---

## 🌟 Fonctionnalités Clés

- 🖥️ **Jumeaux Numériques (Digital Twins)** : Suivi en direct des paramètres critiques de séance ($Q_b$, $P_{ven}$, $P_{art}$, $PTM$, dialysat, volume UF, conductivité).
- 🚨 **Intelligence des Alarmes (AlarmAI)** : Détection de grappes d'alarmes (clustering causal) et réduction de la fatigue d'alarme.
- 🛠️ **Maintenance Prédictive & Traçabilité** : Calcul de score de santé des générateurs et audit trail chaîné infalsifiable.
- 🖧 **Connecteurs Matériels Réels (Lecture Seule)** :
  - **HL7 v2 MLLP** : Fresenius 5008 / Nexadia / TDMS, B. Braun DASH
  - **OPC-UA** : Fresenius 6008 CAREsystem
  - **TCP ASCII** : Baxter Artis / Exalis, B. Braun Dialog iQ
  - **Série RS-232 / USB** : Nipro Surdial, Gambro AK, Nikkiso DBB, Toray
  - **Modbus TCP** : B. Braun, automates de traitement d'eau / osmoseurs
  - **File-Poll** : Partages réseau CSV/JSON Exalis & TDMS
  - **HL7 FHIR R4** : Connecteur DPI / DPH hospitalier
- 📱 **PWA (Progressive Web App)** :
  - Installable sur Android, iOS (Safari) et Desktop (Chrome, Edge).
  - Coquille applicative mise en cache par Service Worker (`sw.js`) pour fonctionnement hors-ligne (Offline-first).

---

## 🚀 Déploiement Rapide sur Render.com

Ce dépôt contient un fichier [`render.yaml`](./render.yaml) pré-configuré pour un déploiement automatisé :

1. Connectez-vous sur **[Render.com](https://dashboard.render.com)**.
2. Cliquez sur **New +** → **Blueprint** (ou **Web Service**).
3. Sélectionnez ce dépôt GitHub : `Dialyse-AI`.
4. Render détectera automatiquement la configuration :
   - **Runtime** : Node
   - **Build Command** : `npm run build`
   - **Start Command** : `npm start`
   - **Variable requise** : `NODE_VERSION=22.12.0` (moteur `node:sqlite` natif)
5. Cliquez sur **Apply** / **Deploy**. L'application sera disponible sur `https://votre-app.onrender.com` avec HTTPS automatique.

---

## 💻 Démarrage en Local

### Prérequis
- **Node.js** >= 22.5.0 (recommandé : Node 22.x LTS ou 24.x)
- **npm** >= 10.x

### Installation & Lancement

```bash
# 1. Installer les dépendances
npm run build

# 2. Démarrer le serveur
npm start

# L'application est accessible sur :
# Interface Clinique : http://localhost:4310
# Documentation API : http://localhost:4310/api/docs
```

---

## 🔒 Sécurité & Réglementation Biomédicale

- **Mode Lecture Seule Stricte** : Aucune commande n'est envoyée vers les générateurs de dialyse physiques (sécurité patient absolue).
- **Architecture Offline-first** : Aucune donnée patient confidentielle n'est stockée dans le cache du Service Worker.
- **Failover Automatique** : Bascule transparente entre données réelles et simulateur en cas de coupure de liaison machine.

---

## 📄 Licence
Tous droits réservés © HADJ Dialysis Intelligence.
