// App registry: reads (and surgically edits) the compose files of OTHER projects
// on this host. No YAML serializer anywhere — the target compose.yaml is full of
// hand-written comments that a parse/re-emit round-trip would destroy, so edits
// are textual replacements of a single located line.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const SECRET_KEY_RE = /TOKEN|KEY|SECRET|PASSWORD/i;

// Single masking point: used by the API responses AND by the facts feeding rules.js.
function mask(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) out[k] = SECRET_KEY_RE.test(k) ? '***' : v;
  return out;
}

const SAGE_NOTE =
  'Deliberately disabled: its own nvcc command hardcodes -std=c++17, which no environment ' +
  'variable can override. Re-enabled as is, the script will fail to compile (see userscripts_dir/README-fixes.md).';

const SAGE_SCRIPTS = ['20-SageAttention2.sh', '21-SageAttention3-BlackwellOnly.sh'];

const KNOWN_FLAGS = [
  { flag: '--bf16-unet', label: 'UNet in bf16', why: 'Half the memory for the UNet, faster on Blackwell which natively computes in bf16.', danger: null },
  { flag: '--bf16-vae', label: 'VAE in bf16', why: 'VAE decoding in bf16: less memory at decode time, a clear gain on large resolutions.', danger: null },
  { flag: '--bf16-text-enc', label: 'Text encoder bf16', why: 'Loads the text encoder (CLIP/T5) in bf16: several GB of unified memory freed.', danger: null },
  { flag: '--use-sage-attention', label: 'SageAttention', why: 'Quantized attention kernel, significantly faster than PyTorch attention — requires SageAttention to be compiled into the image.', danger: null },
  { flag: '--highvram', label: 'highvram', why: 'Keeps every model in VRAM between runs.', danger: 'HARMFUL on unified memory: pins every model at once and causes OOM on GB10.' },
];

const CMDLINE_KEY = 'COMFY_CMDLINE_EXTRA';

// ---------- ComfyUI ----------

function comfyDir() {
  return process.env.COMFY_DIR || '/home/sparks/comfyui-spark';
}
function composeFile() {
  return path.join(comfyDir(), 'compose.yaml');
}
function scriptsDir() {
  return path.join(comfyDir(), 'userscripts_dir');
}

function detectComfy() {
  if (!fs.existsSync(composeFile())) return { detected: false, reason: `compose.yaml not found in ${comfyDir()}` };
  if (!fs.existsSync(scriptsDir())) return { detected: false, reason: `userscripts_dir not found in ${comfyDir()}` };
  return { detected: true, reason: '' };
}

// Index of the single active (non-commented) COMFY_CMDLINE_EXTRA line.
function findCmdlineIndex(lines) {
  return lines.findIndex((l) => /^(\s*COMFY_CMDLINE_EXTRA:[ \t]*)(.*)$/.test(l));
}

function cleanValue(v) {
  let s = v.replace(/\s#.*$/, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

function parseEnv(lines) {
  const env = {};
  const start = lines.findIndex((l) => /^(\s*)environment:\s*$/.test(l));
  if (start === -1) return env;
  const baseIndent = lines[start].match(/^(\s*)/)[1].length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= baseIndent) break;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) env[m[1]] = cleanValue(m[2]);
  }
  return env;
}

function readScripts() {
  return fs
    .readdirSync(scriptsDir())
    .filter((f) => f.endsWith('.sh') || f.endsWith('.sh.disabled'))
    .sort()
    .map((f) => {
      const name = f.replace(/\.disabled$/, '');
      const enabled = f.endsWith('.sh') && !!(fs.statSync(path.join(scriptsDir(), f)).mode & 0o111);
      return { name, enabled, note: SAGE_SCRIPTS.includes(name) ? SAGE_NOTE : null };
    });
}

async function containerRunning(name) {
  try {
    const list = await docker.listContainers();
    return list.some((c) => (c.Names || []).includes(`/${name}`));
  } catch {
    return false;
  }
}

async function readComfy() {
  const lines = fs.readFileSync(composeFile(), 'utf8').split('\n');
  const idx = findCmdlineIndex(lines);
  const raw = idx === -1 ? '' : cleanValue(lines[idx].match(/^\s*COMFY_CMDLINE_EXTRA:[ \t]*(.*)$/)[1]);
  const scripts = readScripts();
  return {
    composeFile: composeFile(),
    cmdline: { raw, flags: raw.split(/\s+/).filter((f) => f.startsWith('--')), known: KNOWN_FLAGS },
    env: mask(parseEnv(lines)),
    scripts,
  };
}

async function comfyFacts() {
  const d = detectComfy();
  if (!d.detected) return null;
  const r = await readComfy();
  const scriptEnabled = {};
  for (const s of r.scripts) scriptEnabled[s.name] = s.enabled;
  return { flags: r.cmdline.flags, env: r.env, scriptEnabled };
}

const RESTART_RECREATE = {
  kind: 'recreate',
  containerName: 'comfyui-nvidia',
  command: 'docker compose up -d',
  cwd: null, // filled per-call with the live projectDir
  cost: 'Container recreation: full reload of the ComfyUI models, several minutes.',
};
const RESTART_RESTART = {
  kind: 'restart',
  containerName: 'comfyui-nvidia',
  command: null,
  cwd: null,
  cost: 'Container restart: the bind-mounted scripts are re-read on startup, a few minutes.',
};

function validateValue(v) {
  if (typeof v !== 'string') return 'value must be a string';
  if (v.length > 2000) return 'value exceeds 2000 characters';
  if (/[\n\r]/.test(v)) return 'value must not contain a line break';
  if (v.includes(' #')) return 'value must not contain " #": it would turn the rest of the line into a YAML comment';
  if (/^[\s"']|[\s"']$/.test(v)) return 'value must not start or end with a space or quote';
  return null;
}

function cmdlineWarnings(value, scriptEnabled) {
  const w = [];
  if (value.includes('--highvram')) {
    w.push('--highvram is HARMFUL on unified memory: it pins every model at once and causes OOM on GB10.');
  }
  if (value.includes('--use-sage-attention') && !SAGE_SCRIPTS.some((s) => scriptEnabled[s])) {
    w.push('SageAttention is not compiled into the image (scripts 20/21 disabled): ComfyUI will not start with this flag.');
  }
  return w;
}

// Returns { error } or { response, plan }.
function previewComfy(body) {
  const target = body && body.target;
  if (target === 'cmdline') {
    const err = validateValue(body.value);
    if (err) return { error: err };
    const content = fs.readFileSync(composeFile(), 'utf8');
    const lines = content.split('\n');
    const idx = findCmdlineIndex(lines);
    if (idx === -1) return { error: `${CMDLINE_KEY} not found in ${composeFile()}` };
    const prefix = lines[idx].match(/^(\s*COMFY_CMDLINE_EXTRA:[ \t]*)/)[1];
    const newLine = prefix + body.value;

    const diff = [];
    for (let i = Math.max(0, idx - 3); i < idx; i++) diff.push({ kind: 'context', line: i + 1, text: lines[i] });
    diff.push({ kind: 'removed', line: idx + 1, text: lines[idx] });
    diff.push({ kind: 'added', line: null, text: newLine });
    for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + 3); i++) diff.push({ kind: 'context', line: i + 1, text: lines[i] });

    const scriptEnabled = {};
    for (const s of readScripts()) scriptEnabled[s.name] = s.enabled;

    const newLines = lines.slice();
    newLines[idx] = newLine;
    return {
      response: {
        token: crypto.randomUUID(),
        file: composeFile(),
        summary: `Line ${idx + 1} of compose.yaml: ${CMDLINE_KEY} changed`,
        diff,
        warnings: cmdlineWarnings(body.value, scriptEnabled),
        restart: { ...RESTART_RECREATE, cwd: comfyDir() },
      },
      plan: { target: 'cmdline', file: composeFile(), hash: sha(content), content: newLines.join('\n') },
    };
  }

  if (target === 'script') {
    const known = readScripts();
    const entry = known.find((s) => s.name === body.name);
    if (!entry) return { error: `Unknown script: ${body.name}` };
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    const from = path.join(scriptsDir(), entry.enabled ? entry.name : `${entry.name}.disabled`);
    const to = path.join(scriptsDir(), body.enabled ? entry.name : `${entry.name}.disabled`);
    const warnings = [];
    if (body.enabled && SAGE_SCRIPTS.includes(entry.name)) warnings.push(SAGE_NOTE);
    return {
      response: {
        token: crypto.randomUUID(),
        file: from,
        summary:
          from === to
            ? `${entry.name} is already ${body.enabled ? 'enabled' : 'disabled'}, no rename`
            : `Renaming ${path.basename(from)} → ${path.basename(to)}`,
        diff: [],
        warnings,
        restart: { ...RESTART_RESTART },
      },
      plan: { target: 'script', file: from, hash: sha(from), from, to },
    };
  }

  return { error: 'target must be "cmdline" or "script"' };
}

// ---------- writing ----------

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Atomic, and above all ownership-preserving: this process runs as root inside the
// container while the target files belong to uid 1000 — a naive write would leave
// the user unable to edit his own project.
function writePreserving(file, content, mode, uid, gid) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
  fs.chownSync(file, uid, gid);
}

function applyPlan(plan) {
  if (plan.target === 'script') {
    if (!fs.existsSync(plan.from)) return { conflict: true };
    if (plan.from !== plan.to) fs.renameSync(plan.from, plan.to);
    return { ok: true, backup: null };
  }
  const current = fs.readFileSync(plan.file, 'utf8');
  if (sha(current) !== plan.hash) return { conflict: true };
  const st = fs.statSync(plan.file);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backup = `${plan.file}.bak-${stamp}`;
  writePreserving(backup, current, st.mode, st.uid, st.gid);
  writePreserving(plan.file, plan.content, st.mode, st.uid, st.gid);
  return { ok: true, backup };
}

// ---------- opencode ----------

function opencodeDir() {
  return process.env.OPENCODE_DIR || '/home/sparks/.config/opencode';
}
function opencodeConfigFile() {
  return path.join(opencodeDir(), 'opencode.json');
}

function detectOpencode() {
  const file = opencodeConfigFile();
  if (!fs.existsSync(file)) return { detected: false, reason: `opencode.json not found in ${opencodeDir()}` };
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { detected: false, reason: `opencode.json does not parse: ${e.message}` };
  }
  return { detected: true, reason: '' };
}

// JSON.parse/JSON.stringify round-trips destroy comments. opencode.json is normally
// strict JSON, but refuse to touch it if it looks like JSONC (// or /* outside a string).
function hasJsonComments(text) {
  const withoutStrings = text.replace(/"(?:\\.|[^"\\])*"/g, '""');
  return /\/\/|\/\*/.test(withoutStrings);
}

// Inside the container `localhost` is the container itself, not the host where
// ollama-api publishes 11434 — hence OLLAMA_URL, set to the host gateway in
// docker-compose.yml. The localhost default keeps host-side tests working.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

async function fetchOllamaTags() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return null; // unreachable
  }
}

async function ollamaContextLengthFromContainer() {
  try {
    const info = await docker.getContainer('ollama-api').inspect();
    const line = (info.Config.Env || []).find((e) => e.startsWith('OLLAMA_CONTEXT_LENGTH='));
    if (!line) return null;
    const n = parseInt(line.slice('OLLAMA_CONTEXT_LENGTH='.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function ollamaInfo() {
  const installed = await fetchOllamaTags();
  if (installed === null) return { reachable: false, contextLength: null, installed: [] };
  return { reachable: true, contextLength: await ollamaContextLengthFromContainer(), installed };
}

function providerModels(config) {
  return (config.provider && config.provider.ollama && config.provider.ollama.models) || {};
}

async function readOpencode() {
  const config = JSON.parse(fs.readFileSync(opencodeConfigFile(), 'utf8'));
  const declared = providerModels(config);
  const ollama = await ollamaInfo();
  const models = Object.entries(declared).map(([id, m]) => ({
    id,
    name: m.name,
    context: m.limit && m.limit.context,
    output: m.limit && m.limit.output,
    servedByOllama: ollama.installed.includes(id),
  }));
  return {
    projectDir: opencodeDir(),
    configFile: opencodeConfigFile(),
    model: config.model,
    models,
    ollama,
    compaction: config.compaction,
  };
}

async function opencodeFacts() {
  const d = detectOpencode();
  if (!d.detected) return null;
  const config = JSON.parse(fs.readFileSync(opencodeConfigFile(), 'utf8'));
  const declared = providerModels(config);
  const ollama = await ollamaInfo();
  return {
    declaredContexts: Object.values(declared).map((m) => m.limit && m.limit.context),
    ollamaContextLength: ollama.contextLength,
    declared: Object.keys(declared),
    installed: ollama.installed,
  };
}

const OPENCODE_RESTART = {
  kind: 'none',
  containerName: null,
  command: null,
  cwd: null,
  cost: 'No restart needed — opencode reads its config at the start of each session.',
};

// Index-wise diff: every opencode edit only replaces values on existing keys, never
// adds/removes a key, so before/after serializations always have the same line count —
// a plain per-line comparison is enough, no LCS needed.
function buildLineDiff(oldLines, newLines) {
  const len = Math.max(oldLines.length, newLines.length);
  const changed = [];
  for (let i = 0; i < len; i++) if (oldLines[i] !== newLines[i]) changed.push(i);

  const diff = [];
  let lastEnd = -1;
  for (const idx of changed) {
    const start = Math.max(0, idx - 3, lastEnd + 1);
    for (let i = start; i < idx; i++) diff.push({ kind: 'context', line: i + 1, text: oldLines[i] });
    diff.push({ kind: 'removed', line: idx + 1, text: oldLines[idx] });
    diff.push({ kind: 'added', line: null, text: newLines[idx] });
    const end = Math.min(oldLines.length - 1, idx + 3);
    for (let i = idx + 1; i <= end; i++) diff.push({ kind: 'context', line: i + 1, text: oldLines[i] });
    lastEnd = end;
  }
  return diff;
}

const COMPACTION_VALIDATORS = {
  auto: (v) => typeof v === 'boolean',
  prune: (v) => typeof v === 'boolean',
  preserveSystemPrompt: (v) => typeof v === 'boolean',
  threshold: (v) => typeof v === 'number' && v > 0 && v < 1,
  reserved: (v) => Number.isInteger(v) && v >= 0,
  preserveRecentMessages: (v) => Number.isInteger(v) && v >= 0,
  strategy: (v) => v === 'summarize' || v === 'truncate',
};

// Returns { error } or { response, plan }. Async: warnings need a live read of Ollama.
async function previewOpencode(body) {
  const target = body && body.target;
  if (!['model', 'context', 'compaction'].includes(target)) {
    return { error: 'target must be "model", "context" or "compaction"' };
  }

  const file = opencodeConfigFile();
  const content = fs.readFileSync(file, 'utf8');
  if (hasJsonComments(content)) {
    return { error: `${file} looks like JSONC (contains // or /*): refusing a JSON.parse/stringify round-trip that would destroy comments` };
  }
  const config = JSON.parse(content);
  const models = providerModels(config);
  const ollama = await ollamaInfo();
  const warnings = [];
  let summary;

  if (target === 'model') {
    if (typeof body.value !== 'string') return { error: 'value must be a string' };
    const id = body.value.replace(/^ollama\//, '');
    if (!Object.prototype.hasOwnProperty.call(models, id)) return { error: `Unknown model: ${body.value}` };
    config.model = body.value;
    if (!ollama.installed.includes(id)) warnings.push('Ollama does not currently serve this model.');
    summary = `Default model changed to ${body.value}`;
  } else if (target === 'context') {
    if (!Number.isInteger(body.value) || body.value < 4096 || body.value > 1048576) {
      return { error: 'value must be an integer in [4096, 1048576]' };
    }
    for (const m of Object.values(models)) {
      if (m.limit) m.limit.context = body.value;
    }
    if (ollama.contextLength !== null && body.value !== ollama.contextLength) {
      warnings.push(
        `Ollama serves ${ollama.contextLength} tokens: opencode would advertise a context it will not get, and long conversations would be silently truncated.`
      );
    }
    summary = `limit.context set to ${body.value} on ${Object.keys(models).length} model(s)`;
  } else {
    const value = body.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'value must be an object' };
    for (const k of Object.keys(value)) {
      if (!COMPACTION_VALIDATORS[k]) return { error: `Unknown compaction key: ${k}` };
      if (!COMPACTION_VALIDATORS[k](value[k])) return { error: `Invalid value for compaction.${k}` };
    }
    config.compaction = { ...(config.compaction || {}), ...value };
    summary = `compaction updated: ${Object.keys(value).join(', ')}`;
  }

  const newContent = JSON.stringify(config, null, 2) + '\n';
  const diff = buildLineDiff(content.split('\n'), newContent.split('\n'));

  return {
    response: {
      token: crypto.randomUUID(),
      file,
      summary,
      diff,
      warnings,
      restart: { ...OPENCODE_RESTART },
    },
    plan: { target: 'opencode-config', file, hash: sha(content), content: newContent },
  };
}

// ---------- registry ----------

const APPS = [
  {
    id: 'comfyui',
    label: 'ComfyUI',
    hidden: true,
    get projectDir() {
      return comfyDir();
    },
    containerName: 'comfyui-nvidia',
    detect: detectComfy,
    read: readComfy,
    preview: previewComfy,
    apply: applyPlan,
    facts: comfyFacts,
  },
  {
    id: 'opencode',
    label: 'opencode',
    get projectDir() {
      return opencodeDir();
    },
    containerName: null,
    detect: detectOpencode,
    read: readOpencode,
    preview: previewOpencode,
    apply: applyPlan,
    facts: opencodeFacts,
  },
];

// ---------- routes ----------

const previews = new Map(); // token -> { appId, plan, restart, createdAt }
const TTL = 5 * 60 * 1000;

async function summarize(app) {
  const d = app.detect();
  return {
    id: app.id,
    label: app.label,
    detected: d.detected,
    reason: d.reason,
    containerName: app.containerName,
    containerRunning: await containerRunning(app.containerName),
    projectDir: app.projectDir,
  };
}

router.get('/', async (req, res) => {
  res.json({ apps: await Promise.all(APPS.filter((a) => !a.hidden).map(summarize)) });
});

router.get('/:id', async (req, res) => {
  const app = APPS.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'Unknown app' });
  const base = await summarize(app);
  if (!base.detected) return res.json(base);
  res.json({ ...base, ...(await app.read()) });
});

router.post('/:id/preview', async (req, res) => {
  const app = APPS.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'Unknown app' });
  const r = await app.preview(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  previews.set(r.response.token, { appId: app.id, plan: r.plan, restart: r.response.restart, createdAt: Date.now() });
  res.json(r.response);
});

router.post('/:id/apply', (req, res) => {
  const app = APPS.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'Unknown app' });
  const entry = previews.get((req.body || {}).token);
  if (!entry || entry.appId !== app.id || Date.now() - entry.createdAt > TTL) {
    return res.status(400).json({ error: 'Preview expired, run the preview again' });
  }
  previews.delete(req.body.token);
  const r = app.apply(entry.plan);
  if (r.conflict) return res.status(409).json({ error: 'The file changed since the preview, run the preview again' });
  res.json({ ok: true, backup: r.backup, restart: entry.restart });
});

module.exports = { router, APPS, mask };
