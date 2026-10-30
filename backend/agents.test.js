// Self-contained like apps.test.js: the three fixture homes are copied into a fresh temp
// dir, every *_DIR points at the copy, and a stub Ollama answers /api/tags — this suite
// needs no setup and can never touch a real install. Every secret in the fixtures carries
// the word SECRET (or `+336…` for the phone number), so one regex proves nothing leaks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
for (const name of ['openclaw', 'hermes', 'nemoclaw']) {
  fs.cpSync(path.join(__dirname, 'fixtures', name), DIR, { recursive: true });
}
fs.mkdirSync(path.join(DIR, '.claude', 'skills', 'web-search'), { recursive: true });
fs.writeFileSync(path.join(DIR, '.claude', 'skills', 'web-search', 'SKILL.md'), '---\nname: web-search\n---\n');

// Override unconditionally: every module reads these lazily on each call.
process.env.OPENCLAW_DIR = path.join(DIR, '.openclaw');
process.env.HERMES_DIR = path.join(DIR, '.hermes');
process.env.NEMOCLAW_DIR = path.join(DIR, '.nemoclaw');
process.env.SKILLS_CLAUDE_DIR = path.join(DIR, '.claude', 'skills');
process.env.SKILLS_AGENTS_DIR = path.join(DIR, 'absent');
process.env.SKILLS_OPENCODE_DIR = path.join(DIR, 'absent');

let installed = ['qwen3:32b', 'llama3:latest'];
const ollama = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ models: installed.map((name) => ({ name })) }));
});

let APPS;
let openclaw;
let hermes;
const LEAK = /SECRET|\+336/;

test.before(async () => {
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  // apps.js reads OLLAMA_URL once, at load: it must be set before the first require.
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
  ({ APPS } = require('./apps'));
  openclaw = APPS.find((a) => a.id === 'openclaw');
  hermes = APPS.find((a) => a.id === 'hermes');
});
test.after(() => {
  ollama.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('both agents are registered, visible, and detected from their config', () => {
  assert.ok(openclaw && !openclaw.hidden);
  assert.ok(hermes && !hermes.hidden);
  assert.deepStrictEqual(openclaw.detect(), { detected: true, reason: '' });
  assert.deepStrictEqual(hermes.detect(), { detected: true, reason: '' });
});

test('OpenClaw: JSON5 parsed, models matched against Ollama, nothing secret leaves', async () => {
  const r = await openclaw.read();
  assert.ok(!LEAK.test(JSON.stringify(r)), JSON.stringify(r).match(LEAK));
  const s = r.standalone;
  assert.strictEqual(s.error, null);
  assert.deepStrictEqual(s.model.primary, { ref: 'ollama/qwen3:32b', ollamaId: 'qwen3:32b', served: true });
  // llama3 is served as llama3:latest
  assert.strictEqual(s.model.fallbacks[0].served, true);
  assert.deepStrictEqual(s.gateway, { port: 18789, portIsDefault: false, bind: 'loopback', authConfigured: true });
  assert.deepStrictEqual(s.agents, [{ id: 'main', model: null }, { id: 'ops', model: 'ollama/llama3' }]);
  // maxTokens would be '***' had it gone through mask(): the regex matches TOKEN
  assert.deepStrictEqual(s.providers[0].models, [{ id: 'qwen3:32b', contextWindow: 131072, maxTokens: 8192 }]);
  assert.strictEqual(s.providers[0].baseUrl, 'http://host.docker.internal:11434');
  assert.strictEqual(s.providers[0].apiKeySet, true);
});

test('OpenClaw: channels report policy and allowFrom size, not who is in it', async () => {
  const { channels } = (await openclaw.read()).standalone;
  const by = Object.fromEntries(channels.map((c) => [c.name, c]));
  assert.strictEqual(by.telegram.openToAnyone, true);
  assert.strictEqual(by.whatsapp.openToAnyone, false);
  assert.strictEqual(by.whatsapp.allowFromCount, 1);
  // older nested `dm.policy` shape
  assert.strictEqual(by.discord.dmPolicy, 'open');
  assert.strictEqual(by.discord.enabled, false);
});

test('OpenClaw: workspace and skills, with copies shared with Claude Code flagged', async () => {
  const s = (await openclaw.read()).standalone;
  assert.strictEqual(s.workspace.path, path.join(DIR, '.openclaw', 'workspace'));
  assert.deepStrictEqual(s.workspace.files.map((f) => [path.basename(f.path), f.lines]), [['AGENTS.md', 3], ['SOUL.md', 1]]);
  const managed = s.skills.find((r) => r.id === 'managed');
  assert.deepStrictEqual(managed.skills.map((k) => [k.name, k.sharedWith]), [['web-search', ['claude']]]);
  assert.deepStrictEqual(s.skills.find((r) => r.id === 'workspace').skills.map((k) => k.name), ['daily-brief']);
});

test('Hermes: model, terminal default, env key names only, nested skills, nothing secret leaves', async () => {
  const r = await hermes.read();
  assert.ok(!LEAK.test(JSON.stringify(r)), JSON.stringify(r).match(LEAK));
  const s = r.standalone;
  assert.deepStrictEqual(s.model, {
    default: 'qwen3:32b',
    provider: 'custom',
    baseUrl: 'http://localhost:11434/v1',
    pointsAtOllama: true,
    served: true,
  });
  assert.deepStrictEqual(s.terminal, { backend: 'local', backendIsDefault: true });
  assert.deepStrictEqual(s.compression, { enabled: true, threshold: 0.8 });
  assert.deepStrictEqual(s.envKeys, ['OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN']);
  assert.deepStrictEqual(s.identity.map((f) => [path.relative(path.join(DIR, '.hermes'), f.path), f.exists, f.lines]), [
    ['SOUL.md', true, 2],
    [path.join('memories', 'MEMORY.md'), true, 1],
    [path.join('memories', 'USER.md'), false, 0],
  ]);
  assert.deepStrictEqual(s.profiles, ['work']);
  assert.deepStrictEqual(s.skills[0].skills.map((k) => [k.name, k.category]), [['notes', undefined], ['vllm-serve', 'mlops']]);
});

test('NemoClaw: registry read tolerantly across gateways, agent inferred when absent, flagged as such', async () => {
  const { runtime } = await openclaw.read();
  assert.ok(!LEAK.test(JSON.stringify(runtime)));
  assert.strictEqual(runtime.standalone, true);
  assert.deepStrictEqual(runtime.sandboxes.map((s) => [s.name, s.agentInferred, s.isDefault, s.gpu]), [['my-assistant', true, true, true]]);
  assert.deepStrictEqual(runtime.sandboxes[0].policies, ['pypi', 'npm']);
  // hermes-box (default gateway) + deep (gateway 8090)
  assert.strictEqual(runtime.otherSandboxes, 2);
  assert.deepStrictEqual(runtime.nemoclaw.registries.map((r) => [r.gateway, r.count, r.error]), [['default', 2, null], ['8090', 1, null]]);
  assert.strictEqual(runtime.nemoclaw.legacyCredentials, true);

  const h = (await hermes.read()).runtime.sandboxes;
  assert.deepStrictEqual(h.map((s) => [s.name, s.agent, s.agentInferred, s.dashboardPort]), [['hermes-box', 'hermes', false, 18790]]);
  assert.strictEqual(h[0].fields.gatewayToken, '***');
});

test('a broken registry is reported, not thrown', async () => {
  const file = path.join(DIR, '.nemoclaw', 'gateways', '8090', 'sandboxes.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ nope');
  try {
    const { registries } = (await openclaw.read()).runtime.nemoclaw;
    assert.match(registries.find((r) => r.gateway === '8090').error, /does not parse/);
  } finally {
    fs.writeFileSync(file, before);
  }
});

test('preview refuses both agents and says what to use instead', () => {
  assert.match(openclaw.preview({ target: 'model', value: 'x' }).error, /openclaw config set/);
  assert.match(hermes.preview({}).error, /hermes config set/);
});

test('nothing installed: not detected, and the reason points at the opt-in mounts', () => {
  const saved = [process.env.OPENCLAW_DIR, process.env.NEMOCLAW_DIR];
  process.env.OPENCLAW_DIR = path.join(DIR, 'absent');
  process.env.NEMOCLAW_DIR = path.join(DIR, 'absent');
  try {
    const d = openclaw.detect();
    // a real openclaw process on the machine running the tests would legitimately detect it
    if (!d.detected) assert.match(d.reason, /compose\/openclaw\.yml/);
  } finally {
    [process.env.OPENCLAW_DIR, process.env.NEMOCLAW_DIR] = saved;
  }
});

test('process matching looks at the command, not at its arguments', () => {
  const { agentOf } = require('./agents');
  assert.strictEqual(agentOf(['openclaw-gateway']), 'openclaw');
  assert.strictEqual(agentOf(['node', '/usr/lib/node_modules/openclaw/dist/index.js', 'gateway']), 'openclaw');
  assert.strictEqual(agentOf(['/home/u/.hermes/hermes-agent/venv/bin/python', '/home/u/.hermes/hermes-agent/venv/bin/hermes', 'gateway']), 'hermes');
  assert.strictEqual(agentOf(['python3', '-m', 'hermes_cli.main']), 'hermes');
  assert.strictEqual(agentOf(['vim', '/home/u/.openclaw/openclaw.json']), null);
  assert.strictEqual(agentOf(['tail', '-f', '/home/u/.hermes/logs/agent.log']), null);
  assert.strictEqual(agentOf(['grep', '-r', 'x', '.', 'openclaw']), null);
});

test('raw config dumps go through the same scrubbing as the summaries', async () => {
  const o = (await openclaw.read()).standalone.config;
  assert.strictEqual(o.channels.whatsapp.allowFrom, '1 entry');
  assert.strictEqual(o.models.providers.ollama.baseUrl, 'http://host.docker.internal:11434');
  assert.strictEqual(o.gateway.auth, '***');
  const h = (await hermes.read()).standalone.config;
  assert.strictEqual(h.model.base_url, 'http://localhost:11434/v1');
  assert.strictEqual(h.model.api_key, '***');
  assert.deepStrictEqual(h.toolsets, ['web', 'terminal']);
});

test('safeUrl drops credentials and query, keeps placeholders', () => {
  const { safeUrl } = require('./agents');
  assert.strictEqual(safeUrl('https://u:p@api.example.com/v1?key=abc'), 'https://api.example.com/v1');
  assert.strictEqual(safeUrl('${OLLAMA_BASE_URL}'), '${OLLAMA_BASE_URL}');
  assert.strictEqual(safeUrl('not a url'), '(not a URL)');
  assert.strictEqual(safeUrl(undefined), null);
});

test('rules: open DMs and the legacy credentials file fire, served models stay silent', async () => {
  const rules = require('./rules');
  const { nemoclawFacts } = require('./agents');
  // host facts set to their quiet values, so only the rules under test can fire
  const f = { gpuClockCapSet: true, vmSwappiness: null, openclaw: await openclaw.facts(), hermes: await hermes.facts(), nemoclaw: nemoclawFacts() };
  assert.deepStrictEqual(rules.filter((r) => r.detect(f)).map((r) => r.id), ['openclaw-open-dm', 'nemoclaw-legacy-credentials']);
  const why = rules.find((r) => r.id === 'openclaw-open-dm').why(f);
  assert.match(why, /^telegram has dmPolicy "open"/);
  assert.match(why, /unsandboxed/);
});

test('rules: a model Ollama stopped serving fires for both, softer when a fallback still answers', async () => {
  const rules = require('./rules');
  installed = ['llama3:latest'];
  try {
    const f = { gpuClockCapSet: true, vmSwappiness: null, openclaw: await openclaw.facts(), hermes: await hermes.facts() };
    const fired = rules.filter((r) => r.detect(f));
    assert.deepStrictEqual(fired.map((r) => r.id), ['openclaw-open-dm', 'openclaw-model-not-served', 'hermes-model-not-served']);
    assert.strictEqual(fired[1].severity(f), 'medium');
    installed = [];
    const g = { openclaw: await openclaw.facts() };
    assert.strictEqual(rules.find((r) => r.id === 'openclaw-model-not-served').severity(g), 'high');
  } finally {
    installed = ['qwen3:32b', 'llama3:latest'];
  }
});
