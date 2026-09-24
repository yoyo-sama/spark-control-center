# Cadrage — module « Agents » (OpenClaw + Hermes via NemoClaw)

> Statut : **cadré et validé, planification non démarrée.**
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
| UI HTTP des agents | **Reverse proxy dans Express** (`http-proxy-middleware`, WebSocket relayés) sous `/agents/<id>/ui/` | Une seule origine et une seule auth ; les UI des agents ne sont jamais exposées directement. |
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

- [ ] Sortie de `nemoclaw --help` et des sous-commandes utiles : liste, statut, start/stop, logs,
      changement de modèle ou de fournisseur, onboarding. Versions de NemoClaw, OpenShell, OpenClaw
      et Hermes.
- [ ] **Visibilité des sandboxes par Docker** : sont-elles des conteneurs de premier niveau (`docker ps`)
      ou tournent-elles *à l'intérieur* d'un conteneur de cluster OpenShell (k3s) ? Cela détermine ce que
      dockerode peut faire directement et ce qui doit passer par le bridge.
- [ ] Ports et chemins des UI HTTP des agents. Supportent-elles un sous-chemin (base path) derrière
      un proxy, ou faut-il un sous-domaine ou un port dédié ?
- [ ] Emplacement et format des fichiers de config d'OpenClaw et de Hermes (dans la sandbox ou sur
      l'hôte) et des politiques de sandbox.
- [ ] Comment NemoClaw stocke les clés API cloud, et comment il bascule entre vLLM local et
      fournisseurs cloud.
- [ ] Où tourne vLLM (conteneur hôte ?), et son port `/metrics`.
- [ ] Mettre en place les fixtures du mock-bridge avec les sorties réelles capturées.

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
  existant aperçu → diff → confirmation → écriture atomique), secrets masqués.
- Interaction : terminal xterm.js vers la TUI de chaque sandbox (PTY via le bridge),
  UI HTTP des agents embarquées via reverse proxy Express sous /agents/<id>/ui/.
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

Contrainte d'architecture non négociable : l'environnement de développement doit
s'exécuter dans Docker (docker-compose) dès la mise en place initiale du projet —
la containerisation fait partie des tout premiers lots du plan, jamais une tâche
ajoutée après coup. Concrètement : docker-compose.dev.yml avec conteneurs backend
(node --watch), frontend (Vite HMR) et mock-bridge (simule nemoclaw, sandboxes et
/metrics vLLM). Seul agents-bridge tourne sur l'hôte, comme les units gb10-tuning.

Premier lot obligatoire : exploration sur le GB10 réel (checklist dans
docs/cadrage-module-agents.md) — CLI nemoclaw, visibilité des sandboxes par Docker
(premier niveau ou dans un cluster OpenShell/k3s), ports et base path des UI des
agents, emplacement des configs, gestion des clés et du changement de fournisseur,
port /metrics de vLLM. Les sorties capturées alimentent les fixtures du mock-bridge.

Risques identifiés : interfaces NemoClaw/OpenShell/OpenClaw jeunes et instables
(couche d'adaptation isolée, refuser plutôt que deviner) ; visibilité Docker des
sandboxes incertaine ; frontière de confiance (docker.sock + bridge = root) ;
intégrité des sandboxes (ne jamais contourner OpenShell) ; images ARM64 ; UI
d'agents peut-être incompatibles avec un sous-chemin/iframe.

Modèle imposé pour la phase PLANIFIER : opus (choisi en amont avec l'utilisateur
selon la complexité du projet cadré — ne re-décide pas ce point).
```
