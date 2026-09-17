// Run: node --test backend/skills.test.js
// Every SKILLS_*_DIR env var is pointed at a throwaway tmp tree before the router
// is ever hit, so this suite never touches the real ~/.claude/skills etc.
// scanSkills() is exported and called directly; preview/apply only exist behind
// the router, so those go through a real (loopback, ephemeral-port) HTTP server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');

const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
const CLAUDE_DIR = path.join(ROOT_TMP, 'claude-skills');
const AGENTS_DIR = path.join(ROOT_TMP, 'agents-skills');
const OPENCODE_DIR = path.join(ROOT_TMP, 'opencode-skills');
for (const d of [CLAUDE_DIR, AGENTS_DIR, OPENCODE_DIR]) fs.mkdirSync(d, { recursive: true });

assert.notStrictEqual(CLAUDE_DIR, path.join(os.homedir(), '.claude', 'skills'));
assert.notStrictEqual(AGENTS_DIR, path.join(os.homedir(), '.agents', 'skills'));
process.env.SKILLS_CLAUDE_DIR = CLAUDE_DIR;
process.env.SKILLS_AGENTS_DIR = AGENTS_DIR;
process.env.SKILLS_OPENCODE_DIR = OPENCODE_DIR;

const { router, scanSkills } = require('./skills');

function skillDir(root, name) {
  return path.join(root, name);
}
function writeSkill(root, name, description, body) {
  const dir = skillDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body || ''}`);
  return dir;
}

// Fixture skills, present before any test runs.
writeSkill(CLAUDE_DIR, 'foo', 'Foo skill used by the overwrite and toggle tests', 'Foo body v1\n');
writeSkill(CLAUDE_DIR, 'dup', 'Claude copy of a duplicated skill', 'claude copy\n');
writeSkill(AGENTS_DIR, 'dup', 'Agents copy of a duplicated skill', 'agents copy\n');
const REAL_TARGET = path.join(ROOT_TMP, 'real-plugin-target');
fs.mkdirSync(REAL_TARGET, { recursive: true });
const LINK_ORIGINAL = '---\nname: linked\ndescription: real target behind a symlink\n---\nOriginal content\n';
fs.writeFileSync(path.join(REAL_TARGET, 'SKILL.md'), LINK_ORIGINAL);
fs.symlinkSync(REAL_TARGET, path.join(CLAUDE_DIR, 'linked'), 'dir');

let server;
let BASE;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/skills', router);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  BASE = `http://127.0.0.1:${server.address().port}/api/skills`;
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT_TMP, { recursive: true, force: true });
});

async function postJSON(target, body) {
  const r = await fetch(`${BASE}/${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('bad names are refused for create and import, and nothing is written outside the root', async () => {
  const beforeRoot = fs.readdirSync(ROOT_TMP).sort();
  const beforeClaude = fs.readdirSync(CLAUDE_DIR).sort();
  const badNames = ['../evil', '..', '.', 'a/b', 'Bad Name', '-lead', ''];
  for (const name of badNames) {
    const r1 = await postJSON('preview', { target: 'create', name, value: '---\nname: x\ndescription: x\n---\n' });
    assert.strictEqual(r1.status, 400, `create ${JSON.stringify(name)}`);
    assert.strictEqual(r1.body.error, 'name must match ^[a-z0-9][a-z0-9-]{0,63}$', `create ${JSON.stringify(name)}`);

    const r2 = await postJSON('preview', { target: 'import', name, url: 'https://example.com/skill.md' });
    assert.strictEqual(r2.status, 400, `import ${JSON.stringify(name)}`);
    assert.strictEqual(r2.body.error, 'name must match ^[a-z0-9][a-z0-9-]{0,63}$', `import ${JSON.stringify(name)}`);
  }
  // The assertion that actually matters: no directory escaped CLAUDE_DIR, and
  // nothing new landed inside it either.
  assert.deepStrictEqual(fs.readdirSync(ROOT_TMP).sort(), beforeRoot);
  assert.deepStrictEqual(fs.readdirSync(CLAUDE_DIR).sort(), beforeClaude);
});

test('import refuses non-https URLs without making any network call', async () => {
  const cases = [
    ['import-http-test', 'http://example.com/skill.md', 'http:'],
    ['import-file-test', 'file:///etc/passwd', 'file:'],
    ['import-ftp-test', 'ftp://example.com/skill.md', 'ftp:'],
    ['import-js-test', 'javascript:alert(1)', 'javascript:'],
  ];
  for (const [name, url, scheme] of cases) {
    const r = await postJSON('preview', { target: 'import', name, url });
    assert.strictEqual(r.status, 400, url);
    assert.strictEqual(r.body.error, `url must use https: (got ${scheme})`, url);
    assert.ok(!fs.existsSync(skillDir(CLAUDE_DIR, name)), `${name} should not have been created`);
  }
});

test('content without a frontmatter name/description is refused', async () => {
  const r = await postJSON('preview', { target: 'import', name: 'no-frontmatter-skill', value: 'just some text, no header' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'content must start with a frontmatter carrying name: and description:');
  assert.ok(!fs.existsSync(skillDir(CLAUDE_DIR, 'no-frontmatter-skill')));
});

test('create refuses to overwrite an existing skill', async () => {
  const r = await postJSON('preview', { target: 'create', name: 'foo', value: '---\nname: foo\ndescription: new\n---\nnew body\n' });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /use target "content" to replace its SKILL\.md/);
  assert.strictEqual(fs.readFileSync(path.join(CLAUDE_DIR, 'foo', 'SKILL.md'), 'utf8'), '---\nname: foo\ndescription: Foo skill used by the overwrite and toggle tests\n---\nFoo body v1\n');
});

test('a symlinked skill directory refuses content and toggle writes, and the real target is untouched', async () => {
  const rContent = await postJSON('preview', { target: 'content', name: 'linked', value: '---\nname: linked\ndescription: hijacked\n---\nnope\n' });
  assert.strictEqual(rContent.status, 409);
  assert.match(rContent.body.error, /is a symlink into/);

  const rToggle = await postJSON('preview', { target: 'toggle', name: 'linked', enabled: false });
  assert.strictEqual(rToggle.status, 409);
  assert.match(rToggle.body.error, /is a symlink into/);

  // The load-bearing check: the file the symlink points at never changed, and
  // the symlink itself was never renamed.
  assert.strictEqual(fs.readFileSync(path.join(REAL_TARGET, 'SKILL.md'), 'utf8'), LINK_ORIGINAL);
  assert.ok(fs.lstatSync(path.join(CLAUDE_DIR, 'linked')).isSymbolicLink());
});

test('a skill present in two roots is reported with duplicateIn', () => {
  const s = scanSkills().skills.find((x) => x.name === 'dup');
  assert.ok(s, 'dup skill not found');
  assert.strictEqual(s.root, 'claude'); // first root wins
  assert.deepStrictEqual(s.duplicateIn, ['agents']);
});

test('toggling a skill off renames the dir to .disabled and a rescan reports enabled:false with the bare name', async () => {
  const preview = await postJSON('preview', { target: 'toggle', name: 'foo', enabled: false });
  assert.strictEqual(preview.status, 200);
  const apply = await fetch(`${BASE}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: preview.body.token }),
  }).then((r) => r.json());
  assert.strictEqual(apply.ok, true);

  assert.ok(fs.existsSync(path.join(CLAUDE_DIR, 'foo.disabled')));
  assert.ok(!fs.existsSync(path.join(CLAUDE_DIR, 'foo')));
  const s = scanSkills().skills.find((x) => x.name === 'foo');
  assert.ok(s, 'foo missing after toggle');
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.dir, 'foo.disabled');
});

test('create then content: second write leaves a .bak with the old text and keeps uid:gid:mode', async () => {
  const created = await postJSON('preview', { target: 'create', name: 'roundtrip', value: '---\nname: roundtrip\ndescription: v1\n---\nBody v1\n' });
  assert.strictEqual(created.status, 200);
  const createApply = await fetch(`${BASE}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: created.body.token }),
  }).then((r) => r.json());
  assert.strictEqual(createApply.ok, true);
  assert.strictEqual(createApply.backup, null);

  const file = path.join(CLAUDE_DIR, 'roundtrip', 'SKILL.md');
  const before = fs.statSync(file);

  const updated = await postJSON('preview', { target: 'content', name: 'roundtrip', value: '---\nname: roundtrip\ndescription: v2\n---\nBody v2\n' });
  assert.strictEqual(updated.status, 200);
  const updateApply = await fetch(`${BASE}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: updated.body.token }),
  }).then((r) => r.json());
  assert.strictEqual(updateApply.ok, true);
  assert.match(updateApply.backup, /\.bak-\d{8}T\d{6}Z$/);

  assert.match(fs.readFileSync(updateApply.backup, 'utf8'), /Body v1/);
  assert.match(fs.readFileSync(file, 'utf8'), /Body v2/);

  const after = fs.statSync(file);
  assert.strictEqual(after.uid, before.uid);
  assert.strictEqual(after.gid, before.gid);
  assert.strictEqual(after.mode, before.mode);
});
