// node --test backend/cpufreq.test.js
// Builds a fake GB10 /sys/devices/system/cpu tree (10 A725 at 2808 MHz, 10 X925 at
// 3900 MHz on cpu5-9 and cpu15-19) and checks big-core detection and the cap status.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readBigCores, summarize, capStatus } = require('./cpufreq');

const BIG = [5, 6, 7, 8, 9, 15, 16, 17, 18, 19];

function fakeSys({ max = 3900, cur = 3900, overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpufreq-test-'));
  const cpuDir = path.join(root, 'devices/system/cpu');
  for (let c = 0; c < 20; c++) {
    const dir = path.join(cpuDir, `cpu${c}`, 'cpufreq');
    fs.mkdirSync(dir, { recursive: true });
    const hw = BIG.includes(c) ? 3900 : 2808;
    const o = overrides[c] || {};
    fs.writeFileSync(path.join(dir, 'cpuinfo_max_freq'), `${hw * 1000}\n`);
    fs.writeFileSync(path.join(dir, 'scaling_max_freq'), `${(o.max ?? Math.min(max, hw)) * 1000}\n`);
    fs.writeFileSync(path.join(dir, 'scaling_cur_freq'), `${(o.cur ?? Math.min(cur, hw)) * 1000}\n`);
  }
  fs.mkdirSync(path.join(cpuDir, 'cpufreq')); // not a cpu, must be ignored
  return root;
}

test('detects only the X925 cores', () => {
  const cores = readBigCores(fakeSys());
  assert.deepStrictEqual(cores.map((c) => c.cpu), BIG);
  assert.deepStrictEqual(summarize(cores), {
    cpuBigCores: '5-9,15-19',
    cpuBigCoreMaxMhz: 3900,
    cpuBigCoreCurrentMhz: 3900,
    cpuBigCoreHwMaxMhz: 3900,
  });
});

test('cap held on every big core -> ok', () => {
  assert.deepStrictEqual(capStatus(3000, readBigCores(fakeSys({ max: 3000, cur: 2990 }))), { state: 'ok', message: '' });
});

test('one core rewritten back to stock (nv-cpu-governor) -> diverged', () => {
  const s = capStatus(3000, readBigCores(fakeSys({ max: 3000, cur: 3000, overrides: { 16: { max: 3900 } } })));
  assert.strictEqual(s.state, 'diverged');
  assert.match(s.message, /cpu16 .*nv-cpu-governor/);
});

test('core running above the cap -> diverged', () => {
  const s = capStatus(3000, readBigCores(fakeSys({ max: 3000, cur: 3000, overrides: { 7: { cur: 3900 } } })));
  assert.strictEqual(s.state, 'diverged');
});

test('cap removed: ok at stock max, diverged while still capped', () => {
  assert.strictEqual(capStatus(null, readBigCores(fakeSys())).state, 'ok');
  assert.strictEqual(capStatus(null, readBigCores(fakeSys({ max: 3000 }))).state, 'diverged');
});

test('cpufreq unreadable -> unverified', () => {
  assert.deepStrictEqual(summarize(readBigCores('/nonexistent')).cpuBigCores, null);
  assert.strictEqual(capStatus(3000, readBigCores('/nonexistent')).state, 'unverified');
});
