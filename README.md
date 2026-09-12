# Spark Control Center

[![en](https://img.shields.io/badge/lang-en-blue)](README.md) [![fr](https://img.shields.io/badge/lang-fr-red)](README.fr.md)

Spark Control Center is a web-based Docker manager: monitor and control your containers from the browser — system dashboard, interactive terminal, one-click GitHub deploy.

![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white) ![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)

## Features

- **System dashboard**: CPU, memory, disk, NVIDIA GPUs (via `nvidia-smi`), container/image/volume counters, real-time gradient charts
- **Container list**: status, image, restart policy, **launch directory** (host bind mounts + WorkingDir) and a **direct link to the app** for every published TCP port
- **Host-network port auto-detection**: apps running with `network_mode: host` (no published ports) get their listening ports detected through `/proc` (socket inodes ↔ TCP tables matching)
- **Container detail**: CPU/RAM stats (CPU memory + GPU VRAM), network, history charts, configuration (command, ports, mounts)
- **Interactive terminal**: in-browser shell (xterm.js + WebSocket) in any running container, with automatic bash/sh detection and resizing
- **GitHub deploy**: clone → build → run a repository straight from the UI, with live logs (SSE), timeout and automatic cleanup
- **Actions**: start / stop / restart / delete with confirmation
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
git clone https://github.com/yoyo-sama/docker-manager.git
cd docker-manager

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
cd docker-manager

# 1. Fetch the latest code
git pull

# 2. Rebuild the image and restart the container
docker compose up -d --build
```

`docker compose up -d --build` takes care of everything: it rebuilds the single image from the new sources (frontend + backend), stops the outdated container and starts a new one, reusing the settings from `docker-compose.yml` (Docker socket, `pid: host`, GPU reservation, port mapping).

The update is safe for your environment:
- the application is **stateless** (no database, no local data to back up)
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

> To expose the UI on a port other than 8081, edit the `ports:` section of the `app` service (e.g. `"9090:3001"`).

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
| Clock cap at 2100 MHz | 85 W spikes brought down to a stable 50 W, 72–79 °C, no more crashes |
| Clock cap at 2200 MHz (variant) | −12 °C, −36% power, at a cost of 1% in decoding and 3.9% in prefill |
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

## Structure

```
├── backend/
│   ├── index.js        # REST API, WebSocket exec, GitHub deploy, static serving
│   ├── hostports.js    # Listening port detection (host-network containers)
│   ├── metrics.js      # System / GPU / container stats metrics
├── frontend/
│   ├── src/
│   │   ├── components/ # Dashboard, ContainerDetail, Terminal, DeployModal…
│   │   ├── lib/        # dark/light theme hook
│   │   ├── types.ts
│   │   └── App.tsx
│   └── vite.config.ts  # /api proxy for local development
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
| WS | `/api/exec/:id` | Interactive terminal |

## Development

Local development environment (outside Docker):

```bash
# Backend (port 3001)
cd backend && npm install && npm start

# Frontend (port 5173, /api proxy → localhost:3001)
cd frontend && npm install && npm run dev
```

## Security note

The application has **no authentication** and the terminal grants a shell inside containers. Intended for a local network or trusted environment; put it behind an authenticating proxy if exposed.
