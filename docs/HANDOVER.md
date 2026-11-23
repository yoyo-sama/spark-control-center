# Handover — Spark Control Center

> Document de passation : tout ce qu'un autre assistant (ou un humain) doit savoir pour reprendre le projet
> à froid. **À tenir à jour à chaque changement notable** (voir `CLAUDE.md`).
> Dernière mise à jour : 2026-11-23, sur `main` = `0ee2b1d` (merge de la PR #6) + PR #7 (carte thermique).

## 1. En une phrase

Portail web de contrôle pour une station **DGX Spark (puce GB10)** : réglage de la machine (plafonds
GPU/CPU, swap, thermique), configuration des apps IA installées sur l'hôte (ComfyUI, opencode, Claude Code,
skills partagés), gestion des conteneurs Docker, mises à jour système, le tout depuis le navigateur.

- Dépôt : `yoyo-sama/spark-control-center` (propriétaire : Lionel, GitHub `yoyo-sama`).
- Lectures de référence : `README.fr.md` (fonctionnalités, installation, API) et
  `TOUR-DE-CONTROLE-CHANGELOG.md` (journal détaillé des chantiers, raisons des choix, tests en attente).

## 2. Conventions de travail

- **Lionel écrit en français : répondre en français.** Messages de commit en français, à l'indicatif,
  décrivant l'effet (« Ajoute… », « Corrige… », « Rend… »). Commentaires en anglais dans `backend/`,
  `frontend/` et `host/`, en français dans `docker-compose.yml` et `.env.example`.
- Le changelog `TOUR-DE-CONTROLE-CHANGELOG.md` reçoit une entrée datée pour chaque chantier notable
  (origine, choix, ce qui a été vérifié, ce qui reste à faire). Les tests réels non joués sont marqués
  `⏳ TEST EN ATTENTE`.
- Deux READMEs à garder synchrones : `README.md` (EN) et `README.fr.md`.
- **`sudo` sur le GB10 demande le mot de passe de Lionel** : l'assistant ne l'exécute pas, il donne la
  commande exacte et Lionel la lance. `docker` marche sans `sudo`.
- Principe d'affichage constant : **un interrupteur ne ment jamais**. L'état réel de la machine est relu et
  comparé au désiré ; jamais d'état « actif » sur la seule foi d'une écriture.
- Une modification de fichier de config passe toujours par le pipeline aperçu → diff → avertissements →
  confirmation → écriture atomique + `.bak` horodaté + vérification de hash. Ce qui ne peut pas être édité
  sûrement est **refusé** avec la correction à faire, jamais deviné.

## 3. Architecture

Un **conteneur unique** (service compose `app`, conteneur `spark-control-center-app-1`) : backend
Node/Express qui sert l'API, le WebSocket du terminal et le frontend statique buildé.

| Couche | Techno |
|---|---|
| Frontend | React 19, Vite, TypeScript, Tailwind v4, xterm.js, Recharts, Lucide |
| Backend | Node.js, Express 5, dockerode, ws, SSE |
| Image | `Dockerfile` multi-stage, base **`node:20-slim`** (aucun usage de `node:sqlite`, vérifié 2026-11-13 : passer à Node 24 n'est pas urgent) |
| Hôte | scripts + unités systemd sous `host/`, installés à la main par Lionel |

Points clés de `docker-compose.yml` : bind **`127.0.0.1:8081:3001`** (pas d'authentification, choix assumé),
`pid: host`, `/var/run/docker.sock`, `/sys` en lecture seule sur `/host/sys`, `/etc/gb10-tuning` en
lecture-écriture, répertoires des outils sous `${SPARK_HOME:-$HOME}` montés au même chemin des deux côtés,
réservation GPU nvidia. `SPARK_HOME` est optionnel (voir `.env.example`).

### Fichiers clés

```
backend/
  index.js      API conteneurs, système, déploiement GitHub (SSE), terminal WS, montage des routeurs
  gb10.js       /api/gb10 : état désiré/réel, défaut plafond GPU 2100 MHz, statuts de divergence
  cpufreq.js    lecture des gros cœurs X925 (scaling_max_freq / cur_freq via /host/sys)
  thermal.js    GET /api/gb10/thermal : ventilateurs ACPI, zones thermiques, versions BIOS/EC (lecture seule)
  apps.js       /api/apps : registre ComfyUI / opencode / Claude Code + pipeline d'édition
  skills.js     /api/skills : skills partagés opencode / Claude Code
  insights.js   /api/insights : moteur de constats ; rules.js = catalogue des règles
  ports.js      /api/ports : changer le port publié d'un conteneur (édite la ligne ports: du compose)
  hostports.js  ports d'écoute des conteneurs host-network via /proc
  machine.js    /api/machine : identité machine (marque, modèle, série, OS…)
  updates.js    /api/updates : mises à jour apt (lit les fichiers écrits par l'hôte)
  metrics.js    métriques système / GPU / conteneurs
  *.test.js     tests node --test (fixtures dans backend/fixtures/)
frontend/src/
  App.tsx, components/Sidebar.tsx      navigation : GB10, Apps, Conteneurs, DGX Dashboard
  components/Gb10.tsx                  cartes de réglage (Désiré / Réel / badge)
  components/Apps.tsx, *Panel.tsx      onglets par app, SkillsPanel, Insights
host/
  gb10-tuning/  apply.py (+ test_apply.py), gb10-tuning.path/.service, gb10-thermal-monitor.service
  dgx-updates/  dgx-updates.sh + .service + .timer (horaire)
```

### Les deux flux hôte ↔ app

1. **Réglages GB10 (app → hôte)** : l'app écrit `/etc/gb10-tuning/state.json` → `gb10-tuning.path`
   déclenche `gb10-tuning.service` (oneshot root) → `apply.py` valide par **liste blanche stricte** et
   applique (argv construits en code, `shell=False`) → écrit `result.json` (liste `{key, status, detail}`),
   relu par l'app. Seuls les réglages explicitement posés sont persistés. Clés : plafond GPU
   (`gpuClockLimitMhz`), plafond CPU X925 (`cpuBigCoreMaxMhz`, plancher 2808), persistance, swap,
   `vm.swappiness`, monitoring thermique. `GB10_STATE_DIR` / `GB10_DRY_RUN=1` pour tester sans `/etc`.
2. **Mises à jour système (hôte → app, sens unique)** : `dgx-updates.timer` écrit
   `/var/lib/spark-control-center/updates.json` ; l'app lit aussi
   `/var/lib/update-notifier/updates-available`. L'app n'installe rien. On n'utilise **pas** l'API du DGX
   Dashboard (auth propre, `127.0.0.1` seulement).

## 4. Déploiement sur le GB10

- Checkout : **`~/spark-control-center`** (déplacé depuis `~/Téléchargements` le 2026-11-14). Dossier
  approuvé pour l'assistant sur l'appareil de Lionel : `/home/spark/spark-control-center`.
- Mise à jour de l'app : `cd ~/spark-control-center && git pull && docker compose up -d --build`
  → conteneur `spark-control-center-app-1`, UI sur `http://localhost:8081`.
- Côté hôte (installé par Lionel avec `sudo`, commandes exactes dans `README.fr.md`) :
  - `/usr/local/sbin/gb10-apply.py` (copie de `host/gb10-tuning/apply.py`) +
    `/etc/systemd/system/gb10-tuning.{path,service}` ; la version de la PR #4 est installée depuis le
    2026-11-13 (sauvegardes `.bak-20261113`).
  - `/usr/local/sbin/dgx-updates.sh` + `dgx-updates.{service,timer}`.
  - Après un changement de `apply.py`, d'une unité ou de `dgx-updates.sh` : réinstaller puis
    `sudo systemctl daemon-reload`. Un `git pull` seul ne suffit pas pour ces fichiers.

## 5. Faits matériels vérifiés (GB10 de Lionel)

- Gros cœurs **Cortex-X925 = `cpu5-9`, `cpu15-19`**, max **3900 MHz** ; cœurs **A725 max 2808 MHz** ;
  pilote `cppc_cpufreq` (vérifié 2026-11-13).
- `nv-cpu-governor` : oneshot `Type=idle` au boot qui ne fait que `cpupower frequency-set -g performance` ;
  il ne touche pas `scaling_max_freq`. `gb10-tuning.service` est quand même `After=nv-cpu-governor.service`.
- GPU : horloges de départ 2418 MHz applicatif / 3003 MHz max ; `Power Limit: N/A` → le plafond d'horloge
  est le seul levier de puissance. Certains firmwares ignorent `nvidia-smi -lgc`, d'où la relecture.
- Cause des freezes sous charge : pic de puissance 14 W → 85 W (protection de surintensité), pas un
  throttle thermique.
- Machine : **Dell Pro Max with GB10** (carte 038RY7), pas la DGX Spark FE (P4242) : les pilotes
  ventilateurs communautaires visant la P4242 ne s'appliquent pas. **BIOS 5.36_5.0.0** (28/10/2026,
  installé le 2026-11-21), **EC `0x02000d00`** (lu par l'ESRT, GUID `78c7f535-…`).
- Depuis le BIOS 5.0 : deux ventilateurs ACPI `\_SB.FAN0/FAN1` (`PNP0C0B`, hwmon `acpi_fan`, ~2000 tr/min
  au repos) et un cooling device « Fan » 0–100 écrivable par root ; 7 zones ACPI (`TSOC`, `TS0E`, `TS0P`,
  `TS1E`, `TS1P`, `TGPU`, `TUNC`) avec un seul trip critique à 104,8 °C, aucun ventilateur lié : **l'EC
  ventile seul**. Test du 2026-11-23 : `cur_state` à 50 puis 100 (~40 s) sans hausse de tr/min observée
  côté app ni à l'oreille (Lionel) → **ignoré par l'EC : pas de pilotage des ventilateurs possible** avec
  ce firmware. À retester à chaque nouvelle version d'EC.

## 6. Décisions prises

**Module Agents (OpenClaw + Hermes via NemoClaw)** — décisions de Lionel du 2026-09-24, détaillées dans
`docs/cadrage-module-agents.md` (branche `cadrage/module-agents`, PR #1) :
- Une **seule route d'inférence partagée** (un gateway) par les deux agents pour le MVP ; l'UI devra plus
  tard permettre d'ajouter/créer un second gateway (rattacher un agent recrée son sandbox : destructif, job
  confirmé).
- Les UIs d'agent (OpenClaw) sont servies sur une **origine séparée** (port dédié derrière Tailscale Serve)
  et intégrées en **iframe**, `frame-ancestors` limité au control center, bouton « ouvrir dans un onglet ».
  **Jamais** de proxy same-origin `/agents/<id>/ui/` : le contenu de l'agent atteindrait l'API de l'app,
  qui a `docker.sock` (= root).
- **Hermes** : intégration via son API + lien vers son dashboard.
- Faits d'exploration : les sandboxes sont des conteneurs Docker simples (pas de k3s), dockerode suffit pour
  état/logs, start/stop passent par la CLI `nemoclaw` (sortie JSON), l'UI OpenClaw envoie
  `X-Frame-Options: DENY`, configs dans des volumes Docker.

**Autres** : pas d'authentification en v1 (bind localhost, pas de CORS, WebSocket filtré sur `Origin`) ;
conteneur non privilégié ; défaut plafond GPU 2100 MHz, CPU 3000 MHz suggéré.

## 7. État actuel (2026-11-23)

| PR | Branche | État |
|---|---|---|
| #4 Plafond CPU X925 | `claude/project-thread-87ri6q` | **Mergée** 2026-11-13, déployée sur le GB10 le 2026-11-14. **Jamais appliquée** : Lionel doit cliquer `Apply` à 3000 dans la carte « CPU clock cap » puis suivre le protocole « ⏳ TEST EN ATTENTE — plafond CPU » du changelog. |
| #7 Carte « Thermal & fans » | `claude/project-thread-glt4i6` | **Ouverte**, déployée sur le GB10 le 2026-11-23. Lecture seule ; pilotage des ventilateurs écarté (l'EC ignore `cur_state`). |
| #6 Handover | `claude/project-thread-xxhyez` | **Mergée** 2026-11-23. |
| #5 Màj en locale fr + badges | `claude/project-thread-yb6hsc` | **Mergée**. Compteurs/liste apt lus avec `LC_ALL=C` (un GB10 en `fr_FR` affichait « à jour » à tort) ; badge « Configured » et mention de la valeur suggérée sur les plafonds. Après merge : réinstaller `dgx-updates.sh` sur l'hôte. |
| #3 Montage `.claude.json` | `claude/project-thread-iwzm9h` | Ouverte. Empêche Docker de créer `~/.claude.json` en répertoire. |
| #2 Benchmarks AIPerf | `claude/clever-volta-bglwf1` | Ouverte, antérieure à #4 (à rebaser). |
| #1 Cadrage module Agents | `cadrage/module-agents` | Ouverte, document seul, antérieure à #4. |
| — | `claude/magical-goldberg-naini4` | Pas de PR : #2 + exploration OpenClaw/Hermes dans Apps (panneaux, édition des fichiers markdown). Antérieure à #4. |

Tests réels en attente sur le GB10 : plafond GPU (protocole du 2026-09-12 dans le changelog, jamais joué)
et plafond CPU (protocole du 2026-11-13).

Les sorties brutes de l'exploration NemoClaw (`docs/exploration-agents/`) n'ont jamais été commitées et
n'apparaissaient plus dans `~/spark-control-center` au 2026-11-23 (sans doute restées dans l'ancien
checkout de `~/Téléchargements`) ; l'essentiel est repris dans le document de cadrage.

## 8. Travaux candidats

- Scaffold de dev Docker (`docker-compose.dev.yml`).
- Conflits de ports avec les **processus hôte** (étendre `hostports.js`, aujourd'hui limité aux conteneurs
  host-network ; la règle `container-port-conflict` existe déjà dans `rules.js`).
- Diagnostics des pièges connus dans `rules.js` (ex. alerte sur la zone thermique la plus chaude de
  `/sys/class/thermal` : la machine peut s'éteindre vers 90 °C sans log, idée du fil NVIDIA 387929).
- Test manuel du plafond GPU sur le GB10 (voir plus haut). Le fil NVIDIA situe l'optimum Wh/token vers
  1800 MHz.
- Module Agents : planification pas encore commencée.

## 9. Tester

```bash
cd backend && node --test               # suite backend, aucune installation hors npm
python3 host/gb10-tuning/test_apply.py  # script root côté hôte
cd frontend && npm run build && npm run lint
```

Dev local hors Docker : `backend` → `npm start` (3001), `frontend` → `npm run dev` (5173, proxy `/api`).
