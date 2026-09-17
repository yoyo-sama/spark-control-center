# Spark Control Center

[![en](https://img.shields.io/badge/lang-en-red)](README.md) [![fr](https://img.shields.io/badge/lang-fr-blue)](README.fr.md)

Spark Control Center est un portail web de contrôle pour une station DGX Spark (puce GB10) : réglage de la machine, configuration des apps IA qui tournent dessus, et gestion de ses conteneurs Docker, le tout depuis le navigateur.

![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white) ![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)

## Fonctionnalités

La barre latérale comporte quatre sections :

- **GB10** — la vue d'accueil, étiquetée dynamiquement avec le nom de la machine détectée. Réglage GPU et thermique :
  - **Réglages** : plafond d'horloge GPU, mode persistance, swap, `vm.swappiness`, monitoring thermique
  - **Un interrupteur ne ment jamais** : chaque réglage désiré est comparé à ce que la machine rapporte réellement, avec un état explicite par réglage (`ok`, `pending`, `failed`, `skipped`, `diverged`, `unverified`, `unset`) — certains firmwares GB10 ignorent silencieusement `nvidia-smi -lgc`, et une interface qui se contenterait de renvoyer la demande mentirait
  - **Uniquement ce que vous posez** : les réglages auxquels l'utilisateur n'a pas touché ne sont pas persistés
  - **Conteneur non privilégié** : il ne fait qu'écrire un JSON d'état désiré qu'un oneshot systemd root valide contre une liste blanche stricte et applique (détails plus bas sous « Réglages GB10 »)
- **Apps** — lit et modifie chirurgicalement la configuration des outils IA installés sur l'hôte :
  - **ComfyUI** : les flags de ligne de commande de son `compose.yaml`, et ses scripts utilisateur
  - **opencode** (`opencode.json`) : modèle par défaut, `limit.context`, compaction, chemins/urls de skills
  - **Claude Code** : fichiers de settings, plugins, serveurs MCP, hooks — en lecture seule sauf une courte liste blanche de clés inoffensives
  - **Pipeline d'édition** : aperçu → diff ligne à ligne → avertissements → confirmation explicite → écriture atomique préservant le propriétaire et les droits du fichier, avec un `.bak` horodaté et une vérification par hash de contenu qui refuse un aperçu si le fichier a changé entretemps. Les secrets sont masqués
  - **Gestionnaire de skills partagés** : les mêmes skills sont chargés par opencode et par Claude Code, donc les doublons entre racines sont signalés
  - **Moteur d'insights** : signale les vrais problèmes de cette machine (les règles vivent dans `backend/rules.js`) plutôt que de lister un catalogue
- **Conteneurs**
  - **Liste des conteneurs** : statut, image, politique de redémarrage, **répertoire de lancement** (bind mounts hôtes + WorkingDir) et **lien direct vers l'app** pour chaque port TCP publié
  - **Auto-détection des ports host-network** : les apps en `network_mode: host` (sans ports publiés) voient leurs ports d'écoute détectés via `/proc` (croisement inodes sockets ↔ tables TCP)
  - **Détail conteneur** : stats CPU/RAM (mémoire CPU + VRAM GPU), réseau, graphiques d'historique, configuration (commande, ports, montages)
  - **Terminal interactif** : shell in-browser (xterm.js + WebSocket) dans n'importe quel conteneur actif, avec détection automatique bash/sh et redimensionnement
  - **Déploiement GitHub** : clone → build → run d'un dépôt directement depuis l'UI, avec logs en direct (SSE), timeout et nettoyage automatique
  - **Actions** : start / stop / restart / delete avec confirmation
- **DGX Dashboard** — le propre dashboard NVIDIA de la machine, embarqué

En dehors de cette navigation :

- **Dashboard système** : CPU, mémoire, disque, GPU NVIDIA (via `nvidia-smi`), compteurs conteneurs/images/volumes, graphiques temps réel avec dégradés
- **Mises à jour système** : lues depuis apt — compteurs et liste par paquet, en lecture seule (l'installation reste sur l'hôte)
- **Détection automatique de l'identité machine** : vendeur, modèle, BIOS, numéros de série, plateforme DGX, puce, OS, interfaces réseau — ce qui rend l'app portable sur une autre DGX Spark quelle que soit sa marque — le répertoire personnel est détecté automatiquement, la variable `SPARK_HOME` n'est qu'une surcharge
- **Thème sombre / clair** : interface monochrome moderne (police Inter, icônes Lucide, JetBrains Mono pour les données techniques), bascule persistée et défaut selon la préférence système

## Stack

| Composant | Technologies |
|---|---|
| Frontend | React 19, Vite, TypeScript, TailwindCSS v4, xterm.js, Recharts, Lucide |
| Backend | Node.js, Express 5, dockerode, ws (WebSocket), SSE |
| Packaging | Image Docker unique multi-stage (build frontend + backend + compression gzip) |

## Installation

### Prérequis

- [Docker Engine](https://docs.docker.com/get-docker/) ≥ 20.10 avec [Compose v2](https://docs.docker.com/compose/) (`docker compose`)
- Le socket Docker `/var/run/docker.sock` doit être accessible à l'utilisateur qui lance le compose (le backend y accède via un bind mount)
- *(Optionnel)* Pilotes NVIDIA + [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) pour les métriques GPU

### Installer et démarrer

```bash
# 1. Cloner le repo
git clone https://github.com/yoyo-sama/spark-control-center.git
cd spark-control-center

# 2. Construire et démarrer (aucune variable d'environnement requise)
docker compose up -d --build
```

L'application est disponible sur **http://localhost:8081**.

Tout tourne dans un **conteneur unique** : le backend Node sert à la fois l'API (y compris le terminal WebSocket) et le frontend statique.

### Sans GPU NVIDIA

Le `docker-compose.yml` réserve les GPU via `deploy.resources` (runtime nvidia). Sans GPU — ou sans nvidia-container-toolkit — retirez ce bloc :

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

Tout le reste fonctionne normalement ; la section GPUs reste simplement vide.

### Mettre à jour

Les conteneurs ne se mettent jamais à jour eux-mêmes : ils continuent de tourner sur l'image avec laquelle ils ont été démarrés. Pour mettre à jour une installation existante :

```bash
cd spark-control-center

# 1. Récupérer le dernier code
git pull

# 2. Reconstruire l'image et redémarrer le conteneur
docker compose up -d --build
```

`docker compose up -d --build` s'occupe de tout : il reconstruit l'image unique à partir des nouvelles sources (frontend + backend), arrête le conteneur obsolète et en démarre un nouveau, en réutilisant les réglages de `docker-compose.yml` (socket Docker, `pid: host`, réservation GPU, mappage de port).

La mise à jour est sans risque pour votre environnement :
- l'application est **sans état** (pas de base de données, aucune donnée locale à sauvegarder)
- les conteneurs qu'elle gère ne **sont pas affectés** — ils continuent de tourner pendant la mise à jour
- votre préférence de thème est stockée dans le navigateur et survit aux mises à jour

Vérifier la mise à jour :

```bash
docker compose ps        # le conteneur app doit être "Up"
git log --oneline -1     # version installée
```

Pour revenir à une version précédente :

```bash
git checkout <hash-du-commit>
docker compose up -d --build
```

### Arrêter

```bash
docker compose down
```

### Configuration

Aucune configuration n'est nécessaire. Variables optionnelles (via `environment:` du service `app` dans le compose) :

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3001` | Port interne du serveur (sert l'API et le frontend) |

> Pour exposer l'UI sur un autre port que 8081, modifiez la section `ports:` du service `app` (ex: `"9090:3001"`).

## Réglages GB10

### Le principe

Le conteneur reste **non privilégié** : l'app écrit `/etc/gb10-tuning/state.json`, l'unité systemd `gb10-tuning.path` détecte le changement et déclenche `gb10-tuning.service` (un oneshot exécuté en root) qui applique les réglages et écrit `result.json`, relu par l'app pour afficher l'état réel.

### Avertissement de sécurité

L'app n'a **pas d'authentification** (choix assumé de la v1) et ce JSON pilote des commandes root — d'où le bind sur `127.0.0.1` et la validation par liste blanche stricte dans `apply.py`.

### Installation

```bash
sudo install -d -m 755 /etc/gb10-tuning
sudo install -m 755 host/gb10-tuning/apply.py /usr/local/sbin/gb10-apply.py
sudo install -m 644 host/gb10-tuning/gb10-tuning.path \
                    host/gb10-tuning/gb10-tuning.service \
                    host/gb10-tuning/gb10-thermal-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gb10-tuning.path gb10-tuning.service
```

`gb10-thermal-monitor.service` pointe sur `thermal-monitor.sh` par un chemin absolu : systemd n'expanse pas `$HOME`, adaptez donc cette ligne `ExecStart=` à la machine avant d'installer l'unité.

### Désinstallation

```bash
sudo systemctl disable --now gb10-tuning.path gb10-tuning.service
sudo nvidia-smi -rgc
```

`nvidia-smi -rgc` rend au GPU ses horloges d'usine.

### Réglages v1 et effets mesurés

| Réglage | Effet mesuré |
|---|---|
| Cause racine des crashs | Un pic de puissance de 14 W à 85 W déclenche la protection de surintensité — **pas** un throttle thermique |
| Plafond d'horloge à 2100 MHz | Pics à 85 W ramenés à 50 W stable, 72–79 °C, plus de crash |
| Plafond à 2200 MHz (variante) | −12 °C, −36% de puissance, au coût de 1% en décodage et 3,9% en préfill |
| Limite de puissance | `nvidia-smi -q -d POWER` renvoie `Power Limit: N/A` sur ce GPU — le plafond d'horloge est le **seul** levier, aucune limite en watts n'est réglable |
| `CUDA_CACHE_MAXSIZE=4294967296` | 20 s/step → 6,6 s/step (×3) |

### Avertissement swap

`swapoff` sous pression mémoire peut déclencher un OOM kill — d'où le garde-fou (refus si plus de 512 MiB de swap sont actuellement utilisés).

### Réserve d'honnêteté

Certaines unités GB10 ignorent `nvidia-smi -lgc` selon leur firmware — l'UI compare donc l'état désiré à l'état réel et signale toute divergence.

### Variables d'environnement

- Recommandées : `CUDA_CACHE_MAXSIZE=4294967296`, `NCCL_P2P_DISABLE=1`
- À bannir : `CUDA_CACHE_DISABLE=1`, `PYTORCH_NO_CUDA_MEMORY_CACHING=1` (fragmentation mémoire et OOM)

### `GB10_STATE_DIR`

Cette variable d'environnement surcharge le répertoire d'état (backend et script), ce qui permet de tester sans toucher `/etc`.

## Mises à jour système

### Le principe

Les endpoints `/api/v1/updates/*` du DGX Dashboard exigent leur propre authentification et n'écoutent que sur `127.0.0.1`, injoignable depuis ce conteneur — la console lit donc la vraie source : apt, via les fichiers déjà entretenus par l'hôte.

Le flux est **à sens unique, hôte → app** : `dgx-updates.timer` tourne chaque heure sur l'hôte et écrit `/var/lib/spark-control-center/updates.json`, que cette app ne fait que lire. Contrairement au pipeline `gb10-tuning`, rien de ce que l'app écrit ne déclenche jamais de commande côté hôte : aucune liste blanche n'est nécessaire ici.

- Les compteurs (`85 mises à jour`, `14 de sécurité`) viennent directement de `/var/lib/update-notifier/updates-available`, entretenu par `apt-daily.timer`.
- La liste par paquet (nom/version actuelle/candidate) vient de `updates.json`, entretenu par `dgx-updates.timer` ci-dessous.
- L'installation des mises à jour se fait toujours via le DGX Dashboard ou `apt` sur l'hôte — pas depuis cette console.

### Installation

```bash
sudo install -m 755 host/dgx-updates/dgx-updates.sh /usr/local/sbin/dgx-updates.sh
sudo install -m 644 host/dgx-updates/dgx-updates.service \
                    host/dgx-updates/dgx-updates.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dgx-updates.timer
```

### Désinstallation

```bash
sudo systemctl disable --now dgx-updates.timer
sudo rm /usr/local/sbin/dgx-updates.sh /etc/systemd/system/dgx-updates.service /etc/systemd/system/dgx-updates.timer
```

### Variables d'environnement

- `UPDATES_OUT` (script) : surcharge le chemin de sortie JSON, pour tester sans toucher `/var/lib`.
- `UPDATE_NOTIFIER_FILE`, `APT_STAMP_FILE`, `UPDATES_JSON` (backend) : surchargent les trois chemins d'entrée, pour tester.

Sans le timer installé, `/api/updates` renvoie quand même 200 avec `pipelineInstalled: false` et une `note` expliquant l'absence de la liste des paquets — les compteurs de synthèse (qui ne dépendent pas du timer) restent inchangés.

## Structure

```
├── backend/
│   ├── index.js        # API REST, WebSocket exec, déploiement GitHub, fichiers statiques
│   ├── gb10.js         # État désiré/réel GB10
│   ├── apps.js         # Registre des apps + pipeline d'édition
│   ├── skills.js       # Gestionnaire de skills partagés
│   ├── insights.js     # Moteur d'insights
│   ├── rules.js        # Catalogue de règles d'insights
│   ├── machine.js      # Identité machine
│   ├── updates.js      # Mises à jour système
│   ├── hostports.js    # Détection des ports d'écoute (conteneurs host-network)
│   ├── metrics.js      # Métriques système / GPU / stats conteneurs
│   ├── *.test.js       # Suites de tests (node --test)
│   └── fixtures/       # Fixtures de test
├── frontend/
│   ├── src/
│   │   ├── components/ # Dashboard, ContainerDetail, Terminal, DeployModal…
│   │   ├── lib/        # hook de thème dark/light
│   │   ├── types.ts
│   │   └── App.tsx
│   └── vite.config.ts  # Proxy /api pour le dev local
├── host/
│   ├── gb10-tuning/    # apply.py + son test, unités systemd .path/.service
│   └── dgx-updates/    # Script de snapshot, service et timer systemd
├── Dockerfile          # Image unique multi-stage (build frontend + backend)
└── docker-compose.yml
```

## API

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/containers` | Liste des conteneurs (+ ports détectés, répertoires) |
| GET | `/api/containers/:id` | Détail d'un conteneur |
| GET | `/api/containers/:id/stats` | Stats live (CPU/RAM/réseau/VRAM) |
| POST | `/api/containers/:id/start\|stop\|restart` | Actions du cycle de vie |
| DELETE | `/api/containers/:id` | Suppression |
| GET | `/api/system` | Métriques système + GPU |
| POST | `/api/deploy/github` | Déploiement d'un repo GitHub |
| GET | `/api/events/deploy/:id` | Logs de déploiement (SSE) |
| GET | `/api/gb10/state` | État désiré + réel GB10 |
| PUT | `/api/gb10/state` | Modifier l'état désiré GB10 |
| POST | `/api/gb10/reapply` | Redéclencher l'application côté hôte |
| GET | `/api/apps` | Résumé du registre des apps |
| GET | `/api/apps/:id` | Détail d'une app (détection, facts) |
| POST | `/api/apps/:id/preview` | Aperçu d'une modification de config (diff + avertissements) |
| POST | `/api/apps/:id/apply` | Appliquer une modification prévisualisée |
| GET | `/api/skills` | Liste des skills sur toutes les racines |
| GET | `/api/skills/:name` | Détail d'un skill |
| POST | `/api/skills/preview` | Aperçu d'un toggle/import de skill |
| POST | `/api/skills/apply` | Appliquer une modification de skill prévisualisée |
| GET | `/api/insights` | Résultats du moteur d'insights |
| GET | `/api/machine` | Identité machine |
| GET | `/api/updates` | Mises à jour système (apt) |
| WS | `/api/exec/:id` | Terminal interactif |

## Développement

Environnement de dev local (hors Docker) :

```bash
# Backend (port 3001)
cd backend && npm install && npm start

# Frontend (port 5173, proxy /api → localhost:3001)
cd frontend && npm install && npm run dev
```

Les tests ne demandent aucune installation, les fixtures sont dans le repo :

```bash
cd backend && node --test              # suite backend
python3 host/gb10-tuning/test_apply.py # script d'apply côté hôte
```

## Note sécurité

L'application n'a **pas d'authentification** et le terminal donne un shell dans les conteneurs. L'app se lie uniquement à `127.0.0.1`, les requêtes cross-origin sont refusées (aucun en-tête CORS n'est envoyé), et les upgrades WebSocket dont l'`Origin` ne correspond pas à l'hôte du serveur sont rejetées — un navigateur n'applique pas de CORS aux WebSockets, donc n'importe quelle page visitée aurait sinon pu ouvrir un shell dans un conteneur. Rien de tout cela n'est de l'authentification : à réserver à un réseau local ou un environnement de confiance ; placez-la derrière un proxy avec authentification si elle doit sortir de la machine.
