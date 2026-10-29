// Benchmark target discovery: which inference servers on this host can be benchmarked,
// and which models they serve. A target is any port answering the OpenAI
// `GET /v1/models` route; containers whose image or name says what they are
// (vLLM, Ollama…) are labelled as such and listed first.
const Docker = require('dockerode');
const { resolveContainerPorts } = require('./hostports');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// This app runs on a bridge network: `localhost` is the app container itself, so
// probes go through the host gateway (BENCH_PROBE_HOST=host.docker.internal in
// docker-compose.yml). The benchmark container runs with network_mode host, so the
// URL it is given is localhost. The localhost default keeps host-side dev working.
const PROBE_HOST = process.env.BENCH_PROBE_HOST || 'localhost';
const OLLAMA_URL = process.env.OLLAMA_URL || null;
const PROBE_TIMEOUT_MS = 2500;
const MAX_PROBES = 48;

const KINDS = [
  { kind: 'vllm', label: 'vLLM', re: /vllm/i },
  { kind: 'sglang', label: 'SGLang', re: /sglang/i },
  { kind: 'ollama', label: 'Ollama', re: /ollama/i },
  { kind: 'trtllm', label: 'TensorRT-LLM', re: /trt-?llm|tensorrt/i },
  { kind: 'llamacpp', label: 'llama.cpp', re: /llama[._-]?cpp|llama-server/i },
  { kind: 'tgi', label: 'TGI', re: /text-generation-inference|(^|[/_-])tgi([/_:-]|$)/i },
  { kind: 'nim', label: 'NVIDIA NIM', re: /nvcr\.io\/nim\/|(^|[/_-])nim([/_:-]|$)/i },
];

const SELF_LABEL = 'spark-control-center.benchmark';

// Pure: { name, image } → { kind, label } (kind 'openai' when nothing matches).
function classifyContainer({ name, image }) {
  const hay = `${image || ''} ${name || ''}`;
  for (const k of KINDS) if (k.re.test(hay)) return { kind: k.kind, label: k.label };
  return { kind: 'openai', label: 'OpenAI-compatible' };
}

// Pure: body of GET /v1/models → model ids. vLLM, SGLang, Ollama (≥0.2), llama.cpp
// and TGI all answer the OpenAI shape { data: [{ id }] }.
function parseModels(body) {
  if (!body || !Array.isArray(body.data)) return null;
  return body.data
    .map((m) => (m && typeof m.id === 'string' ? m.id : null))
    .filter(Boolean)
    .slice(0, 200);
}

async function probeModels(host, port) {
  try {
    const r = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return null;
    return parseModels(await r.json());
  } catch {
    return null;
  }
}

async function listCandidates() {
  const containers = await docker.listContainers({ all: false });
  const out = [];
  await Promise.all(containers.map(async (info) => {
    if (info.Labels && info.Labels[SELF_LABEL]) return; // our own benchmark runs
    const container = docker.getContainer(info.Id);
    let inspect;
    try {
      inspect = await container.inspect();
    } catch {
      return;
    }
    const ports = await resolveContainerPorts(container, info, inspect);
    const name = info.Names[0].replace('/', '');
    const { kind, label } = classifyContainer({ name, image: info.Image });
    for (const p of ports) {
      out.push({ containerId: info.Id, containerName: name, image: info.Image, kind, kindLabel: label, port: p.hostPort });
    }
  }));
  return out;
}

// Known kinds first, then by container name; the app's default ports first within a container.
function sortTargets(targets) {
  const rank = (t) => (t.kind === 'openai' ? 1 : 0);
  return targets.sort((a, b) =>
    (b.reachable - a.reachable) || (rank(a) - rank(b)) || (a.containerName || '').localeCompare(b.containerName || '') || (a.port - b.port));
}

async function discoverTargets({ gpuMemoryByContainer } = {}) {
  let candidates = [];
  try {
    candidates = await listCandidates();
  } catch {
    candidates = []; // docker socket unavailable: manual URL entry still works
  }
  const seenPorts = new Set();
  const unique = candidates.filter((c) => {
    if (seenPorts.has(c.port)) return false;
    seenPorts.add(c.port);
    return true;
  }).slice(0, MAX_PROBES);

  const targets = await Promise.all(unique.map(async (c) => {
    const models = await probeModels(PROBE_HOST, c.port);
    return {
      id: `${c.containerName}:${c.port}`,
      label: `${c.kindLabel} · ${c.containerName}`,
      kind: c.kind,
      kindLabel: c.kindLabel,
      containerName: c.containerName,
      image: c.image,
      port: c.port,
      url: `http://localhost:${c.port}`,
      reachable: models !== null,
      models: models || [],
      vramBytes: gpuMemoryByContainer ? gpuMemoryByContainer.get(c.containerId) || null : null,
    };
  }));

  // A port that doesn't answer /v1/models is only kept when the container is a known
  // inference server — it may be bound to 127.0.0.1, unreachable from this bridge
  // network but fine for the host-network benchmark container.
  const kept = targets.filter((t) => t.reachable || t.kind !== 'openai');

  // OLLAMA_URL may point at an Ollama that isn't a container (installed on the host).
  if (OLLAMA_URL) {
    try {
      const u = new URL(OLLAMA_URL);
      const port = Number(u.port) || 11434;
      if (!seenPorts.has(port)) {
        const models = await probeModels(u.hostname, port);
        if (models !== null) {
          kept.push({
            id: `ollama:${port}`,
            label: 'Ollama · host',
            kind: 'ollama',
            kindLabel: 'Ollama',
            containerName: null,
            image: null,
            port,
            url: `http://localhost:${port}`,
            reachable: true,
            models,
            vramBytes: null,
          });
        }
      }
    } catch {
      /* malformed OLLAMA_URL: skip */
    }
  }
  return sortTargets(kept);
}

module.exports = { discoverTargets, classifyContainer, parseModels, sortTargets, SELF_LABEL };
