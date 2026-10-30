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

test('OpenClaw: skills, with copies shared with Claude Code flagged', async () => {
  const s = (await openclaw.read()).standalone;
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

// ---------- markdown files ----------

const WS = path.join(DIR, '.openclaw', 'workspace');
const stat = (f) => {
  const st = fs.statSync(f);
  return `${st.uid}:${st.gid}:${(st.mode & 0o777).toString(8)}`;
};

test('OpenClaw markdown: one group per workspace, bootstrap files with their limit, daily notes newest first', async () => {
  const groups = (await openclaw.read()).markdown;
  assert.deepStrictEqual(groups.map((g) => [g.id, g.path, g.visible]), [
    ['default', WS, true],
    ['ops', path.join(DIR, '.openclaw', 'workspace-ops'), true],
  ]);
  const files = groups[0].files;
  const by = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.deepStrictEqual([by['AGENTS.md'].exists, by['AGENTS.md'].lines, by['AGENTS.md'].chars], [true, 3, '# Agents\n\nBe brief.\n'.length]);
  assert.deepStrictEqual([by['USER.md'].exists, by['USER.md'].creatable], [false, true]);
  // the first-run ritual is never re-created
  assert.strictEqual(by['BOOTSTRAP.md'].creatable, false);
  assert.deepStrictEqual(by['SOUL.md'].limit, {
    chars: 20000,
    setting: 'bootstrapMaxChars',
    isDefault: true,
    effect: 'OpenClaw truncates it when injecting it into the system prompt',
  });
  assert.deepStrictEqual(files.filter((f) => f.name.startsWith('memory')).map((f) => [f.key, f.limit]), [
    ['default:memory/2026-10-30.md', null],
    ['default:memory/2026-10-29.md', null],
  ]);
  assert.strictEqual(groups[0].total.chars, by['AGENTS.md'].chars + by['SOUL.md'].chars);
});

test('Hermes markdown: one group per profile, memory limits from that profile\'s config or the documented defaults', async () => {
  const groups = (await hermes.read()).markdown;
  assert.deepStrictEqual(groups.map((g) => g.id), ['default', 'profile/work']);
  const by = Object.fromEntries(groups[0].files.map((f) => [f.name, f]));
  assert.deepStrictEqual([by['SOUL.md'].exists, by['SOUL.md'].lines, by['SOUL.md'].limit], [true, 2, null]);
  assert.deepStrictEqual([by[path.join('memories', 'MEMORY.md')].limit.chars, by[path.join('memories', 'MEMORY.md')].limit.isDefault], [2200, true]);
  // set in the fixture's config.yaml
  assert.deepStrictEqual([by[path.join('memories', 'USER.md')].limit.chars, by[path.join('memories', 'USER.md')].limit.isDefault], [500, false]);
  // the work profile has no config.yaml of its own: defaults
  assert.strictEqual(groups[1].files.find((f) => f.name.endsWith('USER.md')).limit.chars, 1375);
});

test('readFile serves the listed files and nothing else', () => {
  assert.strictEqual(openclaw.readFile('default:SOUL.md').content, '# Soul\n');
  assert.strictEqual(openclaw.readFile('default:USER.md').content, '');
  for (const key of ['default:../openclaw.json', 'default:credentials/whatsapp/creds.json', 'default:memory/../../openclaw.json', '', 'nope']) {
    assert.strictEqual(openclaw.readFile(key).status, 404, key);
  }
  assert.strictEqual(hermes.readFile('default:.env').status, 404);
  assert.strictEqual(hermes.readFile(`profile/work:SOUL.md`).content, 'You are the work profile.\n');
});

test('lineDiff marks an inserted line as one addition, not as everything below it', () => {
  const { lineDiff } = require('./agents');
  const d = lineDiff(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], ['a', 'b', 'c', 'd', 'X', 'e', 'f', 'g', 'h', 'i']);
  assert.deepStrictEqual(d.filter((l) => l.kind !== 'context'), [{ kind: 'added', line: null, text: 'X' }]);
  assert.deepStrictEqual(d.map((l) => l.text), ['b', 'c', 'd', 'X', 'e', 'f', 'g']);
  const r = lineDiff(['a', 'b'], ['a', 'B']);
  assert.deepStrictEqual(r.map((l) => l.kind), ['context', 'removed', 'added']);
});

test('editing AGENTS.md: preview writes nothing, apply keeps owner and mode and leaves a backup', () => {
  const file = path.join(WS, 'AGENTS.md');
  const before = fs.readFileSync(file, 'utf8');
  const owner = stat(file);
  const r = openclaw.preview({ target: 'markdown', key: 'default:AGENTS.md', content: '# Agents\n\nBe brief.\nAnswer in French.\n' });
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.response.diff.filter((l) => l.kind !== 'context'), [{ kind: 'added', line: null, text: 'Answer in French.' }]);
  assert.deepStrictEqual(r.response.warnings, []);
  assert.strictEqual(r.response.restart.kind, 'none');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'preview modified the file');

  const res = openclaw.apply(r.plan);
  assert.strictEqual(res.ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /Answer in French\.\n$/);
  assert.strictEqual(stat(file), owner);
  assert.strictEqual(fs.readFileSync(res.backup, 'utf8'), before);
});

test('apply refuses when the agent rewrote the file after the preview', () => {
  const file = path.join(DIR, '.hermes', 'memories', 'MEMORY.md');
  const r = hermes.preview({ target: 'markdown', key: 'default:memories/MEMORY.md', content: '- Consolidated.\n' });
  fs.appendFileSync(file, '- Written by the agent meanwhile.\n');
  assert.strictEqual(hermes.apply(r.plan).conflict, true);
  assert.match(fs.readFileSync(file, 'utf8'), /meanwhile/);
});

test('creating a file: whole content shown, written with the owner of its directory, memories/ included', () => {
  const r = openclaw.preview({ target: 'markdown', key: 'default:USER.md', content: '# User\n\nLives in Lyon.\n' });
  assert.match(r.response.summary, /^Creating /);
  assert.ok(r.response.diff.every((l) => l.kind === 'added'));
  assert.strictEqual(openclaw.apply(r.plan).ok, true);
  const owner = fs.statSync(WS);
  const st = fs.statSync(path.join(WS, 'USER.md'));
  assert.deepStrictEqual([st.uid, st.gid], [owner.uid, owner.gid]);
  assert.strictEqual(openclaw.apply(r.plan).conflict, true, 'a second create must not overwrite');

  const work = path.join(DIR, '.hermes', 'profiles', 'work');
  const h = hermes.preview({ target: 'markdown', key: 'profile/work:memories/USER.md', content: '- Prefers short answers.\n' });
  assert.strictEqual(hermes.apply(h.plan).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(work, 'memories', 'USER.md'), 'utf8'), '- Prefers short answers.\n');

  assert.match(openclaw.preview({ target: 'markdown', key: 'default:BOOTSTRAP.md', content: 'x\n' }).error, /not created from here/);
});

test('limits warn, they do not block — and Hermes counts code points like Python does', () => {
  // 'é' + an emoji: 2 code points, 3 UTF-16 units
  const user = 'é😀'.repeat(250) + '\n';
  const h = hermes.preview({ target: 'markdown', key: 'default:memories/USER.md', content: user });
  assert.deepStrictEqual(h.response.warnings, [
    '501 characters, above user_char_limit (500): Hermes\' memory tool refuses every new entry until it is back under the limit.',
  ]);
  const o = openclaw.preview({ target: 'markdown', key: 'default:SOUL.md', content: 'x'.repeat(61000) });
  assert.strictEqual(o.response.warnings.length, 2);
  assert.match(o.response.warnings[0], /above bootstrapMaxChars \(20000, default\)/);
  assert.match(o.response.warnings[1], /would total \d+ characters, above bootstrapTotalMaxChars \(60000, default\)/);
  assert.match(openclaw.preview({ target: 'markdown', key: 'default:SOUL.md', content: '  \n' }).response.warnings[0], /would be empty/);
});

test('what preview refuses: unchanged content, NUL bytes, oversize, symlinks, unknown keys, config targets', () => {
  const p = (key, content) => openclaw.preview({ target: 'markdown', key, content }).error;
  assert.match(p('default:SOUL.md', '# Soul\n'), /No change/);
  assert.match(p('default:SOUL.md', 'a\0b'), /NUL/);
  assert.match(p('default:SOUL.md', 'x'.repeat(256 * 1024 + 1)), /exceeds/);
  assert.match(p('default:../openclaw.json', 'x'), /Unknown file/);
  assert.match(p('default:SOUL.md', 42), /must be a string/);

  const target = path.join(DIR, 'shared-tools.md');
  fs.writeFileSync(target, '# Tools synced elsewhere\n');
  fs.symlinkSync(target, path.join(WS, 'TOOLS.md'));
  assert.match(p('default:TOOLS.md', 'replaced\n'), /symlink to .*shared-tools\.md/);
  assert.strictEqual(openclaw.readFile('default:TOOLS.md').status, 409);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '# Tools synced elsewhere\n');

  assert.match(openclaw.preview({ target: 'model', value: 'x' }).error, /config is read-only/);
});
