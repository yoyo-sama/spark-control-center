# Tour de contrôle — changelog

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
