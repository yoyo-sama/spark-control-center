// Standalone: no fixture, no env var. Just the mask() unit tests (moved out of
// apps.test.js, which needs COMFY_DIR pointed at a throwaway copy to run at all).
const test = require('node:test');
const assert = require('node:assert');
const { mask } = require('./apps');

test('mask hides secret-named values, keeps the keys', () => {
  const m = mask({ HF_TOKEN: 'hf_abc', api_key: 'x', MY_SECRET: 'y', DB_PASSWORD: 'z', SECURITY_LEVEL: 'weak' });
  assert.deepStrictEqual(m, {
    HF_TOKEN: '***', api_key: '***', MY_SECRET: '***', DB_PASSWORD: '***', SECURITY_LEVEL: 'weak',
  });
});

test('mask hides inline key=value secrets inside arrays', () => {
  const m = mask({ args: ['-y', 'some-server', '--api-key=sk-live-abc'] });
  assert.deepStrictEqual(m.args, ['-y', 'some-server', '--api-key=***']);
});

test('mask hides flag/value secret pairs inside arrays', () => {
  const m = mask({ args: ['--token', 'abc123'] });
  assert.deepStrictEqual(m.args, ['--token', '***']);
});

test('mask recurses into objects nested inside arrays', () => {
  const m = mask({ list: [{ API_KEY: 'x', note: 'ok' }] });
  assert.deepStrictEqual(m.list, [{ API_KEY: '***', note: 'ok' }]);
});

test('mask leaves non-secret arrays untouched', () => {
  const m = mask({ args: ['-y', 'some-server'] });
  assert.deepStrictEqual(m.args, ['-y', 'some-server']);
});
