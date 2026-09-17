// Run against a COPY: COMFY_DIR=/tmp/.../fake node --test backend/apps.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR = process.env.COMFY_DIR;
assert.ok(DIR && DIR !== '/home/sparks/comfyui-spark', 'COMFY_DIR must point at a throwaway copy');

const { APPS } = require('./apps');
const comfy = APPS.find((a) => a.id === 'comfyui');
const FILE = path.join(DIR, 'compose.yaml');
const ORIG = path.join(DIR, 'compose.yaml.orig');

test.before(() => fs.copyFileSync(FILE, ORIG));

test('(d) read() never leaks the real token', async () => {
  const r = await comfy.read();
  assert.ok(!JSON.stringify(r).includes('hf_'), 'read() output contains "hf_"');
  assert.strictEqual(r.env.HF_TOKEN, '***');
  assert.strictEqual(r.env.CUDA_CACHE_MAXSIZE, '4294967296');
  assert.ok(r.cmdline.flags.includes('--use-pytorch-cross-attention'));
});

test('scripts drop the .disabled suffix and carry notes only for 20/21', async () => {
  const { scripts } = await comfy.read();
  assert.ok(!scripts.some((s) => s.name.endsWith('.disabled')));
  const sage = scripts.find((s) => s.name === '20-SageAttention2.sh');
  assert.strictEqual(sage.enabled, false);
  assert.match(sage.note, /-std=c\+\+17/);
  assert.strictEqual(scripts.find((s) => s.name === '00-nvidiaDev.sh').note, null);
});

test('preview rejects out-of-bounds values', () => {
  for (const value of ['--a\n--b', '--a # nope', ' --a', '--a ', '"--a"', 'x'.repeat(2001), 42]) {
    assert.ok(comfy.preview({ target: 'cmdline', value }).error, `accepted ${JSON.stringify(value)}`);
  }
  assert.ok(comfy.preview({ target: 'script', name: '../../etc/passwd', enabled: true }).error);
  assert.ok(comfy.preview({ target: 'nope' }).error);
});

test('preview warns but does not block, and writes nothing', () => {
  const before = fs.readFileSync(FILE, 'utf8');
  const r = comfy.preview({ target: 'cmdline', value: '--highvram --use-sage-attention' });
  assert.ok(r.response.warnings.some((w) => w.includes('OOM')));
  assert.ok(r.response.warnings.some((w) => w.includes('SageAttention')));
  assert.strictEqual(r.response.restart.kind, 'recreate');
  assert.strictEqual(r.response.diff.filter((d) => d.kind === 'removed').length, 1);
  assert.strictEqual(fs.readFileSync(FILE, 'utf8'), before, 'preview modified the file');
});

test('(a)(b)(c) apply: one line changed, comments intact, ownership kept, backup holds the old value', () => {
  const statBefore = execSync(`stat -c %u:%g:%a ${FILE}`).toString().trim();
  const commentsBefore = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('#')).length;

  const r = comfy.preview({ target: 'cmdline', value: '--bf16-unet --bf16-vae' });
  const res = comfy.apply(r.plan);
  assert.strictEqual(res.ok, true);

  // (a) exactly one changed line
  const changed = execSync(`diff ${ORIG} ${FILE} | grep -c '^[<>]' || true`).toString().trim();
  assert.strictEqual(changed, '2', 'expected exactly one line replaced (1 removed + 1 added)');
  // comment count untouched
  const commentsAfter = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('#')).length;
  assert.strictEqual(commentsAfter, commentsBefore);
  // (b) mode/uid/gid untouched
  assert.strictEqual(execSync(`stat -c %u:%g:%a ${FILE}`).toString().trim(), statBefore);
  // (c) backup exists, holds the old value, same ownership
  assert.ok(/\.bak-\d{8}T\d{6}Z$/.test(res.backup), res.backup);
  assert.match(fs.readFileSync(res.backup, 'utf8'), /--use-pytorch-cross-attention/);
  assert.strictEqual(execSync(`stat -c %u:%g:%a ${res.backup}`).toString().trim(), statBefore);
  // new value is in place
  assert.match(fs.readFileSync(FILE, 'utf8'), /COMFY_CMDLINE_EXTRA: --bf16-unet --bf16-vae\n/);
});

test('apply refuses a stale preview (409 path)', () => {
  const r = comfy.preview({ target: 'cmdline', value: '--bf16-vae' });
  fs.appendFileSync(FILE, '# touched\n');
  assert.strictEqual(comfy.apply(r.plan).conflict, true);
});

test('script toggle renames and asks for a plain restart', () => {
  const r = comfy.preview({ target: 'script', name: '20-SageAttention2.sh', enabled: true });
  assert.deepStrictEqual(r.response.diff, []);
  assert.match(r.response.summary, /Renaming/);
  assert.strictEqual(r.response.restart.kind, 'restart');
  assert.strictEqual(r.response.restart.command, null);
  assert.ok(r.response.warnings.some((w) => w.includes('-std=c++17')));
  assert.strictEqual(comfy.apply(r.plan).backup, null);
  assert.ok(fs.existsSync(path.join(DIR, 'userscripts_dir', '20-SageAttention2.sh')));
});

test('facts feed the host/comfy rules and nothing else', async () => {
  // opencode is absent from these facts, so its two rules must stay silent —
  // that is what proves they are gated on their own facts and not always-on.
  const f = { gpuClockCapSet: false, vmSwappiness: 60, comfyui: await comfy.facts(), opencode: null };
  const rules = require('./rules');
  assert.strictEqual(rules.length, 6);
  assert.ok(!JSON.stringify(rules.map((r) => [r.title, r.why])).match(/CUDA_CACHE_MAXSIZE|NCCL_P2P_DISABLE/));
  // 20 was just enabled by the previous test, so the attention rule needs the pytorch flag restored
  f.comfyui.flags = ['--use-pytorch-cross-attention'];
  assert.deepStrictEqual(rules.filter((r) => r.detect(f)).map((r) => r.id),
    ['gpu-clock-cap-unset', 'vm-swappiness-high', 'comfy-attention-pytorch']);
});
