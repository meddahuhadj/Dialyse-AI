# HADJ — Connecteurs de données (Phase 3)

Couche d'adaptateurs qui alimente le backend Phase 1 avec des **données réelles**,
quel que soit le modèle de générateur et son protocole de sortie. Sans
configuration, HADJ tourne 100 % simulé (aucune régression Phase 1/2).

## Principe

```
 Générateur / DPI / passerelle          Adaptateur (protocole)         Normalisation                 API Phase 1
 ─────────────────────────────          ──────────────────────         ─────────────                 ───────────
  Fresenius 5008  ──HL7 v2 MLLP────────▶  hl7v2                                                        GET /api/fleet
  Fresenius 6008  ──OPC-UA────────────▶  opcua              raw keys      models.js                    (schéma inchangé,
  Baxter Artis    ──TCP ASCII────────▶  tcp-ascii    ─────▶ (OBX/reg/  ─▶ signalAliases  ─▶  bfr,      + champs
  Gambro AK / Nipro ─RS-232──────────▶  serial              tag/LOINC)    statusAliases      pven,     dataSource,
  B. Braun iQ     ──Modbus TCP───────▶  modbus-tcp                        mapReading()       tmp, …     lastReadingAt)
  TDMS / Exalis   ──fichiers CSV─────▶  file-poll                                            status,
  Middleware FHIR ──FHIR R4 REST─────▶  fhir                                                 currentAlarm
  (aucune source) ───────────────────▶  simulator
```

`ConnectorManager` (`connectors/index.js`) :

1. donne un **`simulator`** à chaque machine → `GET /api/fleet` toujours complet ;
2. démarre en plus l'adaptateur réel de chaque `binding` de `connectors.config.json` ;
3. fusionne chaque lecture dans le tableau `fleet` en mémoire (schéma Phase 1) ;
4. **priorité au live** : les lectures du simulateur sont ignorées tant qu'une
   source réelle a produit une donnée depuis moins de `staleMs` (défaut 15 s).
   Si la source live se tait, la machine repasse automatiquement au simulateur.

`GET /api/connectors` expose l'état par machine (`connected`, `live`, `ageSec`, `lastError`).
`GET /api/connectors/catalogue` expose adaptateurs + modèles.

## Configuration

Copier `connectors.config.example.json` → `connectors.config.json` (git-ignoré) :

```jsonc
{
  "defaultSimulator": true,     // simulateur de repli pour chaque machine
  "staleMs": 15000,             // durée avant de considérer une source live comme muette
  "bindings": [
    { "machineId": "HD-06", "model": "Nipro Surdial X",
      "adapter": "serial", "params": { "path": "COM6", "baudRate": 9600,
                                       "format": "kv", "pairDelim": ",", "kvDelim": ":" } }
  ]
}
```

Variable d'env `HADJ_CONNECTORS` pour pointer un autre chemin de config.

## Adaptateurs (protocoles)

| Adaptateur | Transport | Dépendance | Paramètres clés | Cible typique |
|---|---|---|---|---|
| `simulator` | — | — | `periodMs`, `frozen` | défaut / repli |
| `hl7v2` | MLLP (TCP), HL7 v2 ORU^R01 | aucune | `port`, `deviceMatch`, `ack` | Fresenius Nexadia/TDMS, B. Braun DASH, moteurs d'intégration |
| `fhir` | FHIR R4 REST (polling) | aucune (`fetch`) | `baseUrl`, `deviceId`/`patientId`, `periodMs`, `token` | passerelles d'interopérabilité, Nexadia Expert |
| `tcp-ascii` | Socket TCP, trames ASCII | aucune | `host`+`port` ou `listen`, `format` (`kv`/`csv`/`json`), `delimiter`, `pairDelim`, `kvDelim`, `columns`, `alarmKeys` | Baxter Artis (Exalis), B. Braun iQ, Bellco |
| `serial` | RS-232 / USB-serial | `npm i serialport` | `path` (COM3 / /dev/ttyUSB0), `baudRate`, `delimiter`, `format` … | Nipro, Nikkiso, Gambro AK, Toray, ports service Fresenius |
| `modbus-tcp` | Modbus TCP | `npm i modbus-serial` | `host`, `unitId`, `registers{canonical:{addr,type,scale,signed}}`, `alarmRegister` | B. Braun iQ (service), passerelles IoT, traitement d'eau |
| `file-poll` | Répertoire d'export (CSV/JSON) | aucune | `dir`, `match`, `format`, `delimiter`, `machineField`, `row`, `periodMs` | Fresenius TDMS batch, Gambro/Baxter Exalis, Toray |
| `opcua` | OPC-UA | `npm i node-opcua` | `endpoint`, `nodes{canonical:"ns=..;s=.."}`, `alarmNode`, `periodMs`, `user`/`password` | Fresenius 6008 CAREsystem, gateways edge |

Les dépendances optionnelles ne sont **pas** dans `package.json` : installez-les
seulement si vous utilisez l'adaptateur correspondant. En leur absence l'adaptateur
échoue proprement (message explicite) et la machine reste simulée.

## Modèles pris en charge et protocole de sortie natif

| Clé modèle | Fabricant | Modèles | Protocole(s) de sortie natif(s) | Adaptateur recommandé |
|---|---|---|---|---|
| `fresenius-5008` | Fresenius Medical Care | 4008, 5008, 5008S CorDiax | HL7 v2 ORU^R01 (Nexadia / TDMS) ; RS-232 « F60 / DataLink » ; export CSV/XML TDMS | `hl7v2` (ou `serial`, `file-poll`) |
| `fresenius-6008` | Fresenius Medical Care | 6008 CAREsystem | OPC-UA (« Connectivity eXtension ») ; HL7 v2 / FHIR via Nexadia Expert | `opcua` (ou `fhir`, `hl7v2`) |
| `baxter-artis` | Baxter (ex-Gambro) | Artis, Artis Physio | Flux ASCII Ethernet vers Exalis (TCP proprio) ; HL7 v2 depuis Exalis ; RS-232 service | `tcp-ascii` (ou `hl7v2`, `serial`) |
| `gambro-ak` | Baxter (ex-Gambro) | AK 96, AK 98, AK 200 | RS-232 « Gambro Exalis » ; export CSV Exalis | `serial` (ou `file-poll`) |
| `nipro-surdial` | Nipro | Surdial, Surdial X, Surdial 55Plus | RS-232 ASCII (« Nipro communication protocol ») ; LAN vers Nipro Balance/Future | `serial` (ou `tcp-ascii`) |
| `nikkiso-dbb` | Nikkiso | DBB-07, DBB-EXA, DBB-100 | RS-232 ASCII ; LAN « Future Net Web » (export HL7) | `serial` (ou `hl7v2`) |
| `bbraun-dialog` | B. Braun | Dialog+, Dialog iQ | Interface LAN (TCP proprio JSON/ASCII) vers Nexadia/DASH ; HL7 v2 ; Modbus TCP (service) | `tcp-ascii` (ou `hl7v2`, `modbus-tcp`) |
| `toray-tr` | Toray | TR-8000 | RS-232 ASCII ; export CSV LAN | `serial` (ou `file-poll`) |
| `medtronic-bellco` | Medtronic (Bellco) | Formula, Flexya | Flux ASCII Ethernet ; export CSV | `tcp-ascii` (ou `file-poll`) |
| `generic` | — | tout modèle non listé | selon l'appareil | selon l'appareil |

> ⚠️ Les identifiants exacts (codes OBX, adresses de registres, mnémoniques série,
> nodes OPC-UA) sont **spécifiques à chaque installation** et doivent être confirmés
> auprès du constructeur / de l'intégrateur biomédical. Ils se paramètrent sans
> toucher au code : aliases dans `models.js`, ou `params.registers` / `params.nodes`
> / `params.columns` dans la config.

## Mapping des champs

### Signal canonique → champ machine (`models.js` : `CANONICAL_TO_FIELD`)

| Canonique | Champ machine | Unité | Alias reconnus d'office (insensibles casse/espaces/`_-.`) |
|---|---|---|---|
| `blood_flow` | `bfr` | mL/min | `BFR`, `QB`, `BF`, `BLOOD_FLOW`, `BloodPumpFlow`, LOINC `19991-4` |
| `venous_pressure` | `pven` | mmHg | `PV`, `PVEN`, `VP`, `VENOUS_PRESSURE`, `ReturnPressure`, LOINC `76469-2` |
| `arterial_pressure` | `part` | mmHg | `PA`, `PART`, `AP`, `ARTERIAL_PRESSURE`, `PrePumpPressure`, LOINC `76470-0` |
| `tmp` | `tmp` | mmHg | `TMP`, `PTM`, `TransmembranePressure`, LOINC `76472-6` |
| `uf_rate` | `ufr` | mL/h | `UFR`, `QF`, `UF_RATE`, `UltrafiltrationRate` |
| `uf_volume` | `ufv` | L | `UFV`, `UF`, `UF_TOTAL`, `RemovedVolume`, LOINC `20255-9` |
| `target_uf_volume` | `targetUfv` | L | `UF_TARGET`, `TargetUF`, `UFGoal` |
| `dialysate_conductivity` | `cond` | mS/cm | `COND`, `CD`, `LD`, `Conductivity`, LOINC `19975-7` |
| `dialysate_temp` | `temp` | °C | `TEMP`, `TD`, `DialysateTemp` |
| `machine_state` | `status` | enum | `STATE`, `MODE`, `PHASE`, `TreatmentPhase` → mappé via `statusAliases` |
| `alarm_text` / `alarm_code` | `currentAlarm` + `status=ALARM` | — | `ALARM`, `ALM_TXT`, `ErrorCode`, OBX flags `H/HH/A/AA` |
| `patient_id` | `patientId` | — | `PID`, `PATIENT`, `PatientId` (HL7 PID-3) |

### État machine → `status` (`COMMON_STATUS_ALIASES`, surchargé par `statusAliases`)

`NORMAL` ← run/running/dialysis/treatment/therapy/hd/online/ok · `MONITORING` ←
standby/preparation/priming/rinse/reinfusion/selftest/advisory · `WARNING` ←
warn/warning/caution · `ALARM` ← alarm/fault/error/technical · `OFFLINE` ←
disinfection/cleaning/off/disconnected/shutdown/idle.

Une lecture avec `alarms` non vide force `status=ALARM` + `currentAlarm`
`{id, type, priority, timestamp}`. Une lecture live avec `status` non-ALARM efface
un `currentAlarm` devenu obsolète.

## Ajouter un modèle

`models.js` → `MODELS` :

```js
'monvendor-x': {
  vendor: 'MonVendor', label: 'MonVendor X-1000',
  match: ['x-1000', 'monvendor x'],                 // sous-chaînes testées sur machine.model
  nativeProtocols: ['RS-232 ASCII', 'HL7 v2'],
  adapter: 'serial',
  signalAliases: { qsang: 'blood_flow', pret: 'venous_pressure' },
  statusAliases: { traitement: 'NORMAL', rincage: 'MONITORING' },
}
```

## Ajouter un protocole

1. `adapters/mon-proto.js` : classe qui étend `BaseAdapter`, appelle
   `this._reading({ cle: valeur, ... }, alarms?)` à chaque échantillon, gère
   `start()` / `stop()` et émet `_connected(true/false, err?)`.
2. `registry.js` : `'mon-proto': require('./adapters/mon-proto')`.
3. Documenter ici + dans `connectors.config.example.json`.

## Test rapide d'un flux live

```bash
# config: bind HD-02 → tcp-ascii listen :5599 (voir connectors.config.example.json)
node -e "const s=require('net').connect(5599,'127.0.0.1',()=>s.write('QB=311;PV=176;TMP=93;STATE=RUN\n'))"
curl -s localhost:4310/api/fleet/HD-02        # bfr=311, pven=176, dataSource=tcp-ascii
curl -s localhost:4310/api/connectors         # live:true
```
