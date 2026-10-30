# Spark Control Center

[![en](https://img.shields.io/badge/lang-en-blue)](README.md) [![fr](https://img.shields.io/badge/lang-fr-red)](README.fr.md)

Spark Control Center is a web control portal for a DGX Spark workstation (GB10 chip): tune the machine, configure the AI apps running on it, and manage its Docker containers, all from the browser.

![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white) ![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)

## Features

The sidebar has five sections:

- **GB10** — the home view, labelled dynamically with the detected machine name. GPU and thermal tuning:
  - **Settings**: GPU clock cap, persistence mode, swap, `vm.swappiness`, thermal monitor
  - **A switch never lies**: every desired setting is compared against what the machine actually reports, with an explicit per-setting state (`ok`, `pending`, `failed`, `skipped`, `diverged`, `unverified`, `unset`) — some GB10 firmwares silently ignore `nvidia-smi -lgc`, and a UI that just echoed the request back would be lying
  - **Only what you set**: settings the user never touched are not persisted
  - **Unprivileged container**: it only writes a desired-state JSON that a root systemd oneshot validates against a strict allow-list and applies (details under "GB10 tuning" below)
- **Apps** — reads and surgically edits the configuration of the AI tools installed on the host:
  - **ComfyUI**: the command-line flags in its `compose.yaml`, and its user scripts
  - **opencode** (`opencode.json`): default model, `limit.context`, compaction, skill paths/urls
  - **Claude Code**: settings files, plugins, MCP servers, hooks — read-only except a short whitelist of harmless keys
  - **OpenClaw** and **Hermes Agent**, with or without **NemoClaw** (exploration, see below): how each agent is deployed (on the host, in a NemoClaw sandbox, or both, plus its processes seen in `/proc`), its model checked against Ollama, OpenClaw's channels and who may DM the agent, Hermes' terminal backend, skills. Their **markdown files** are editable — OpenClaw's workspace files (`AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, daily notes in `memory/`), Hermes' `SOUL.md` and `memories/{MEMORY,USER}.md` per profile — with each agent's size limit shown; their config stays read-only, with the commands to change it
  - **Edit pipeline**: preview → line diff → warnings → explicit confirmation → atomic write preserving the file's owner and mode, with a timestamped `.bak` and a content-hash check that refuses a preview if the file changed meanwhile. Secrets are masked
  - **Shared skills manager**: the same skills are loaded by both opencode and Claude Code, so duplicates across roots are flagged
  - **Insight engine**: flags the real problems of this machine (rules live in `backend/rules.js`) rather than listing a catalogue
- **Benchmarks** — measures how fast the models served on this machine really are, with [AIPerf](https://github.com/ai-dynamo/aiperf) (NVIDIA ai-dynamo):
  - **Three choices and go**: the server (vLLM, SGLang, Ollama, llama.cpp, TGI, NIM… detected automatically, with their models), the kind of work (chat, coding agent, summarize, long generation, RAG) and the load (one user, or a concurrency sweep to find the sweet spot)
  - **Live**: step-by-step progress, GPU power / clock / temperature, the tool's log
  - **Readable results**: throughput, time to first token, inter-token latency, speed per user, efficiency in tokens per joule, p50 / p90 / p99 distribution, sweep curves
  - **The GB10 clock cap checked under load**: every run records the cap in force and says whether it held, was ignored by the firmware, or was never reached — the GB10 card shows these measurements
  - **History and comparison**: up to 4 runs side by side with % deltas, and a warning when they did not run the same workload
  - **Extensible tool registry**: AIPerf is the first adapter (`backend/benchtools.js`)
- **Containers**
  - **Container list**: status, image, restart policy, **launch directory** (host bind mounts + WorkingDir) and a **direct link to the app** for every published TCP port
  - **Host-network port auto-detection**: apps running with `network_mode: host` (no published ports) get their listening ports detected through `/proc` (socket inodes ↔ TCP tables matching)
  - **Container detail**: CPU/RAM stats (CPU memory + GPU VRAM), network, history charts, configuration (command, ports, mounts)
  - **Interactive terminal**: in-browser shell (xterm.js + WebSocket) in any running container, with automatic bash/sh detection and resizing
  - **GitHub deploy**: clone → build → run a repository straight from the UI, with live logs (SSE), timeout and automatic cleanup
  - **Actions**: start / stop / restart / delete with confirmation
- **DGX Dashboard** — the machine's own NVIDIA dashboard, embedded

Outside that navigation:

- **System dashboard**: CPU, memory, disk, NVIDIA GPUs (via `nvidia-smi`), container/image/volume counters, real-time gradient charts
- **System updates**: read from apt — counts and the per-package list, read-only (installing stays on the host)
- **Automatic machine identity detection**: vendor, model, BIOS, serials, DGX platform, chip, OS, network interfaces — what makes the app portable to another DGX Spark whatever its brand — the home directory is auto-detected, the `SPARK_HOME` variable is only an override
- **Dark / light theme**: modern monochrome interface (Inter font, Lucide icons, JetBrains Mono for technical data), persisted toggle defaulting to system preference

## Stack

| Component | Technologies |
|---|---|
| Frontend | React 19, Vite, TypeScript, TailwindCSS v4, xterm.js, Recharts, Lucide |
| Backend | Node.js, Express 5, dockerode, ws (WebSocket), SSE |
| Packaging | Single multi-stage Docker image (frontend build + backend + gzip compression) |

## Installation

### Prerequisites

- [Docker Engine](https://docs.docker.com/get-docker/) ≥ 20.10 with [Compose v2](https://docs.docker.com/compose/) (`docker compose`)
- The Docker socket `/var/run/docker.sock` must be accessible to the user running compose (the backend mounts it as a bind mount)
- *(Optional)* NVIDIA drivers + [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) for GPU metrics

### Install and start

```bash
# 1. Clone the repository
git clone https://github.com/yoyo-sama/spark-control-center.git
cd spark-control-center

# 2. Build and start (no environment variables required)
docker compose up -d --build
```

The application is available at **http://localhost:8081**.

Everything runs in a **single container**: the Node backend serves both the API (including the WebSocket terminal) and the static frontend.

### Without an NVIDIA GPU

The `docker-compose.yml` reserves GPUs through `deploy.resources` (nvidia runtime). Without a GPU — or without nvidia-container-toolkit — remove this block:

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

Everything else works normally; the GPUs section simply stays empty.

### Update

Containers never update themselves: they keep running the image they were started from. To update an existing installation:

```bash
cd spark-control-center

# 1. Fetch the latest code
git pull

# 2. Rebuild the image and restart the container
docker compose up -d --build
```

`docker compose up -d --build` takes care of everything: it rebuilds the single image from the new sources (frontend + backend), stops the outdated container and starts a new one, reusing the settings from `docker-compose.yml` (Docker socket, `pid: host`, GPU reservation, port mapping).

The update is safe for your environment:
- the application has **no database**; its only data is the benchmark history, on the host in `/var/lib/spark-control-center/benchmarks` — it survives updates
- the containers it manages are **not affected** — they keep running during the update
- your theme preference is stored in the browser and survives updates

Verify the update:

```bash
docker compose ps        # the app container should be "Up"
git log --oneline -1     # installed version
```

To roll back to a previous version:

```bash
git checkout <commit-hash>
docker compose up -d --build
```

### Stop

```bash
docker compose down
```

### Configuration

No configuration is required. Optional variables (through the `environment:` section of the `app` service in compose):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Internal server port (serves both the API and the frontend) |
| `BENCH_DIR` | `/var/lib/spark-control-center/benchmarks` | Benchmark runs folder (see "Benchmarks") |
| `BENCH_PROBE_HOST` | `localhost` (`host.docker.internal` in the compose) | Host through which the app probes inference servers |
| `AIPERF_VERSION` | `0.13.0` | Pinned AIPerf version |

> To expose the UI on a port other than 8081, edit the `ports:` section of the `app` service (e.g. `"9090:3001"`).

### OpenClaw, Hermes Agent, NemoClaw

Their directories are **not mounted by default**: mounting a directory that does not exist makes Docker create it empty and owned by root, which then breaks the tool's own installer. Each one has an overlay in `compose/` (`create_host_path: false`), to list in `COMPOSE_FILE` in `.env` for the tools actually installed. The OpenClaw and Hermes overlays are read-write so their markdown files can be edited — the backend writes nothing else there; the NemoClaw one is read-only:

```bash
# OpenClaw on the host, plus NemoClaw
echo 'COMPOSE_FILE=docker-compose.yml:compose/openclaw.yml:compose/nemoclaw.yml' >> .env
docker compose up -d --build
```

An overlay whose directory is missing stops the container from starting — on purpose. Even without any overlay, a running OpenClaw or Hermes process is seen through `/proc` and its tab says which overlay is missing.

With NemoClaw, the agent's config lives **inside** the OpenShell sandbox and belongs to the agent: from the host, only the sandbox registry (`~/.nemoclaw/sandboxes.json`) can be read. `~/.local/state/nemoclaw` (gateway database, mTLS keys, JWT signing material) is never mounted.

## GB10 tuning

### The principle

The container stays **unprivileged**: the app writes `/etc/gb10-tuning/state.json`, the `gb10-tuning.path` systemd unit detects the change and triggers `gb10-tuning.service` (a oneshot, running as root) which applies the settings and writes `result.json`, read back by the app to display the actual state.

### Security warning

The app has **no authentication** (an assumed choice for v1) and this JSON drives root-level commands — hence the bind on `127.0.0.1` and the strict allow-list validation in `apply.py`.

### Install

```bash
sudo install -d -m 755 /etc/gb10-tuning
sudo install -m 755 host/gb10-tuning/apply.py /usr/local/sbin/gb10-apply.py
sudo install -m 644 host/gb10-tuning/gb10-tuning.path \
                    host/gb10-tuning/gb10-tuning.service \
                    host/gb10-tuning/gb10-thermal-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gb10-tuning.path gb10-tuning.service
```

`gb10-thermal-monitor.service` points at `thermal-monitor.sh` through an absolute path: systemd does not expand `$HOME`, so adjust that `ExecStart=` line to this machine before installing the unit.

### Uninstall

```bash
sudo systemctl disable --now gb10-tuning.path gb10-tuning.service
sudo nvidia-smi -rgc
```

`nvidia-smi -rgc` resets the GPU to its factory clocks.

### v1 settings and measured effects

| Setting | Measured effect |
|---|---|
| Root cause of the crashes | A power spike from 14 W to 85 W triggers the over-current protection — **not** a thermal throttle |
| Clock cap at 2100 MHz | ComfyUI video generation (GPU saturated): 85 W under load brought down to ~50 W, 72–79 °C (barely changed), no more crashes ([NVIDIA forum](https://forums.developer.nvidia.com/t/unlocking-the-power-of-the-spark-in-comfyui-no-crashes/360336)) |
| Clock cap at 2200 MHz (variant) | vLLM LLM serving, 8-min **average** (decode is memory-bound, the GPU often waits): 63 W → 40 W, peak 90 → 78 °C, no more thermal throttling, at a cost of 1% in decoding and 3.9% in prefill ([agjs/gb10-clock-cap](https://github.com/agjs/gb10-clock-cap)). Not comparable with the 2100 MHz row: different workload and metric |
| Power limit | `nvidia-smi -q -d POWER` returns `Power Limit: N/A` on this GPU — the clock cap is the **only** lever, no wattage limit is adjustable |
| `CUDA_CACHE_MAXSIZE=4294967296` | 20 s/step → 6.6 s/step (×3) |

### Swap warning

`swapoff` under memory pressure can trigger an OOM kill — hence the guard rail (refuses if more than 512 MiB of swap are currently in use).

### Honesty caveat

Some GB10 units ignore `nvidia-smi -lgc` depending on their firmware — the UI therefore compares the desired state to the actual state and flags any divergence.

### Environment variables

- Recommended: `CUDA_CACHE_MAXSIZE=4294967296`, `NCCL_P2P_DISABLE=1`
- To avoid: `CUDA_CACHE_DISABLE=1`, `PYTORCH_NO_CUDA_MEMORY_CACHING=1` (memory fragmentation and OOM)

### `GB10_STATE_DIR`

This environment variable overrides the state directory (both for the backend and the script), which allows testing without touching `/etc`.

## System updates

### The principle

The DGX Dashboard's `/api/v1/updates/*` endpoints require its own auth and only listen on `127.0.0.1`, unreachable from this container — so the console reads the real source instead: apt, via the files the host already maintains.

The flow is **one-way, host → app**: `dgx-updates.timer` runs hourly on the host and writes `/var/lib/spark-control-center/updates.json`, which this app only reads. Unlike the `gb10-tuning` pipeline, nothing the app writes ever triggers a host command, so no allow-list is needed here.

- Update counts (`85 updates`, `14 security`) come straight from `/var/lib/update-notifier/updates-available`, refreshed by the system's own `apt-daily.timer`.
- The per-package list (name/current/candidate) comes from `updates.json`, refreshed by `dgx-updates.timer` below.
- Installing updates still happens via the DGX Dashboard or `apt` on the host — not from this console.

### Install

```bash
sudo install -m 755 host/dgx-updates/dgx-updates.sh /usr/local/sbin/dgx-updates.sh
sudo install -m 644 host/dgx-updates/dgx-updates.service \
                    host/dgx-updates/dgx-updates.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dgx-updates.timer
```

### Uninstall

```bash
sudo systemctl disable --now dgx-updates.timer
sudo rm /usr/local/sbin/dgx-updates.sh /etc/systemd/system/dgx-updates.service /etc/systemd/system/dgx-updates.timer
```

### Environment variables

- `UPDATES_OUT` (script): overrides the JSON output path, for testing without touching `/var/lib`.
- `UPDATE_NOTIFIER_FILE`, `APT_STAMP_FILE`, `UPDATES_JSON` (backend): override the three input paths, for testing.

Without the timer installed, `/api/updates` still returns 200 with `pipelineInstalled: false` and a `note` explaining the package list is absent — the summary counts (which don't depend on the timer) are unaffected.

## Benchmarks

### The principle

- **Each tool runs in its own throwaway container**, never inside the app image. On the first run, the app builds the `spark-control-center/aiperf:<version>` image (~1.7 GB, once; progress shows in the run's log). AIPerf 0.13 requires `crick`, which has no aarch64 wheel: it is compiled in a `python:3.12` build stage, and the final image starts from `python:3.12-slim`.
- **One container per step**, with `network_mode: host`: the target URL is the host's `http://localhost:<port>`. It only sees its step's results folder and the tokenizer cache.
- **One run at a time**: two benchmarks on the same GPU measure each other.
- **Telemetry**: during each step the app reads `nvidia-smi` every second (power, clock, temperature, utilization) and records the GB10 cap in force. That gives the energy, the tokens per joule and the cap verdict under load, with the same thresholds as the GB10 card — the "real conditions" test the card cannot do while the GPU idles.
- **Stopping**: SIGINT, so AIPerf writes its partial results; then a second SIGINT and SIGKILL if it doesn't exit.
- **Comparability**: each run carries a fingerprint of its workload (prompt and answer sizes, request count, seed…). Model, server, cap and concurrency are not part of it: they are what gets compared.

### Storage

```
/var/lib/spark-control-center/benchmarks/
├── runs/<id>/run.json     # configuration, steps, normalized results, telemetry summary
├── runs/<id>/log.jsonl    # the run's log
├── runs/<id>/gpu.jsonl    # GPU samples (1 s)
├── runs/<id>/steps/<n>/   # the tool's raw files (profile_export_aiperf.json…)
└── hf-cache/              # downloaded tokenizers (HF_HOME of the tool containers)
```

This folder is mounted **at the same path** in the app container: the Docker daemon, on the host, resolves the tool containers' mounts. Deleting a run from the UI removes its folder; to remove the tool image: `docker image rm spark-control-center/aiperf:0.13.0`.

### Tokenizer

AIPerf counts tokens with the model's tokenizer. `auto` uses the model id when it is a Hugging Face repo (`Qwen/Qwen3-8B`, the vLLM and SGLang case), otherwise the built-in tiktoken tokenizer, which is approximate — the case of Ollama names such as `llama3.2:1b`; the run says so. Without internet access, copy a tokenizer folder into `hf-cache/` and point at it as `/hf/<folder>`.

### Adding a tool

A tool is one entry of `TOOLS` in `backend/benchtools.js`: its Dockerfile, its parameter schema (the form is built from it: a parameter without its own section shows under "Advanced settings"), `buildArgv`, and `parseResult`, which maps its results onto the canonical metrics (AIPerf's tags: `time_to_first_token`, `output_token_throughput`…).

### Environment variables

- `BENCH_DIR` (backend): the runs folder. Change it **on both sides** of the mount in `docker-compose.yml`.
- `BENCH_PROBE_HOST` (backend): host through which the app queries the detected servers' `/v1/models` — `host.docker.internal` in the compose, since the app sits on a bridge network.
- `AIPERF_VERSION` (backend): AIPerf version; changing it rebuilds the image on the next run.
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`: when set for the app, they are passed to the image build and to the tool containers, with `localhost` always excluded from the proxy.

## Structure

```
├── backend/
│   ├── index.js        # REST API, WebSocket exec, GitHub deploy, static serving
│   ├── gb10.js         # GB10 desired/actual state
│   ├── apps.js         # App registry + the edit pipeline
│   ├── agents.js       # OpenClaw / Hermes / NemoClaw: read-only config, editable markdown
│   ├── skills.js       # Shared skills manager
│   ├── insights.js     # Insight engine
│   ├── rules.js        # Insight rule catalogue
│   ├── machine.js      # Machine identity
│   ├── updates.js      # System updates
│   ├── hostports.js    # Listening port detection (host-network containers)
│   ├── metrics.js      # System / GPU / container stats metrics
│   ├── benchmarks.js   # Benchmarks: runner, storage, telemetry, API
│   ├── benchtools.js   # Benchmark tool registry (AIPerf adapter)
│   ├── benchtargets.js # Detection of the inference servers to benchmark
│   ├── *.test.js       # Test suites (node --test)
│   └── fixtures/       # Test fixtures
├── frontend/
│   ├── src/
│   │   ├── components/ # Dashboard, ContainerDetail, Terminal, DeployModal…
│   │   ├── lib/        # dark/light theme hook
│   │   ├── types.ts
│   │   └── App.tsx
│   └── vite.config.ts  # /api proxy for local development
├── host/
│   ├── gb10-tuning/    # apply.py + its test, systemd .path/.service units
│   └── dgx-updates/    # Snapshot script, systemd service and timer
├── compose/            # Opt-in overlays: openclaw.yml, hermes.yml, nemoclaw.yml
├── Dockerfile          # Single multi-stage image (frontend build + backend)
└── docker-compose.yml
```

## API

| Method | Route | Description |
|---|---|---|
| GET | `/api/containers` | Container list (+ detected ports, directories) |
| GET | `/api/containers/:id` | Container detail |
| GET | `/api/containers/:id/stats` | Live stats (CPU/RAM/network/VRAM) |
| POST | `/api/containers/:id/start\|stop\|restart` | Lifecycle actions |
| DELETE | `/api/containers/:id` | Remove container |
| GET | `/api/system` | System + GPU metrics |
| POST | `/api/deploy/github` | GitHub repository deploy |
| GET | `/api/events/deploy/:id` | Deploy logs (SSE) |
| GET | `/api/gb10/state` | GB10 desired + actual state |
| PUT | `/api/gb10/state` | Update the desired GB10 state |
| POST | `/api/gb10/reapply` | Re-trigger the host-side apply |
| GET | `/api/apps` | App registry summary |
| GET | `/api/apps/:id` | App detail (detection, facts) |
| GET | `/api/apps/:id/file?key=` | Read one of an agent's markdown files (OpenClaw, Hermes) |
| POST | `/api/apps/:id/preview` | Preview an app config edit (diff + warnings) |
| POST | `/api/apps/:id/apply` | Apply a previewed edit |
| GET | `/api/skills` | Skills list across roots |
| GET | `/api/skills/:name` | Skill detail |
| POST | `/api/skills/preview` | Preview a skill toggle/import |
| POST | `/api/skills/apply` | Apply a previewed skill change |
| GET | `/api/insights` | Insight engine findings |
| GET | `/api/machine` | Machine identity |
| GET | `/api/updates` | System updates (apt) |
| GET | `/api/benchmarks/tools` | Benchmark tools, their parameter schema, image ready or not |
| GET | `/api/benchmarks/targets` | Detected inference servers and their models |
| GET | `/api/benchmarks/status` | Run in progress (indicator shown on every page) |
| GET | `/api/benchmarks/runs` | Run history (summaries) |
| POST | `/api/benchmarks/runs` | Start a run (409 if one is already running) |
| GET | `/api/benchmarks/runs/:id` | Run detail |
| GET | `/api/benchmarks/runs/:id/events` | Live progress, logs and telemetry (SSE) |
| GET | `/api/benchmarks/runs/:id/telemetry` | The run's GPU samples |
| GET | `/api/benchmarks/runs/:id/steps/:n/result.json` | The tool's raw result for one step |
| POST | `/api/benchmarks/runs/:id/cancel` | Stop the run |
| DELETE | `/api/benchmarks/runs/:id` | Delete a run |
| WS | `/api/exec/:id` | Interactive terminal |

## Development

Local development environment (outside Docker):

```bash
# Backend (port 3001)
cd backend && npm install && npm start

# Frontend (port 5173, /api proxy → localhost:3001)
cd frontend && npm install && npm run dev
```

Tests need no setup, the fixtures are in the repo:

```bash
cd backend && node --test              # backend suite
python3 host/gb10-tuning/test_apply.py # root-side apply script
```

## Security note

The application has **no authentication** and the terminal grants a shell inside containers. The app binds to `127.0.0.1` only, cross-origin requests are refused (no CORS header is sent), and WebSocket upgrades whose `Origin` does not match the server's own host are rejected — a browser applies no CORS to WebSockets, so any page the user visited could otherwise have opened a shell in a container. None of this is authentication: intended for a local network or trusted environment; put it behind an authenticating proxy if it must leave the machine.

Benchmarks start containers on the host network. The image is fixed server-side, never taken from the request; parameters go through a bounded allow-list and a shell-free `argv`; the URL and model name are validated and can't start with `-`; an optional API key is neither stored nor logged. The routes that start or stop a run require a JSON body, which a page from another site cannot send without a CORS preflight.
