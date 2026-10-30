# Spark Control Center

[![en](https://img.shields.io/badge/lang-en-red)](README.md) [![fr](https://img.shields.io/badge/lang-fr-blue)](README.fr.md)

Spark Control Center est un portail web de contrôle pour une station DGX Spark (puce GB10) : réglage de la machine, configuration des apps IA qui tournent dessus, et gestion de ses conteneurs Docker, le tout depuis le navigateur.

![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white) ![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)

## Fonctionnalités

La barre latérale comporte cinq sections :

- **GB10** — la vue d'accueil, étiquetée dynamiquement avec le nom de la machine détectée. Réglage GPU et thermique :
  - **Réglages** : plafond d'horloge GPU, mode persistance, swap, `vm.swappiness`, monitoring thermique
  - **Un interrupteur ne ment jamais** : chaque réglage désiré est comparé à ce que la machine rapporte réellement, avec un état explicite par réglage (`ok`, `pending`, `failed`, `skipped`, `diverged`, `unverified`, `unset`) — certains firmwares GB10 ignorent silencieusement `nvidia-smi -lgc`, et une interface qui se contenterait de renvoyer la demande mentirait
  - **Uniquement ce que vous posez** : les réglages auxquels l'utilisateur n'a pas touché ne sont pas persistés
  - **Conteneur non privilégié** : il ne fait qu'écrire un JSON d'état désiré qu'un oneshot systemd root valide contre une liste blanche stricte et applique (détails plus bas sous « Réglages GB10 »)
- **Apps** — lit et modifie chirurgicalement la configuration des outils IA installés sur l'hôte :
  - **ComfyUI** : les flags de ligne de commande de son `compose.yaml`, et ses scripts utilisateur
  - **opencode** (`opencode.json`) : modèle par défaut, `limit.context`, compaction, chemins/urls de skills
  - **Claude Code** : fichiers de settings, plugins, serveurs MCP, hooks — en lecture seule sauf une courte liste blanche de clés inoffensives
  - **OpenClaw** et **Hermes Agent**, avec ou sans **NemoClaw** (exploration, voir plus bas) : comment chaque agent est déployé (sur l'hôte, dans un sandbox NemoClaw, ou les deux, plus ses processus vus dans `/proc`), son modèle confronté à Ollama, les canaux d'OpenClaw et qui peut écrire à l'agent, le backend terminal de Hermes, les skills. Leurs **fichiers markdown** sont éditables — ceux du workspace d'OpenClaw (`AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, notes quotidiennes de `memory/`), `SOUL.md` et `memories/{MEMORY,USER}.md` de Hermes par profil — avec la limite de taille de chaque agent ; leur config reste en lecture seule, avec les commandes pour la modifier
  - **Pipeline d'édition** : aperçu → diff ligne à ligne → avertissements → confirmation explicite → écriture atomique préservant le propriétaire et les droits du fichier, avec un `.bak` horodaté et une vérification par hash de contenu qui refuse un aperçu si le fichier a changé entretemps. Les secrets sont masqués
  - **Gestionnaire de skills partagés** : les mêmes skills sont chargés par opencode et par Claude Code, donc les doublons entre racines sont signalés
  - **Moteur d'insights** : signale les vrais problèmes de cette machine (les règles vivent dans `backend/rules.js`) plutôt que de lister un catalogue
- **Benchmarks** — mesure la vitesse réelle des modèles servis sur la machine, avec [AIPerf](https://github.com/ai-dynamo/aiperf) (NVIDIA ai-dynamo) :
  - **Trois choix et c'est parti** : le serveur (vLLM, SGLang, Ollama, llama.cpp, TGI, NIM… détectés automatiquement, avec leurs modèles), le type de travail (chat, agent de code, résumé, génération longue, RAG) et la charge (un utilisateur, ou un balayage de concurrence pour trouver le meilleur compromis)
  - **En direct** : progression palier par palier, puissance / horloge / température GPU, logs de l'outil
  - **Des résultats lisibles** : débit, temps jusqu'au premier token, latence entre tokens, vitesse par utilisateur, efficacité en tokens par joule, distribution p50 / p90 / p99, courbes du balayage
  - **Le plafond d'horloge GB10 vérifié sous charge** : chaque run note le plafond en vigueur et dit s'il a tenu, s'il a été ignoré par le firmware ou s'il n'a jamais été atteint — la carte GB10 affiche ces mesures
  - **Historique et comparaison** : jusqu'à 4 runs côte à côte avec les écarts en %, et un avertissement quand ils n'ont pas tourné sur la même charge
  - **Registre d'outils extensible** : AIPerf est le premier adaptateur (`backend/benchtools.js`)
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
- l'application n'a **pas de base de données** ; sa seule donnée est l'historique des benchmarks, sur l'hôte dans `/var/lib/spark-control-center/benchmarks` — il survit aux mises à jour
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
| `BENCH_DIR` | `/var/lib/spark-control-center/benchmarks` | Dossier des runs de benchmark (voir « Benchmarks ») |
| `BENCH_PROBE_HOST` | `localhost` (`host.docker.internal` dans le compose) | Hôte par lequel l'app sonde les serveurs d'inférence |
| `AIPERF_VERSION` | `0.13.0` | Version d'AIPerf épinglée |

> Pour exposer l'UI sur un autre port que 8081, modifiez la section `ports:` du service `app` (ex: `"9090:3001"`).

### OpenClaw, Hermes Agent, NemoClaw

Leurs répertoires ne sont **pas montés par défaut** : monter un répertoire qui n'existe pas le fait créer vide et root:root par Docker, ce qui casse ensuite l'installeur de l'outil. Chacun a son overlay dans `compose/` (`create_host_path: false`), à lister dans `COMPOSE_FILE` du `.env` pour les seuls outils réellement installés. Ceux d'OpenClaw et de Hermes sont en lecture-écriture pour l'édition de leurs fichiers markdown — le backend n'y écrit rien d'autre ; celui de NemoClaw est en lecture seule :

```bash
# OpenClaw sur l'hôte, plus NemoClaw
echo 'COMPOSE_FILE=docker-compose.yml:compose/openclaw.yml:compose/nemoclaw.yml' >> .env
docker compose up -d --build
```

Un overlay dont le répertoire manque empêche le conteneur de démarrer — c'est voulu. Même sans overlay, un processus OpenClaw ou Hermes en cours est vu via `/proc`, et son onglet dit quel overlay manque.

Avec NemoClaw, la config de l'agent vit **dans** le sandbox OpenShell et appartient à l'agent : depuis l'hôte, seul le registre des sandboxes (`~/.nemoclaw/sandboxes.json`) se lit. `~/.local/state/nemoclaw` (base de la passerelle, clés mTLS, matériel de signature JWT) n'est jamais monté.

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
| Plafond d'horloge à 2100 MHz | Génération vidéo ComfyUI (GPU saturé) : 85 W en charge ramenés à ~50 W, 72–79 °C (quasi inchangé), plus de crash ([forum NVIDIA](https://forums.developer.nvidia.com/t/unlocking-the-power-of-the-spark-in-comfyui-no-crashes/360336)) |
| Plafond à 2200 MHz (variante) | Service LLM vLLM, **moyenne** sur 8 min (le décodage est limité par la mémoire, le GPU attend souvent) : 63 W → 40 W, pic 90 → 78 °C, plus de throttling thermique, au coût de 1% en décodage et 3,9% en préfill ([agjs/gb10-clock-cap](https://github.com/agjs/gb10-clock-cap)). Non comparable à la ligne 2100 MHz : charge et mesure différentes |
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

## Benchmarks

### Le principe

- **Chaque outil tourne dans son propre conteneur jetable**, jamais dans l'image de l'app. Au premier run, l'app construit l'image `spark-control-center/aiperf:<version>` (~1,7 Go, une seule fois ; la progression s'affiche dans le log du run). AIPerf 0.13 exige `crick`, qui n'a pas de wheel aarch64 : il est compilé dans un étage de build `python:3.12`, l'image finale part de `python:3.12-slim`.
- **Un conteneur par palier**, en `network_mode: host` : l'URL visée est `http://localhost:<port>` de l'hôte. Il ne voit que le dossier de résultats de son palier et le cache des tokenizers.
- **Un seul run à la fois** : deux benchmarks sur le même GPU se mesurent l'un l'autre.
- **Télémétrie** : pendant chaque palier, l'app lit `nvidia-smi` chaque seconde (puissance, horloge, température, utilisation) et note le plafond GB10 en vigueur. D'où l'énergie, les tokens par joule et le verdict du plafond sous charge, avec les mêmes seuils que la carte GB10 — c'est le test « en conditions réelles » que la carte ne peut pas faire GPU au repos.
- **Arrêt** : SIGINT, pour qu'AIPerf écrive ses résultats partiels ; puis un second SIGINT et SIGKILL s'il ne rend pas la main.
- **Comparabilité** : chaque run porte une empreinte de sa charge (tailles des prompts et des réponses, nombre de requêtes, seed…). Le modèle, le serveur, le plafond et la concurrence n'en font pas partie : c'est précisément ce qu'on compare.

### Stockage

```
/var/lib/spark-control-center/benchmarks/
├── runs/<id>/run.json     # configuration, paliers, résultats normalisés, télémétrie résumée
├── runs/<id>/log.jsonl    # log du run
├── runs/<id>/gpu.jsonl    # échantillons GPU (1 s)
├── runs/<id>/steps/<n>/   # fichiers bruts de l'outil (profile_export_aiperf.json…)
└── hf-cache/              # tokenizers téléchargés (HF_HOME des conteneurs d'outils)
```

Ce dossier est monté **au même chemin** dans le conteneur de l'app : c'est le démon Docker, côté hôte, qui résout les montages des conteneurs d'outils. Supprimer un run depuis l'interface efface son dossier ; pour supprimer l'image de l'outil : `docker image rm spark-control-center/aiperf:0.13.0`.

### Tokenizer

AIPerf compte les tokens avec le tokenizer du modèle. `auto` prend l'identifiant du modèle quand c'est un dépôt Hugging Face (`Qwen/Qwen3-8B`, le cas de vLLM et SGLang), sinon le tokenizer intégré (tiktoken), approximatif — le cas des noms Ollama comme `llama3.2:1b` ; le run le signale. Sans accès à internet, copier un dossier de tokenizer dans `hf-cache/` et le désigner par `/hf/<dossier>`.

### Ajouter un outil

Un outil est une entrée de `TOOLS` dans `backend/benchtools.js` : son Dockerfile, son schéma de paramètres (le formulaire en est tiré : un paramètre qui n'a pas sa propre section apparaît sous « Advanced settings »), `buildArgv`, et `parseResult`, qui ramène ses résultats aux métriques canoniques (les tags AIPerf : `time_to_first_token`, `output_token_throughput`…).

### Variables d'environnement

- `BENCH_DIR` (backend) : dossier des runs. À changer **des deux côtés** du montage dans `docker-compose.yml`.
- `BENCH_PROBE_HOST` (backend) : hôte par lequel l'app interroge `/v1/models` des serveurs détectés — `host.docker.internal` dans le compose, l'app étant sur un réseau bridge.
- `AIPERF_VERSION` (backend) : version d'AIPerf ; la changer reconstruit l'image au run suivant.
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` : s'ils sont définis pour l'app, ils sont transmis au build de l'image et aux conteneurs d'outils, `localhost` toujours exclu du proxy.

## Structure

```
├── backend/
│   ├── index.js        # API REST, WebSocket exec, déploiement GitHub, fichiers statiques
│   ├── gb10.js         # État désiré/réel GB10
│   ├── apps.js         # Registre des apps + pipeline d'édition
│   ├── agents.js       # OpenClaw / Hermes / NemoClaw, lecture seule
│   ├── skills.js       # Gestionnaire de skills partagés
│   ├── insights.js     # Moteur d'insights
│   ├── rules.js        # Catalogue de règles d'insights
│   ├── machine.js      # Identité machine
│   ├── updates.js      # Mises à jour système
│   ├── hostports.js    # Détection des ports d'écoute (conteneurs host-network)
│   ├── metrics.js      # Métriques système / GPU / stats conteneurs
│   ├── benchmarks.js   # Benchmarks : exécution, stockage, télémétrie, API
│   ├── benchtools.js   # Registre des outils de benchmark (adaptateur AIPerf)
│   ├── benchtargets.js # Détection des serveurs d'inférence à benchmarker
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
├── compose/            # Overlays optionnels : openclaw.yml, hermes.yml, nemoclaw.yml
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
| GET | `/api/apps/:id/file?key=` | Lecture d'un fichier markdown d'un agent (OpenClaw, Hermes) |
| POST | `/api/apps/:id/preview` | Aperçu d'une modification de config (diff + avertissements) |
| POST | `/api/apps/:id/apply` | Appliquer une modification prévisualisée |
| GET | `/api/skills` | Liste des skills sur toutes les racines |
| GET | `/api/skills/:name` | Détail d'un skill |
| POST | `/api/skills/preview` | Aperçu d'un toggle/import de skill |
| POST | `/api/skills/apply` | Appliquer une modification de skill prévisualisée |
| GET | `/api/insights` | Résultats du moteur d'insights |
| GET | `/api/machine` | Identité machine |
| GET | `/api/updates` | Mises à jour système (apt) |
| GET | `/api/benchmarks/tools` | Outils de benchmark, schéma de leurs paramètres, image prête ou non |
| GET | `/api/benchmarks/targets` | Serveurs d'inférence détectés et leurs modèles |
| GET | `/api/benchmarks/status` | Run en cours (indicateur affiché sur toutes les pages) |
| GET | `/api/benchmarks/runs` | Historique des runs (résumés) |
| POST | `/api/benchmarks/runs` | Lancer un run (409 si un run tourne déjà) |
| GET | `/api/benchmarks/runs/:id` | Détail d'un run |
| GET | `/api/benchmarks/runs/:id/events` | Progression, logs et télémétrie en direct (SSE) |
| GET | `/api/benchmarks/runs/:id/telemetry` | Échantillons GPU du run |
| GET | `/api/benchmarks/runs/:id/steps/:n/result.json` | Résultat brut de l'outil pour un palier |
| POST | `/api/benchmarks/runs/:id/cancel` | Arrêter le run |
| DELETE | `/api/benchmarks/runs/:id` | Supprimer un run |
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

Les benchmarks lancent des conteneurs en réseau hôte. L'image est figée côté serveur, jamais prise de la requête ; les paramètres passent par une liste blanche bornée et un `argv` sans shell ; l'URL et le nom du modèle sont validés et ne peuvent pas commencer par `-` ; une éventuelle clé API n'est ni stockée ni journalisée. Les routes qui lancent ou arrêtent un run exigent un corps JSON, qu'une page d'un autre site ne peut pas envoyer sans préflight CORS.
