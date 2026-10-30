// OpenClaw and Hermes Agent, installed straight on the host ("standalone") or running
// inside a NemoClaw sandbox. Their CONFIG is read-only on purpose, unlike opencode's:
//  - standalone, both config files decide what an agent reachable from messaging apps may
//    do on this machine (OpenClaw channels/dmPolicy, Hermes terminal.backend), and this app
//    has no authentication — the same boundary as Claude Code's permissions and hooks;
//  - openclaw.json is JSON5 that the gateway hot-reloads and refuses to start on if a single
//    key is wrong, config.yaml is commented YAML: neither survives the parse/re-emit
//    round-trip apps.js relies on;
//  - under NemoClaw the live config is not on the host at all: it sits in the OpenShell
//    sandbox and belongs to the agent. ~/.nemoclaw only holds the sandbox registry.
// Their markdown files (identity, instructions, memory) are editable: see the section below.
// Never read, only ever tested for existence at most: ~/.openclaw/credentials, auth-profiles,
// ~/.hermes/{auth.json,state.db} and the VALUES of ~/.hermes/.env, ~/.nemoclaw/credentials.json.
// ~/.local/state/nemoclaw (gateway database, mTLS keys, JWT signing material) is not even mounted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Docker = require('dockerode');
const JSON5 = require('json5');
const YAML = require('yaml');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Lazy: apps.js builds its registry from this module, and skills.js requires apps.js.
const apps = () => require('./apps');
const skills = () => require('./skills');

function openclawDir() {
  return process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
}
function hermesDir() {
  return process.env.HERMES_DIR || path.join(os.homedir(), '.hermes');
}
function nemoclawDir() {
  return process.env.NEMOCLAW_DIR || path.join(os.homedir(), '.nemoclaw');
}

const OPENCLAW_DEFAULT_PORT = 18789;

// ---------- shared helpers ----------

// A base URL can carry credentials (user:pass@, ?key=): only scheme, host and path leave.
// `${VAR}` placeholders are kept as is — they are references, not values.
function safeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(u)) return u;
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname === '/' ? '' : x.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

// Ollama answers `llama3` for `llama3:latest`: compare with the implicit tag spelled out.
function served(installed, id) {
  const full = (s) => (s.includes(':') ? s : `${s}:latest`);
  return installed.some((i) => full(i) === full(id));
}

// For the raw config dumps, before mask(): mask() keys on names like TOKEN or KEY, but a
// password inside a base URL and the phone numbers of an allowFrom list sit under
// innocent ones. URLs carrying userinfo or a query go through safeUrl, allow lists
// become their size — the same treatment the structured summaries apply.
function scrub(v, key) {
  if (Array.isArray(v)) {
    if (key && /allowFrom$/i.test(key)) return `${v.length} entr${v.length === 1 ? 'y' : 'ies'}`;
    return v.map((x) => scrub(x));
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
  }
  if (typeof v === 'string' && /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*@|[^?#\s]*\?)/i.test(v)) return safeUrl(v);
  return v;
}

function expandHome(p, home) {
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

// Hermes files its skills by category (skills/<category>/<skill>/SKILL.md), OpenClaw does not:
// walk two levels and stop at the first SKILL.md on each branch. null when the dir is absent.
function findSkills(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const out = [];
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const sub = path.join(dir, d.name);
    let content = null;
    try {
      content = fs.readFileSync(path.join(sub, 'SKILL.md'), 'utf8');
    } catch {
      // not a skill directory
    }
    if (content !== null) {
      const fm = skills().frontmatter(content);
      out.push({ name: fm.name || d.name, description: fm.description || '', path: sub });
    } else if (depth > 1) {
      for (const s of findSkills(sub, depth - 1) || []) out.push({ ...s, category: d.name });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Same SKILL.md format as Claude Code and opencode, but neither agent loads those roots:
// a name present on both sides is two copies that will drift, not one shared skill.
function skillRoot(id, dir, depth) {
  const found = findSkills(dir, depth);
  const shared = new Map(skills().scanSkills().skills.map((s) => [s.name, [s.root, ...s.duplicateIn]]));
  return {
    id,
    path: dir,
    exists: found !== null,
    skills: (found || []).map((s) => ({ ...s, sharedWith: shared.get(s.name) || [] })),
  };
}

// ---------- running processes ----------

// cmdline and cgroup are world-readable, so `pid: host` is enough from the unprivileged
// container. /proc/<pid>/fd is not (ptrace-protected for another uid): no listening port here.
const AGENT_PATTERNS = {
  openclaw: /(^|\/)openclaw(-gateway)?(\.m?js)?$|\/node_modules\/openclaw\//,
  hermes: /(^|\/)hermes(-agent)?$|(^|\/)hermes_cli(\/|\.|$)/,
};

// Only the head of argv: interpreter, script, `-m module`. Anything further is arguments —
// `vim ~/.openclaw/openclaw.json` must not count as a running OpenClaw.
function agentOf(argv) {
  const head = argv.slice(0, 3);
  for (const [id, re] of Object.entries(AGENT_PATTERNS)) if (head.some((a) => re.test(a))) return id;
  return null;
}

// Paths are relative to the reader's cgroup namespace, so a host process reads
// `0::/../../user.slice/…` from inside this container — the runtime names are what count.
function containerized(pid) {
  try {
    return /docker|containerd|kubepods|libpod|lxc/.test(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
  } catch {
    return null;
  }
}

const PROC_TTL = 2000;
let procCache = { time: 0, list: [] };

// One pass over /proc for both agents, cached: /api/apps detects every app on each call.
function scanAgentProcesses() {
  if (Date.now() - procCache.time < PROC_TTL) return procCache.list;
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    // no /proc: not Linux
  }
  const list = [];
  for (const pid of pids) {
    let argv;
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue; // pid can vanish mid-scan, that's normal
    }
    const agent = agentOf(argv);
    if (!agent) continue;
    list.push({
      agent,
      pid: Number(pid),
      argv: apps().maskArray(argv.slice(0, 8)).map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)),
      containerized: containerized(pid),
    });
  }
  procCache = { time: Date.now(), list };
  return list;
}

// ---------- NemoClaw ----------

// The registry schema is not documented field by field and moves between releases, so this
// reads it tolerantly and returns every field (masked) next to the few it recognizes.
function pick(e, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), e);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function agentIdOf(raw) {
  const s = String(raw).toLowerCase();
  if (s.includes('hermes')) return 'hermes';
  if (s.includes('openclaw')) return 'openclaw';
  return s;
}

function asText(v) {
  if (v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function normalizeSandbox(name, e, gateway, defaultSandbox) {
  const rawAgent = pick(e, 'agent.id', 'agent.name', 'agentType', 'agent_type', 'agentId', 'agent');
  const gpu = pick(e, 'gpu', 'gpuEnabled', 'gpu_enabled');
  const port = pick(e, 'controlUiPort', 'dashboardPort', 'dashboard_port', 'port');
  const policies = pick(e, 'policies', 'policyPresets', 'presets');
  return {
    name,
    gateway,
    // OpenClaw was NemoClaw's only agent before Hermes and Deep Agents: an entry without
    // an agent field predates them. Flagged, so the UI never states it as read.
    agent: rawAgent === null ? 'openclaw' : agentIdOf(rawAgent),
    agentInferred: rawAgent === null,
    model: asText(pick(e, 'model', 'inference.model', 'modelId', 'model_id')),
    provider: asText(pick(e, 'provider', 'inference.provider', 'providerId', 'provider_id')),
    gpu: typeof gpu === 'boolean' ? gpu : null,
    dashboardPort: Number.isInteger(port) ? port : null,
    policies: Array.isArray(policies) ? policies.map(asText) : null,
    createdAt: asText(pick(e, 'createdAt', 'created_at', 'created')),
    isDefault: name === defaultSandbox,
    fields: apps().mask(e),
  };
}

function readRegistry(file, gateway) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, gateway, error: `does not parse: ${e.message}`, sandboxes: [] };
  }
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const container = isObj(raw) && raw.sandboxes !== undefined ? raw.sandboxes : raw;
  const entries = Array.isArray(container)
    ? container.map((e, i) => [(e && e.name) || `#${i}`, e])
    : isObj(container)
      ? Object.entries(container)
      : [];
  const def = isObj(raw) ? pick(raw, 'defaultSandbox', 'default_sandbox', 'default') : null;
  return {
    file,
    gateway,
    error: null,
    sandboxes: entries.filter(([, e]) => isObj(e)).map(([n, e]) => normalizeSandbox(n, e, gateway, def)),
  };
}

// Default gateway at the root, one directory per non-default gateway port.
function readRegistries() {
  const dir = nemoclawDir();
  const out = [];
  const main = readRegistry(path.join(dir, 'sandboxes.json'), 'default');
  if (main) out.push(main);
  let ports = [];
  try {
    ports = fs.readdirSync(path.join(dir, 'gateways'));
  } catch {
    // single gateway
  }
  for (const p of ports) {
    const r = readRegistry(path.join(dir, 'gateways', p, 'sandboxes.json'), p);
    if (r) out.push(r);
  }
  return out;
}

// The OpenShell gateway is one Docker container embedding k3s; its name is NemoClaw's to
// choose, so match on the image or name rather than hardcoding one.
async function openshellContainers() {
  try {
    const list = await docker.listContainers({ all: true });
    return list
      .filter((c) => /openshell/i.test(c.Image) || (c.Names || []).some((n) => /openshell/i.test(n)))
      .map((c) => ({ name: (c.Names[0] || '').replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status }));
  } catch {
    return [];
  }
}

async function readNemoclaw() {
  const dir = nemoclawDir();
  const registries = readRegistries();
  return {
    dir,
    visible: fs.existsSync(dir),
    registries: registries.map((r) => ({ file: r.file, gateway: r.gateway, error: r.error, count: r.sandboxes.length })),
    sandboxes: registries.flatMap((r) => r.sandboxes),
    // Legacy plaintext file: current releases move credentials into the gateway store, but
    // onboarding can leave it behind after migrating it (NVIDIA/NemoClaw#10388). Never read.
    legacyCredentials: fs.existsSync(path.join(dir, 'credentials.json')),
    gatewayContainers: await openshellContainers(),
  };
}

function nemoclawFacts() {
  return { legacyCredentials: fs.existsSync(path.join(nemoclawDir(), 'credentials.json')) };
}

async function runtimeFor(agent, standalone) {
  const nemoclaw = await readNemoclaw();
  return {
    standalone,
    sandboxes: nemoclaw.sandboxes.filter((s) => s.agent === agent),
    otherSandboxes: nemoclaw.sandboxes.filter((s) => s.agent !== agent).length,
    processes: scanAgentProcesses().filter((p) => p.agent === agent),
    nemoclaw,
  };
}

// Detected as soon as ONE of the three traces exists. With none, say what was looked at
// and why it may simply be invisible from here: the compose mounts are opt-in.
function detectAgent(agent, label, configFile, overlay) {
  if (fs.existsSync(configFile)) return { detected: true, reason: '' };
  if (readRegistries().some((r) => r.sandboxes.some((s) => s.agent === agent))) return { detected: true, reason: '' };
  if (scanAgentProcesses().some((p) => p.agent === agent)) return { detected: true, reason: '' };
  return {
    detected: false,
    reason:
      `${label} not found: no ${configFile}, no NemoClaw sandbox running it in ${nemoclawDir()}, ` +
      `no ${agent} process on this host. If it is installed, enable compose/${overlay}.yml or ` +
      'compose/nemoclaw.yml through COMPOSE_FILE in .env — those directories are not mounted by default.',
  };
}

// ---------- OpenClaw ----------

function openclawConfigFile() {
  return path.join(openclawDir(), 'openclaw.json');
}

function openclawConfig() {
  const file = openclawConfigFile();
  if (!fs.existsSync(file)) return { file, exists: false, parsed: null, error: null };
  try {
    return { file, exists: true, parsed: JSON5.parse(fs.readFileSync(file, 'utf8')) || {}, error: null };
  } catch (e) {
    return { file, exists: true, parsed: null, error: `openclaw.json does not parse as JSON5: ${e.message}` };
  }
}

function openclawModel(c) {
  const m = c.agents && c.agents.defaults && c.agents.defaults.model;
  if (typeof m === 'string') return { primary: m, fallbacks: [] };
  return {
    primary: (m && typeof m.primary === 'string' && m.primary) || null,
    fallbacks: (m && Array.isArray(m.fallbacks) && m.fallbacks.filter((f) => typeof f === 'string')) || [],
  };
}

// served is null when it cannot be known: not an Ollama model, or Ollama unreachable.
function modelRef(ref, ollama) {
  const id = ref.startsWith('ollama/') ? ref.slice('ollama/'.length) : null;
  return { ref, ollamaId: id, served: id && ollama.reachable ? served(ollama.installed, id) : null };
}

// Older configs nest the DM policy under `dm`, newer ones put it on the channel itself.
// allowFrom holds phone numbers and user ids: only its size leaves, and whether it is `*`.
function openclawChannels(c) {
  return Object.entries(c.channels || {})
    .filter(([, ch]) => ch && typeof ch === 'object' && !Array.isArray(ch))
    .map(([name, ch]) => {
      const dm = ch.dm && typeof ch.dm === 'object' ? ch.dm : {};
      const allowFrom = Array.isArray(ch.allowFrom) ? ch.allowFrom : Array.isArray(dm.allowFrom) ? dm.allowFrom : null;
      const dmPolicy = typeof ch.dmPolicy === 'string' ? ch.dmPolicy : typeof dm.policy === 'string' ? dm.policy : null;
      return {
        name,
        enabled: ch.enabled !== false,
        dmPolicy,
        allowFromCount: allowFrom ? allowFrom.length : null,
        openToAnyone: dmPolicy === 'open' || (!!allowFrom && allowFrom.includes('*')),
        groupPolicy: typeof ch.groupPolicy === 'string' ? ch.groupPolicy : null,
      };
    });
}

// Read from the parsed config, never from mask(): the masking regex matches `maxTokens`.
function openclawProviders(c) {
  return Object.entries((c.models && c.models.providers) || {})
    .filter(([, p]) => p && typeof p === 'object')
    .map(([id, p]) => ({
      id,
      api: typeof p.api === 'string' ? p.api : null,
      baseUrl: safeUrl(p.baseUrl),
      apiKeySet: p.apiKey !== undefined,
      models: (Array.isArray(p.models) ? p.models : [])
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({
          id: String(m.id),
          contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : null,
          maxTokens: Number.isFinite(m.maxTokens) ? m.maxTokens : null,
        })),
    }));
}

// The default workspace, plus any agent of agents.list that declares its own.
function openclawWorkspaces(c) {
  const home = path.dirname(openclawDir());
  const defaults = (c.agents && c.agents.defaults) || {};
  const out = [{ id: 'default', path: expandHome(typeof defaults.workspace === 'string' ? defaults.workspace : '~/.openclaw/workspace', home) }];
  for (const a of c.agents && Array.isArray(c.agents.list) ? c.agents.list : []) {
    if (!a || typeof a.workspace !== 'string') continue;
    const p = expandHome(a.workspace, home);
    if (!out.some((w) => w.path === p)) out.push({ id: String(a.id), path: p });
  }
  return out;
}

function standaloneOpenclaw(cfg, ollama) {
  if (!cfg.parsed) return { configFile: cfg.file, error: cfg.error };
  const c = cfg.parsed;
  const defaults = (c.agents && c.agents.defaults) || {};
  const { primary, fallbacks } = openclawModel(c);
  const g = c.gateway || {};
  const workspace = openclawWorkspaces(c)[0].path;
  return {
    configFile: cfg.file,
    error: null,
    model: { primary: primary && modelRef(primary, ollama), fallbacks: fallbacks.map((f) => modelRef(f, ollama)) },
    gateway: {
      port: Number.isInteger(g.port) ? g.port : OPENCLAW_DEFAULT_PORT,
      portIsDefault: !Number.isInteger(g.port),
      bind: typeof g.bind === 'string' ? g.bind : null,
      authConfigured: g.auth !== undefined,
    },
    toolSandbox: defaults.sandbox && typeof defaults.sandbox.mode === 'string' ? defaults.sandbox.mode : null,
    agents: (c.agents && Array.isArray(c.agents.list) ? c.agents.list : [])
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({ id: String(a.id), model: typeof a.model === 'string' ? a.model : (a.model && a.model.primary) || null })),
    channels: openclawChannels(c),
    providers: openclawProviders(c),
    skills: [skillRoot('managed', path.join(openclawDir(), 'skills'), 1), skillRoot('workspace', path.join(workspace, 'skills'), 1)],
    config: apps().mask(scrub(c)),
  };
}

async function readOpenclaw() {
  const cfg = openclawConfig();
  const ollama = await apps().ollamaInfo();
  return {
    runtime: await runtimeFor('openclaw', cfg.exists),
    standalone: cfg.exists ? standaloneOpenclaw(cfg, ollama) : null,
    markdown: openclawMarkdown(cfg),
    ollama,
  };
}

async function openclawFacts() {
  const cfg = openclawConfig();
  if (!cfg.parsed) return null;
  const ollama = await apps().ollamaInfo();
  const { primary, fallbacks } = openclawModel(cfg.parsed);
  const defaults = (cfg.parsed.agents && cfg.parsed.agents.defaults) || {};
  return {
    primary,
    primaryServed: primary ? modelRef(primary, ollama).served : null,
    fallbackServed: fallbacks.some((f) => modelRef(f, ollama).served === true),
    openChannels: openclawChannels(cfg.parsed).filter((ch) => ch.enabled && ch.openToAnyone).map((ch) => ch.name),
    toolSandbox: defaults.sandbox && typeof defaults.sandbox.mode === 'string' ? defaults.sandbox.mode : null,
  };
}

function previewOpenclaw(body) {
  if (body && body.target === 'markdown') return previewMarkdown(openclawMarkdown(openclawConfig()), body, countUnits, OPENCLAW_MD_COST);
  return {
    error:
      'OpenClaw\'s config is read-only from here (its markdown files are not). openclaw.json is JSON5 that the gateway hot-reloads and refuses to start on ' +
      'if one key is wrong, and it decides who may message an agent able to act on this machine — this app has no ' +
      'authentication. Use `openclaw config set` on the host, or inside the sandbox (`nemoclaw <name> connect`) under NemoClaw.',
  };
}

// ---------- Hermes ----------

function hermesConfigFile() {
  return path.join(hermesDir(), 'config.yaml');
}

function hermesConfig() {
  const file = hermesConfigFile();
  if (!fs.existsSync(file)) return { file, exists: false, parsed: null, error: null };
  try {
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
    return { file, exists: true, parsed: parsed && typeof parsed === 'object' ? parsed : {}, error: null };
  } catch (e) {
    return { file, exists: true, parsed: null, error: `config.yaml does not parse: ${e.message}` };
  }
}

// A fresh install ships `model:` empty, older ones a bare string, `hermes model` writes the mapping.
function hermesModel(c) {
  const m = c.model;
  if (m && typeof m === 'object') {
    return {
      default: typeof m.default === 'string' ? m.default : null,
      provider: typeof m.provider === 'string' ? m.provider : null,
      rawBaseUrl: typeof m.base_url === 'string' ? m.base_url : null,
    };
  }
  return { default: typeof m === 'string' && m ? m : null, provider: null, rawBaseUrl: null };
}

function hermesOllama(model, ollama) {
  const pointsAtOllama = model.provider === 'ollama' || /:11434(\/|$)/.test(model.rawBaseUrl || '');
  return {
    pointsAtOllama,
    served: pointsAtOllama && model.default && ollama.reachable ? served(ollama.installed, model.default) : null,
  };
}

// Names only: every value in this file is a secret by construction.
function envKeys(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function standaloneHermes(cfg, ollama) {
  if (!cfg.parsed) return { configFile: cfg.file, error: cfg.error };
  const c = cfg.parsed;
  const dir = hermesDir();
  const model = hermesModel(c);
  const terminal = c.terminal && typeof c.terminal === 'object' ? c.terminal : {};
  const compression = c.compression && typeof c.compression === 'object' ? c.compression : {};
  return {
    configFile: cfg.file,
    error: null,
    model: { default: model.default, provider: model.provider, baseUrl: safeUrl(model.rawBaseUrl), ...hermesOllama(model, ollama) },
    terminal: {
      backend: typeof terminal.backend === 'string' ? terminal.backend : 'local',
      backendIsDefault: typeof terminal.backend !== 'string',
    },
    compression: {
      enabled: typeof compression.enabled === 'boolean' ? compression.enabled : null,
      threshold: Number.isFinite(compression.threshold) ? compression.threshold : null,
    },
    toolsets: Array.isArray(c.toolsets) ? c.toolsets.map(String) : null,
    envKeys: envKeys(path.join(dir, '.env')),
    profiles: listDirs(path.join(dir, 'profiles')),
    skills: [skillRoot('hermes', path.join(dir, 'skills'), 2)],
    config: apps().mask(scrub(c)),
  };
}

async function readHermes() {
  const cfg = hermesConfig();
  const ollama = await apps().ollamaInfo();
  return {
    runtime: await runtimeFor('hermes', cfg.exists),
    standalone: cfg.exists ? standaloneHermes(cfg, ollama) : null,
    markdown: hermesMarkdown(),
    ollama,
  };
}

async function hermesFacts() {
  const cfg = hermesConfig();
  if (!cfg.parsed) return null;
  const model = hermesModel(cfg.parsed);
  const { pointsAtOllama, served: isServed } = hermesOllama(model, await apps().ollamaInfo());
  return { model: model.default, pointsAtOllama, served: isServed };
}

function previewHermes(body) {
  if (body && body.target === 'markdown') return previewMarkdown(hermesMarkdown(), body, countCodePoints, HERMES_MD_COST);
  return {
    error:
      'Hermes\' config is read-only from here (its markdown files are not). config.yaml is commented YAML, which this app never re-serializes, and ' +
      'terminal.backend decides where the agent runs its shell commands — this app has no authentication. ' +
      'Use `hermes config set` on the host, or `nemohermes` / `nemoclaw <name> connect` under NemoClaw.',
  };
}

// ---------- markdown files ----------

// The prose both agents put in their system prompt: identity, instructions, memory. Unlike
// their config these ARE editable — they change what the agent is told, not what it may
// execute: the same footing as a skill's SKILL.md, and the same pipeline (preview, diff,
// confirmation, hash check, timestamped backup). A request names a file by its key, looked
// up in the list built below: a key is never turned into a path, so only these files exist.
// Under NemoClaw they live inside the sandbox, out of reach from here like the config.

const MAX_MD = 256 * 1024;
const MD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const DAILY_SHOWN = 31;

// Injected at the start of every session. BOOTSTRAP.md is the first-run ritual, deleted once
// done: editable while it exists, never re-created from here.
const OPENCLAW_BOOTSTRAP = [
  { name: 'AGENTS.md', what: 'Operating instructions' },
  { name: 'SOUL.md', what: 'Persona, tone and boundaries' },
  { name: 'USER.md', what: 'Who the user is' },
  { name: 'IDENTITY.md', what: 'The agent\'s name and character' },
  { name: 'TOOLS.md', what: 'Notes on local tools and conventions' },
  { name: 'HEARTBEAT.md', what: 'Checklist for heartbeat runs' },
  { name: 'MEMORY.md', what: 'Curated long-term memory' },
  { name: 'BOOTSTRAP.md', what: 'First-run ritual', creatable: false },
];

// Defaults from the OpenClaw docs; the config wins when it sets them.
const OPENCLAW_MAX_CHARS = 20000;
const OPENCLAW_TOTAL_MAX_CHARS = 60000;

const HERMES_FILES = [
  { rel: 'SOUL.md', what: 'Identity, first slot of the system prompt' },
  { rel: path.join('memories', 'MEMORY.md'), what: 'The agent\'s own notes: conventions, quirks, lessons', limitKey: 'memory_char_limit', defaultLimit: 2200 },
  { rel: path.join('memories', 'USER.md'), what: 'What the agent knows about the user', limitKey: 'user_char_limit', defaultLimit: 1375 },
];

const OPENCLAW_MD_COST =
  'Read at the start of each session: running sessions keep the old text. The agent can rewrite this file itself — ' +
  'if it does before you apply, the apply is refused rather than overwriting it.';
const HERMES_MD_COST =
  'Loaded as a frozen snapshot at session start: running sessions keep the old text. The agent can rewrite its ' +
  'memories itself — if it does before you apply, the apply is refused rather than overwriting them.';

// Python's len() counts code points, JavaScript's .length UTF-16 units: each limit is counted
// the way the agent enforcing it counts.
const countUnits = (s) => s.length;
const countCodePoints = (s) => Array.from(s).length;

function limitFrom(value, fallback, setting, effect) {
  const set = Number.isInteger(value) && value > 0;
  return { chars: set ? value : fallback, setting, isDefault: !set, effect };
}

// Content is read to count it: these files are small, and the count is what the limits are about.
function mdEntry({ key, base, rel, what, creatable, limit, count }) {
  const file = path.join(base, rel);
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    // absent
  }
  let content = null;
  if (st && st.isFile()) {
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      // unreadable: listed, not counted
    }
  }
  let symlink = null;
  if (st && st.isSymbolicLink()) {
    try {
      symlink = fs.realpathSync(file);
    } catch {
      symlink = fs.readlinkSync(file);
    }
  }
  return {
    key,
    name: rel,
    what,
    path: file,
    exists: !!st,
    symlink,
    lines: content === null ? 0 : content.split('\n').length - 1,
    chars: content === null ? 0 : count(content),
    limit,
    creatable: !st && creatable !== false,
  };
}

function dailyNotes(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => MD_NAME_RE.test(f)).sort().reverse();
  } catch {
    return [];
  }
}

function openclawMarkdown(cfg) {
  if (!cfg.exists) return [];
  const c = cfg.parsed || {};
  const defaults = (c.agents && c.agents.defaults) || {};
  const perFile = limitFrom(defaults.bootstrapMaxChars, OPENCLAW_MAX_CHARS, 'bootstrapMaxChars',
    'OpenClaw truncates it when injecting it into the system prompt');
  const total = limitFrom(defaults.bootstrapTotalMaxChars, OPENCLAW_TOTAL_MAX_CHARS, 'bootstrapTotalMaxChars',
    'OpenClaw truncates the workspace files when injecting them into the system prompt');
  return openclawWorkspaces(c).map((w) => {
    const visible = fs.existsSync(w.path);
    const notes = visible ? dailyNotes(path.join(w.path, 'memory')) : [];
    const files = !visible
      ? []
      : [
          ...OPENCLAW_BOOTSTRAP.map((f) =>
            mdEntry({ key: `${w.id}:${f.name}`, base: w.path, rel: f.name, what: f.what, creatable: f.creatable, limit: perFile, count: countUnits })
          ).map((f) => ({ ...f, inTotal: true })),
          // Searched by the memory tool, never injected: no limit applies.
          ...notes.slice(0, DAILY_SHOWN).map((n) =>
            mdEntry({ key: `${w.id}:memory/${n}`, base: w.path, rel: path.join('memory', n), what: 'Daily note', creatable: false, limit: null, count: countUnits })
          ),
        ];
    return {
      id: w.id,
      label: w.id === 'default' ? 'Workspace' : `Workspace of agent ${w.id}`,
      path: w.path,
      visible,
      files,
      hidden: Math.max(0, notes.length - DAILY_SHOWN),
      total: { chars: files.filter((f) => f.inTotal).reduce((n, f) => n + f.chars, 0), limit: total },
    };
  });
}

function yamlFile(file) {
  try {
    const v = YAML.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// The default home plus each profile, which carries its own SOUL.md, memories and config.
function hermesMarkdown() {
  const dir = hermesDir();
  const homes = [
    { id: 'default', label: 'Default profile', path: dir },
    ...listDirs(path.join(dir, 'profiles')).map((p) => ({ id: `profile/${p}`, label: `Profile ${p}`, path: path.join(dir, 'profiles', p) })),
  ];
  return homes.map((h) => {
    const visible = fs.existsSync(h.path);
    const conf = (visible && yamlFile(path.join(h.path, 'config.yaml'))) || {};
    const memory = conf.memory && typeof conf.memory === 'object' ? conf.memory : {};
    const files = !visible
      ? []
      : HERMES_FILES.map((f) =>
          mdEntry({
            key: `${h.id}:${f.rel}`,
            base: h.path,
            rel: f.rel,
            what: f.what,
            limit: f.limitKey
              ? limitFrom(memory[f.limitKey], f.defaultLimit, f.limitKey, 'Hermes\' memory tool refuses every new entry until it is back under the limit')
              : null,
            count: countCodePoints,
          })
        );
    return { id: h.id, label: h.label, path: h.path, visible, files, hidden: 0, total: null };
  });
}

function findMarkdown(groups, key) {
  for (const g of groups) {
    const f = g.files.find((x) => x.key === key);
    if (f) return { group: g, file: f };
  }
  return null;
}

function symlinkError(f) {
  return `${f.path} is a symlink to ${f.symlink}: edit the target instead — writing here would replace the link with a plain file.`;
}

function readMarkdown(groups, key) {
  const found = findMarkdown(groups, key);
  if (!found) return { error: `Unknown file: ${key}`, status: 404 };
  const f = found.file;
  if (f.symlink) return { error: symlinkError(f), status: 409 };
  if (!f.exists) return { ...f, content: '' };
  if (fs.statSync(f.path).size > MAX_MD) return { error: `${f.path} exceeds ${MAX_MD} bytes`, status: 413 };
  return { ...f, content: fs.readFileSync(f.path, 'utf8') };
}

// buildLineDiff compares index by index, which suits JSON keys replaced in place; prose gains
// and loses lines, and that would mark everything below the first insertion as changed.
// Common prefix and suffix trimmed, LCS on what remains, a plain block swap past a size cap.
function lineDiff(oldLines, newLines) {
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) suf++;
  const a = oldLines.slice(pre, oldLines.length - suf);
  const b = newLines.slice(pre, newLines.length - suf);

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: 'context', old: i, text: oldLines[i] });
  if ((a.length + 1) * (b.length + 1) <= 1e6) {
    const t = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ kind: 'context', old: pre + i, text: a[i] });
        i++;
        j++;
      } else if (i < a.length && (j === b.length || t[i + 1][j] >= t[i][j + 1])) {
        ops.push({ kind: 'removed', old: pre + i, text: a[i] });
        i++;
      } else {
        ops.push({ kind: 'added', old: null, text: b[j] });
        j++;
      }
    }
  } else {
    a.forEach((text, k) => ops.push({ kind: 'removed', old: pre + k, text }));
    b.forEach((text) => ops.push({ kind: 'added', old: null, text }));
  }
  for (let k = oldLines.length - suf; k < oldLines.length; k++) ops.push({ kind: 'context', old: k, text: oldLines[k] });

  const keep = new Set();
  ops.forEach((o, k) => {
    if (o.kind !== 'context') for (let d = -3; d <= 3; d++) keep.add(k + d);
  });
  return ops.filter((o, k) => keep.has(k)).map((o) => ({ kind: o.kind, line: o.old === null ? null : o.old + 1, text: o.text }));
}

function previewMarkdown(groups, body, count, cost) {
  const found = findMarkdown(groups, body.key);
  if (!found) return { error: `Unknown file: ${body.key}` };
  const { group, file: f } = found;
  if (f.symlink) return { error: symlinkError(f) };
  if (!f.exists && !f.creatable) return { error: `${f.name} is not created from here.` };
  const value = body.content;
  if (typeof value !== 'string') return { error: 'content must be a string' };
  if (Buffer.byteLength(value) > MAX_MD) return { error: `content exceeds ${MAX_MD} bytes` };
  if (value.includes('\0')) return { error: 'content must not contain a NUL byte' };
  const current = f.exists ? fs.readFileSync(f.path, 'utf8') : null;
  if (current === value) return { error: 'No change.' };

  const n = count(value);
  const warnings = [];
  if (!value.trim()) warnings.push(`${f.name} would be empty.`);
  if (f.limit && n > f.limit.chars) {
    warnings.push(
      `${n} characters, above ${f.limit.setting} (${f.limit.chars}${f.limit.isDefault ? ', default' : ''}): ${f.limit.effect}.`
    );
  }
  if (f.inTotal && group.total) {
    const total = group.total.chars - f.chars + n;
    const l = group.total.limit;
    if (total > l.chars) {
      warnings.push(`The workspace files would total ${total} characters, above ${l.setting} (${l.chars}${l.isDefault ? ', default' : ''}): ${l.effect}.`);
    }
  }

  const restart = { kind: 'none', containerName: null, command: null, cwd: null, cost };
  const lines = (t) => t.split('\n').length - 1;
  if (current === null) {
    const st = fs.statSync(group.path);
    return {
      response: {
        token: crypto.randomUUID(),
        file: f.path,
        summary: `Creating ${f.path} (${lines(value)} lines)`,
        diff: value.split('\n').map((text) => ({ kind: 'added', line: null, text })),
        warnings,
        restart,
      },
      plan: { target: 'agent-md-create', file: f.path, content: value, uid: st.uid, gid: st.gid },
    };
  }
  return {
    response: {
      token: crypto.randomUUID(),
      file: f.path,
      summary: `${f.path} rewritten (${lines(current)} → ${lines(value)} lines)`,
      diff: lineDiff(current.split('\n'), value.split('\n')),
      warnings,
      restart,
    },
    plan: { target: 'agent-md', file: f.path, hash: apps().sha(current), content: value },
  };
}

// Rewrites go through applyPlan: hash check, timestamped backup, owner and mode kept.
// Creation is the only extra path — a missing memories/ directory included.
function applyMarkdown(plan) {
  if (plan.target !== 'agent-md-create') return apps().applyPlan(plan);
  if (fs.existsSync(plan.file)) return { conflict: true };
  const dir = path.dirname(plan.file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
    fs.chownSync(dir, plan.uid, plan.gid);
  }
  apps().writePreserving(plan.file, plan.content, 0o644, plan.uid, plan.gid);
  return { ok: true, backup: null };
}

// ---------- registry entries ----------

const OPENCLAW_APP = {
  id: 'openclaw',
  label: 'OpenClaw',
  get projectDir() {
    return openclawDir();
  },
  containerName: null,
  detect: () => detectAgent('openclaw', 'OpenClaw', openclawConfigFile(), 'openclaw'),
  read: readOpenclaw,
  preview: previewOpenclaw,
  apply: applyMarkdown,
  readFile: (key) => readMarkdown(openclawMarkdown(openclawConfig()), key),
  facts: openclawFacts,
};

const HERMES_APP = {
  id: 'hermes',
  label: 'Hermes',
  get projectDir() {
    return hermesDir();
  },
  containerName: null,
  detect: () => detectAgent('hermes', 'Hermes Agent', hermesConfigFile(), 'hermes'),
  read: readHermes,
  preview: previewHermes,
  apply: applyMarkdown,
  readFile: (key) => readMarkdown(hermesMarkdown(), key),
  facts: hermesFacts,
};

module.exports = { OPENCLAW_APP, HERMES_APP, nemoclawFacts, agentOf, safeUrl, served, lineDiff };
