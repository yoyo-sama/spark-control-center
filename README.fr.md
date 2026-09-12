# Spark Control Center

[![en](https://img.shields.io/badge/lang-en-red)](README.md) [![fr](https://img.shields.io/badge/lang-fr-blue)](README.fr.md)

Spark Control Center est un gestionnaire Docker web : surveillez et pilotez vos conteneurs depuis le navigateur — dashboard système, terminal interactif, déploiement direct depuis GitHub.

![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white) ![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)

## Fonctionnalités

- **Dashboard système** : CPU, mémoire, disque, GPU NVIDIA (via `nvidia-smi`), compteurs conteneurs/images/volumes, graphiques temps réel avec dégradés
- **Liste des conteneurs** : statut, image, politique de redémarrage, **répertoire de lancement** (bind mounts hôtes + WorkingDir) et **lien direct vers l'app** pour chaque port TCP publié
- **Auto-détection des ports host-network** : les apps en `network_mode: host` (sans port publié) voient leurs ports d'écoute détectés via `/proc` (croisement inodes sockets ↔ tables TCP)
- **Détail conteneur** : stats CPU/RAM (mémoire CPU + GPU VRAM), réseau, graphiques d'historique, configuration (commande, ports, mounts)
- **Terminal interactif** : shell in-browser (xterm.js + WebSocket) dans n'importe quel conteneur actif, avec détection automatique bash/sh et redimensionnement
- **Déploiement GitHub** : clone → build → run d'un repo directement depuis l'UI, avec logs en direct (SSE), timeout et nettoyage automatiques
- **Actions** : start / stop / restart / delete avec confirmation
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
git clone https://github.com/yoyo-sama/docker-manager.git
cd docker-manager

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
cd docker-manager

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
│   ├── hostports.js    # Détection des ports d'écoute (conteneurs host-network)
│   ├── metrics.js      # Métriques système / GPU / stats conteneurs
├── frontend/
│   ├── src/
│   │   ├── components/ # Dashboard, ContainerDetail, Terminal, DeployModal…
│   │   ├── lib/        # hook de thème dark/light
│   │   ├── types.ts
│   │   └── App.tsx
│   └── vite.config.ts  # Proxy /api pour le dev local
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
| WS | `/api/exec/:id` | Terminal interactif |

## Développement

Environnement de dev local (hors Docker) :

```bash
# Backend (port 3001)
cd backend && npm install && npm start

# Frontend (port 5173, proxy /api → localhost:3001)
cd frontend && npm install && npm run dev
```

## Note sécurité

L'application n'a **pas d'authentification** et le terminal donne un shell dans les conteneurs. À réserver à un réseau local ou un environnement de confiance ; placez-la derrière un proxy avec authentification si exposée.
