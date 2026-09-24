# Cadrage — module « Agents » (OpenClaw + Hermes via NemoClaw)

> Statut : **cadré et validé, exploration sur le GB10 faite le 2026-09-24, planification non démarrée.**
> Résultats et décisions qui en découlent : section « Résultats de l'exploration ».
> Cadré via `/architect` le 2026-09-24. Pour reprendre : lancer `/tour-de-controle` avec le brief de la
> dernière section (copier-coller tel quel).

## Contexte

Sur le GB10 (DGX OS, ARM64), NemoClaw sert deux agents, chacun dans sa sandbox dédiée :

- **OpenClaw**
- **Hermes Agent** (Nous Research)

Aujourd'hui tout se pilote à la main : `nemoclaw <sandbox_name>`, puis `openclaw` ou `hermes` selon la
sandbox. On interagit avec les agents par leur TUI (depuis la sandbox) ou par leur UI HTTP. Les agents
tournent dans des conteneurs. L'inférence est mixte : **vLLM local** et **API cloud** (NVIDIA, Claude,
Z.ai…). L'accès distant passera par **Tailscale**.

Plutôt que de créer une app séparée, on ajoute un **module « Agents »** à Spark Control Center. Le
terminal xterm.js, le registre `APPS` (aperçu → diff → confirmation → écriture atomique), les métriques
conteneurs, l'embarquement d'UI tierces (DGX Dashboard) et le modèle « conteneur non privilégié + composant
hôte à liste blanche » couvrent déjà environ la moitié du besoin.

## Utilisateurs et accès

- MVP : **l'utilisateur seul**, en LAN et à distance, **tout via Tailscale** (même depuis le LAN).
- Hébergement : **sur le GB10 lui-même**.
- Roadmap : multi-utilisateur, login applicatif (à l'étude), control center hébergé hors du GB10
  qui pilote à distance.

## Périmètre MVP

1. **Superviser**
   - État des sandboxes et des agents (up/down, santé)
   - Logs en direct
   - Métriques GB10 (existantes)
   - Métriques vLLM via son endpoint Prometheus `/metrics` : tokens/s, KV cache, requêtes en file
2. **Piloter le cycle de vie**
   - Démarrer / arrêter / redémarrer les sandboxes
   - Changer de modèle ou de fournisseur d'inférence (vLLM local ↔ API cloud)
   - Passer par les mécanismes officiels de NemoClaw, jamais par un contournement de la sandbox
3. **Configurer**
   - OpenClaw et Hermes ajoutés comme apps du registre `backend/apps.js`, avec le même pipeline
     d'édition sûre
   - Politiques de sandbox
   - Secrets masqués, jamais renvoyés au navigateur
4. **Interagir**
   - Terminal web (xterm.js) branché sur la TUI de chaque sandbox
   - UI HTTP de chaque agent embarquée derrière un reverse proxy
5. **Historique**
   - Métriques sur plusieurs jours (graphes)
   - **Journal d'audit** des actions (qui / quoi / quand / résultat)

## Hors scope (V2+)

- Chat natif unifié pour les deux agents : l'intégration des UI existantes suffit au MVP
- Multi-utilisateur avec rôles, login applicatif (mot de passe + TOTP) : **à étudier**
- Control center hébergé sur une autre machine qui pilote le GB10 à distance
- Archivage des logs des agents au-delà de ce que NemoClaw conserve

## Stack technique validée

**Socle existant conservé tel quel** :

- Backend : Node.js / Express 5, dockerode, ws, SSE
- Frontend : React 19 / Vite / TypeScript / Tailwind v4, xterm.js, Recharts, Lucide
- Tests : framework de test natif de Node + unittest Python

**Ajouts :**

| Besoin | Choix | Justification |
|---|---|---|
| Historique métriques + audit | **SQLite via `node:sqlite`** (Node 22.5+ / 24 LTS), fichier sur volume Docker. Rétention : 7 jours bruts, puis agrégation horaire | Aucune dépendance native à compiler en ARM64, aucun conteneur de BDD en plus. Les conteneurs gérés restent sans état ; seules les données propres au control center sont persistées. **Écart assumé** avec le principe « aucune base de données » du README, à mettre à jour. |
| Piloter `nemoclaw` depuis le conteneur | **Démon hôte `agents-bridge`** : Python, bibliothèque standard uniquement (asyncio, `pty`, socket Unix), unit systemd, rangé sous `host/agents-bridge/`. Liste blanche stricte de commandes, `argv` construit en code explicite, `shell=False`. Socket Unix monté dans le conteneur. | Voir l'encadré ci-dessous. |
| UI HTTP des agents | **Reverse proxy dans Express** (`http-proxy-middleware`, WebSocket relayés), **une origine par agent** via un port Tailscale Serve dédié, affichée en iframe | Une seule auth ; les UI des agents ne sont jamais exposées directement. **Révisé après exploration** (sous-chemin `/agents/<id>/ui/` abandonné) : voir « Décisions de l'utilisateur ». |
| TUI des agents | PTY ouvert par le bridge (`nemoclaw <sandbox>`) et relayé par le terminal WebSocket existant | Réutilise xterm.js, sans `node-pty` natif. |
| Authentification | **Tailscale Serve** devant `127.0.0.1:8081` (HTTPS auto). Le backend exige et vérifie l'en-tête d'identité `Tailscale-User-Login`, comparé à une liste de comptes autorisés dans `.env` | Zéro mot de passe à gérer ; le bind `127.0.0.1` est conservé. |

> **Pourquoi un démon hôte cette fois, alors que le cadrage GB10 avait écarté un « agent HTTP maison » ?**
> Le modèle gb10-tuning (état désiré JSON → unit `.path` → oneshot root) est à sens unique et
> asynchrone : il suffit pour appliquer des réglages. Le module Agents a besoin d'échanges interactifs :
> start/stop avec retour immédiat, logs en flux et surtout un **PTY bidirectionnel** pour la TUI. Le
> compromis retenu reste dans le même esprit :
> - pas de HTTP, pas de port réseau : un **socket Unix** seulement ;
> - bibliothèque standard Python, auditable ;
> - liste blanche stricte ;
> - le conteneur de l'app ne gagne aucun privilège.

## Contrainte d'architecture non négociable : Docker dès le premier jour

- `docker-compose.dev.yml` fait partie des **tout premiers lots**, avec trois conteneurs :
  - **backend** : `node --watch`, code monté
  - **frontend** : serveur de dev Vite avec rechargement à chaud
  - **mock-bridge** : simule `nemoclaw`, les sandboxes et un faux `/metrics` vLLM, pour développer
    même hors du GB10 (depuis le PC Windows par exemple)
- `docker-compose.yml` de production : l'image unique multi-étapes existante, plus le volume SQLite et
  le montage du socket du bridge.
- Seule exception justifiée : `agents-bridge` tourne sur l'hôte (systemd), comme les units gb10-tuning,
  puisque son rôle est d'agir sur l'hôte. Comme pour gb10-tuning, il **n'est pas installé
  automatiquement** : la commande d'installation est documentée et c'est l'utilisateur qui la lance.

## Premier lot obligatoire : exploration sur le GB10 réel

Tout le reste dépend des réponses. À relever avant d'écrire la couche d'adaptation :

- [x] Sortie de `nemoclaw --help` et des sous-commandes utiles : liste, statut, start/stop, logs,
      changement de modèle ou de fournisseur, onboarding. Versions de NemoClaw, OpenShell, OpenClaw
      et Hermes.
- [x] **Visibilité des sandboxes par Docker** : sont-elles des conteneurs de premier niveau (`docker ps`)
      ou tournent-elles *à l'intérieur* d'un conteneur de cluster OpenShell (k3s) ? Cela détermine ce que
      dockerode peut faire directement et ce qui doit passer par le bridge.
- [x] Ports et chemins des UI HTTP des agents. Supportent-elles un sous-chemin (base path) derrière
      un proxy, ou faut-il un sous-domaine ou un port dédié ?
- [x] Emplacement et format des fichiers de config d'OpenClaw et de Hermes (dans la sandbox ou sur
      l'hôte) et des politiques de sandbox.
- [x] Comment NemoClaw stocke les clés API cloud, et comment il bascule entre vLLM local et
      fournisseurs cloud.
- [x] Où tourne vLLM (conteneur hôte ?), et son port `/metrics`.
- [ ] Mettre en place les fixtures du mock-bridge avec les sorties réelles capturées.

## Résultats de l'exploration (GB10, 2026-09-24)

Relevés en lecture seule : aucune sandbox, aucun agent ni vLLM démarré, arrêté ou reconfiguré. Seul effet
de bord : `nemoclaw <name> status` réécrit `active_gateway` avec la valeur qu'il avait déjà. Les sorties
brutes, secrets masqués, sont sur le GB10 dans `docs/exploration-agents/` (non commitées).

**Limite** : au moment du relevé, les deux sandboxes étaient arrêtées (OpenClaw sorti en code 141, Hermes
en code 1, vers 07:55) et vLLM depuis la veille 22:20. Les en-têtes HTTP des UI et `/metrics` ont été
déduits des fichiers des conteneurs arrêtés : **à confirmer en direct** une fois les services relancés.

Versions : NemoClaw v0.0.124, OpenShell 0.0.116, OpenClaw 2026.7.1, Hermes 0.20.6, vLLM 0.27.1.

| Point | Constat |
|---|---|
| CLI | `--help` n'exécute rien. Sortie JSON versionnée pour les lectures (`list`, `status`, `<name> status`, `inference get`). Cycle de vie : `<name> start` (répare aussi gateway et forwards), `stop`, `recover`, `gateway restart`. Logs : `<name> logs --follow`. TUI : `nemoclaw launch <name>` ou `<name> connect`. |
| Docker | Sandboxes = **conteneurs Docker de premier niveau, pas de k3s**. Labels `openshell.ai/sandbox-name` et `io.nvidia.nemoclaw.agent`, aucun port publié, pas de redémarrage automatique. Gateway OpenShell = unité systemd utilisateur `nemoclaw-openshell-gateway` sur `127.0.0.1:8080`. |
| UI OpenClaw | `127.0.0.1:18790`. Sous-chemin supporté (`gateway.controlUi.basePath`). Envoie `X-Frame-Options: DENY` et `frame-ancestors 'none'` ; le WebSocket exige une origine listée dans `allowedOrigins`. NemoClaw pose `dangerouslyDisableDeviceAuth` : un clic dans l'UI peut lancer des outils de l'agent. |
| UI Hermes | Dashboard désactivé dans la sandbox. API sur le port 8642, jeton Bearer, `X-Forwarded-Prefix` géré. Le dashboard s'active avec `NEMOCLAW_HERMES_DASHBOARD=1` à l'onboard ou au rebuild (loopback, port 18789). |
| Configs | `/sandbox/.openclaw/openclaw.json`, `/sandbox/.hermes/config.yaml` + `.env`, dans des volumes Docker non lisibles par l'utilisateur. Registre : `~/.nemoclaw/sandboxes.json`. Politiques en YAML via `<name> policy get`. NemoClaw régénère une partie des configs. |
| Clés et inférence | Clés stockées dans le gateway OpenShell, non relisibles. Bascule : `nemoclaw inference set --provider --model`. **Une seule route d'inférence par gateway**, partagée par les agents qui y sont rattachés. Une gateway par port (`NEMOCLAW_GATEWAY_PORT`, état sous `~/.nemoclaw/gateways/<port>/`). |
| vLLM | Lancé par le compose `~/vllm-api`, pas par NemoClaw. Port 8000 sur toutes les interfaces, `/metrics` sur le même port. |
| Privilèges | Tout tourne sous l'utilisateur `sparks` : le bridge n'a pas besoin de root. |

### Écarts avec le cadrage

- **Pas de k3s** : dockerode suffit pour lire l'état et les logs. Start/stop passent quand même par
  `nemoclaw` (il répare gateway et forwards), jamais par `docker start/stop` direct.
- **Registre `APPS` non applicable tel quel** : les configs vivent dans des volumes et NemoClaw en régénère
  une partie. Pistes pour l'édition : `download`/`upload`, `config export`, `policy --dry-run`.
- **Bridge sans root** : l'unité `agents-bridge` tourne sous l'utilisateur, pas en root.
- **Origine unique abandonnée pour les UI d'agents** : voir la décision 1.

### Décisions de l'utilisateur (2026-09-24)

1. **UI des agents : une origine séparée par agent, en iframe.** Chaque UI est servie sur son propre port
   Tailscale Serve, toujours derrière l'authentification du backend. Le proxy remplace seulement
   `frame-ancestors` par l'origine du control center, retire `X-Frame-Options` (qui ne sait pas lister
   des origines) et garde le reste de la CSP. Cette origine est ajoutée à `allowedOrigins`. Un bouton
   « ouvrir dans un onglet » est prévu. Raison : servie sous `/agents/<id>/ui/`, une UI d'agent partagerait
   l'origine du control center ; un script de l'UI, une XSS ou un contenu piégé par prompt injection
   pourrait alors appeler toute l'API (Docker, bridge, soit l'équivalent de root) et lire le localStorage
   commun, où se trouve le jeton OpenClaw.
2. **Route d'inférence commune aux deux agents** pour le MVP. Plus tard, l'app doit permettre de créer
   une seconde gateway (`onboard --non-interactive` sur un autre port). Y rattacher un agent existant
   recrée sa sandbox (sauvegarde puis restauration) : action longue et destructive, à traiter comme un
   job avec confirmation.
3. **Hermes : API, avec un lien vers son dashboard.** Il faut activer le dashboard, ce qui demande de
   reconstruire la sandbox Hermes, après avoir réglé les deux points ci-dessous.

### À traiter hors de l'app, avant le reste

- `/sandbox/.hermes/.env` contient `GLM_API_KEY` et `NVIDIA_API_KEY` en clair.
- `config.yaml` de Hermes vise un modèle cloud NVIDIA alors que le registre indique vLLM local : cause
  probable de l'arrêt de Hermes (code 1), non prouvée.
- vLLM écoute sur toutes les interfaces (port 8000).
- Rejouer en direct le relevé des en-têtes des UI et d'un échantillon de `/metrics`.

## Risques identifiés

1. **Interfaces jeunes et instables.** Le CLI et la structure de NemoClaw, OpenShell et OpenClaw
   peuvent changer d'une version à l'autre. Parades :
   - couche d'adaptation isolée, un seul module qui connaît le CLI ;
   - fixtures versionnées ;
   - le bridge **refuse ce qu'il ne reconnaît pas**, plutôt que de deviner (même principe que le
     refus d'éditer un JSONC ou un compose interpolé).
2. **Visibilité des sandboxes par Docker incertaine.** Voir le lot d'exploration.
3. **Frontière de confiance.** L'accès au socket Docker et au bridge équivaut à un accès root. Parades :
   - auth Tailscale obligatoire ;
   - bind `127.0.0.1` conservé ;
   - liste blanche du bridge ;
   - confirmation explicite des actions destructives ;
   - journal d'audit.
   Point à traiter : tout processus local peut joindre `127.0.0.1:8081` et forger l'en-tête Tailscale.
   C'est acceptable (un processus local a déjà l'accès), mais à documenter.
4. **Intégrité des sandboxes.** Le pilotage externe ne doit jamais affaiblir l'isolation : pas de
   `docker exec` qui contourne les politiques OpenShell si un chemin officiel existe.
5. **Images ARM64.** Chaque nouvelle dépendance ou image doit exister en `linux/arm64`.
6. **UI d'agents derrière un proxy.** Elles ne sont peut-être pas prévues pour un sous-chemin (chemins
   absolus, WebSocket, cookies, CSP ou `X-Frame-Options` qui bloquent l'iframe).

## Brief pour `/tour-de-controle`

```
Projet déjà cadré et validé avec l'utilisateur — ne remets pas en cause le cadrage ni
la stack, mets-les en œuvre. Référence complète : docs/cadrage-module-agents.md.

Objectif : ajouter à Spark Control Center (ce dépôt) un module « Agents » pour superviser,
piloter, configurer et interagir avec les agents OpenClaw et Hermes, chacun dans sa sandbox
NemoClaw sur le GB10 (DGX OS, ARM64). Utilisateur unique, accès LAN + distant via Tailscale.

Périmètre (MVP) :
- Supervision : état des sandboxes/agents, logs en direct, métriques vLLM (/metrics
  Prometheus), historique des métriques sur plusieurs jours.
- Cycle de vie : start/stop/restart des sandboxes, changement de modèle/fournisseur
  d'inférence (vLLM local ↔ API cloud) via les mécanismes officiels de NemoClaw.
- Configuration : OpenClaw et Hermes ajoutés au registre backend/apps.js (pipeline
  existant aperçu → diff → confirmation → écriture atomique), secrets masqués. Les
  configs vivent dans des volumes Docker et NemoClaw en régénère une partie : passer
  par download/upload, config export, policy --dry-run plutôt qu'une écriture directe.
- Interaction : terminal xterm.js vers la TUI de chaque sandbox (PTY via le bridge),
  UI HTTP des agents embarquées en iframe via reverse proxy Express, une origine
  séparée par agent (port Tailscale Serve dédié) ; le proxy remplace seulement
  frame-ancestors par l'origine du control center, retire X-Frame-Options, garde le
  reste de la CSP ; bouton « ouvrir dans un onglet ». Hermes : API + lien vers son
  dashboard.
- Sécurité : auth Tailscale Serve (en-tête Tailscale-User-Login vérifié contre une
  liste blanche .env), bind 127.0.0.1 conservé, journal d'audit, confirmation des
  actions destructives.

Hors scope (V2+) : chat natif unifié, multi-utilisateur/rôles, login applicatif
(à l'étude), control center hébergé hors du GB10, archivage des logs des agents.

Stack technique validée : socle existant inchangé (Node.js/Express 5, dockerode, ws,
SSE ; React 19/Vite/TypeScript/Tailwind v4, xterm.js, Recharts). Ajouts : SQLite via
node:sqlite (volume Docker, 7 j bruts puis agrégats horaires) ; démon hôte
host/agents-bridge en Python stdlib (asyncio, pty, socket Unix, systemd, liste blanche
stricte, shell=False, non installé automatiquement — commande d'installation documentée) ;
http-proxy-middleware pour les UI des agents ; Tailscale Serve pour l'auth.
node:sqlite exige Node 22.5+ : le Dockerfile actuel est en node:20-slim, à passer en
Node 24 LTS (image arm64). agents-bridge tourne sous l'utilisateur, pas en root.

Contrainte d'architecture non négociable : l'environnement de développement doit
s'exécuter dans Docker (docker-compose) dès la mise en place initiale du projet —
la containerisation fait partie des tout premiers lots du plan, jamais une tâche
ajoutée après coup. Concrètement : docker-compose.dev.yml avec conteneurs backend
(node --watch), frontend (Vite HMR) et mock-bridge (simule nemoclaw, sandboxes et
/metrics vLLM). Seul agents-bridge tourne sur l'hôte, comme les units gb10-tuning.

Exploration sur le GB10 réel : FAITE le 2026-09-24, résultats et décisions dans la
section « Résultats de l'exploration » de docs/cadrage-module-agents.md. Sandboxes =
conteneurs Docker de premier niveau (pas de k3s) : dockerode pour l'état et les logs,
nemoclaw pour start/stop. Une route d'inférence par gateway, partagée par les deux
agents au MVP ; créer une 2e gateway depuis l'app viendra plus tard. Restent à
confirmer en direct : en-têtes des UI et échantillon /metrics. Les sorties capturées
(docs/exploration-agents/ sur le GB10) alimentent les fixtures du mock-bridge.

Risques identifiés : interfaces NemoClaw/OpenShell/OpenClaw jeunes et instables
(couche d'adaptation isolée, refuser plutôt que deviner) ; visibilité Docker des
frontière de confiance (docker.sock + bridge = root) ;
intégrité des sandboxes (ne jamais contourner OpenShell) ; images ARM64 ; UI
d'agents à isoler sur leur propre origine (clickjacking, accès à l'API par même origine).

Modèle imposé pour la phase PLANIFIER : opus (choisi en amont avec l'utilisateur
selon la complexité du projet cadré — ne re-décide pas ce point).
```
