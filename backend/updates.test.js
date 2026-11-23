// node --test backend/updates.test.js
// Drives readSummary()/readPackages() on files in a tmpdir, never the real /var/lib.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-test-'));
const NOTIFIER = path.join(ROOT, 'updates-available');
const STAMP = path.join(ROOT, 'update-success-stamp');
const JSON_FILE = path.join(ROOT, 'updates.json');
process.env.UPDATE_NOTIFIER_FILE = NOTIFIER;
process.env.APT_STAMP_FILE = STAMP;
process.env.UPDATES_JSON = JSON_FILE;

const { readSummary, readPackages } = require('./updates');

// Verbatim from a GB10 whose system locale is fr_FR.
const FRENCH = `
La maintenance de sécurité étendue pour Applications est activée.

1 mise à jour peut être appliquée immédiatement.
Pour afficher ces mises à jour supplémentaires, exécuter : apt list --upgradable

`;
const ENGLISH = `
Expanded Security Maintenance for Applications is enabled.

85 updates can be applied immediately.
14 of these updates are standard security updates.
To see these additional updates run: apt list --upgradable
`;

function reset() {
  for (const f of [NOTIFIER, STAMP, JSON_FILE]) fs.rmSync(f, { force: true });
}

test('French notifier file: counts come from updates.json, not the translated text', () => {
  reset();
  fs.writeFileSync(NOTIFIER, FRENCH);
  fs.writeFileSync(STAMP, '');
  fs.writeFileSync(JSON_FILE, JSON.stringify({
    generatedAt: '2026-11-23T08:11:55Z',
    total: 1,
    security: 0,
    packages: [{ name: 'claude-desktop', candidate: '6.28899.6', current: '6.28899.2', origin: 'stable', arch: 'arm64' }],
  }));
  const s = readSummary();
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.security, 0);
  assert.strictEqual(s.esmEnabled, true);
  assert.strictEqual(s.source, JSON_FILE);
  assert.ok(s.checkedAt);
});

test('English notifier file without counts in updates.json: parsed from the text', () => {
  reset();
  fs.writeFileSync(NOTIFIER, ENGLISH);
  fs.writeFileSync(JSON_FILE, JSON.stringify({ generatedAt: 'x', packages: [] }));
  const s = readSummary();
  assert.strictEqual(s.total, 85);
  assert.strictEqual(s.security, 14);
  assert.strictEqual(s.esmEnabled, true);
  assert.strictEqual(s.source, NOTIFIER);
  assert.strictEqual(s.checkedAt, null);
});

test('singular English security line', () => {
  reset();
  fs.writeFileSync(NOTIFIER, '2 updates can be applied immediately.\n1 of these updates is a standard security update.\n');
  const s = readSummary();
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.security, 1);
  assert.strictEqual(s.esmEnabled, false);
});

test('no notifier file but counts in updates.json: summary still present', () => {
  reset();
  fs.writeFileSync(JSON_FILE, JSON.stringify({ generatedAt: 'x', total: 3, security: 2, packages: [] }));
  const s = readSummary();
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.security, 2);
  assert.strictEqual(s.esmEnabled, false);
});

test('neither source: no summary, package pipeline reported missing', () => {
  reset();
  assert.strictEqual(readSummary(), null);
  const p = readPackages(null);
  assert.strictEqual(p.pipelineInstalled, false);
  assert.deepStrictEqual(p.packages, []);
});
