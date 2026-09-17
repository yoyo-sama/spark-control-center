// Run: node --test backend/ports.test.js
// Pure logic only: inline compose strings, no fixture files, no env vars, no Docker.
// The shapes below are the ones that actually occur on this machine — quoted and
// unquoted entries, list items deeper than their key AND at the same indent as it,
// several services each with their own `ports:`, and the `${VAR}` form that must be
// refused rather than hard-coded.
const test = require('node:test');
const assert = require('node:assert');
const { findPortLine } = require('./ports');

function build(r, newHostPort) {
  assert.ok(!r.error, `expected a match, got: ${r.error}`);
  return r.prefix + newHostPort + r.suffix;
}

test('quoted entry, list item deeper than its key', () => {
  const compose = [
    'services:',
    '  flux-studio:',
    '    build: .',
    '    ports:',
    '      - "3000:3000"',
    '    restart: unless-stopped',
    '',
  ].join('\n');
  const r = findPortLine(compose, 'flux-studio', '3000', '3000');
  assert.strictEqual(r.index, 4);
  assert.strictEqual(build(r, 3010), '      - "3010:3000"');
});

test('unquoted entry, list item at the SAME indent as its key', () => {
  const compose = [
    'services:',
    '  frontend:',
    '    container_name: traffic-sentinel-frontend',
    '    ports:',
    '    - 3000:80',
    '    depends_on:',
    '    - backend',
    '',
  ].join('\n');
  const r = findPortLine(compose, 'frontend', '3000', '80');
  assert.strictEqual(r.index, 4);
  assert.strictEqual(build(r, 3100), '    - 3100:80');
});

test('trailing comment and host IP are preserved, only the host port changes', () => {
  const compose = ['services:', '  app:', '    ports:', '      - 127.0.0.1:8081:3001   # local only', ''].join('\n');
  const r = findPortLine(compose, 'app', '8081', '3001');
  assert.strictEqual(build(r, 9090), '      - 127.0.0.1:9090:3001   # local only');
});

test('quoted entry with a trailing comment keeps both quotes and comment', () => {
  const compose = ['services:', '  app:', '    ports:', "      - '3000:3000'  # web", ''].join('\n');
  const r = findPortLine(compose, 'app', '3000', '3000');
  assert.strictEqual(build(r, 3001), "      - '3001:3000'  # web");
});

test('the protocol suffix survives', () => {
  const compose = ['services:', '  app:', '    ports:', '      - "5353:53/udp"', ''].join('\n');
  const r = findPortLine(compose, 'app', '5353', '53');
  assert.strictEqual(build(r, 5454), '      - "5454:53/udp"');
});

// The real trap: kasslachaine's compose has a second `ports:` further down, for
// postgres on 5432. Taking the first `ports:` of the file would edit the wrong one.
const TWO_SERVICES = [
  'services:',
  '  app:',
  '    build: .',
  '    ports:',
  '      - "3000:3000"',
  '    environment:',
  '      NODE_ENV: development',
  '',
  '  postgres:',
  '    image: postgres:16-alpine',
  '    ports:',
  '      - "5432:5432"',
  '',
].join('\n');

test('the second service is edited on its own ports: block', () => {
  const r = findPortLine(TWO_SERVICES, 'postgres', '5432', '5432');
  assert.strictEqual(r.index, 11);
  assert.strictEqual(build(r, 5433), '      - "5433:5432"');
});

test('the first service is not confused by the second ports: block', () => {
  const r = findPortLine(TWO_SERVICES, 'app', '3000', '3000');
  assert.strictEqual(r.index, 4);
  assert.strictEqual(build(r, 3005), '      - "3005:3000"');
});

test('a ports: entry of another service never matches this one', () => {
  const r = findPortLine(TWO_SERVICES, 'app', '5432', '5432');
  assert.match(r.error, /no entry publishing 5432:5432/);
});

test('an interpolated host port is refused, naming the variable and the .env path', () => {
  const compose = ['services:', '  app:', '    ports:', '      - "${APP_PORT:-3000}:3000"', ''].join('\n');
  const r = findPortLine(compose, 'app', '3000', '3000', '/home/sparks/kass-la-shen');
  assert.strictEqual(r.index, undefined);
  assert.match(r.error, /APP_PORT/);
  assert.match(r.error, /\/home\/sparks\/kass-la-shen\/\.env/);
});

test('an interpolated host port at the same indent as its key is refused too', () => {
  const compose = ['services:', '  frontend:', '    ports:', '    - ${FRONTEND_PORT:-3000}:80', ''].join('\n');
  const r = findPortLine(compose, 'frontend', '3000', '80', '/home/dell-ai-innovation/traffic-sentinel_1.0');
  assert.match(r.error, /FRONTEND_PORT/);
  assert.match(r.error, /traffic-sentinel_1\.0\/\.env/);
});

test('the long target:/published: syntax is refused', () => {
  const compose = [
    'services:',
    '  app:',
    '    ports:',
    '      - target: 3000',
    '        published: 3000',
    '        protocol: tcp',
    '',
  ].join('\n');
  const r = findPortLine(compose, 'app', '3000', '3000');
  assert.match(r.error, /long syntax/);
  assert.match(r.error, /published:/);
});

test('the inline long syntax is refused too', () => {
  const compose = ['services:', '  app:', '    ports:', '      - {target: 3000, published: 3000}', ''].join('\n');
  const r = findPortLine(compose, 'app', '3000', '3000');
  assert.match(r.error, /long syntax/);
});

test('an unknown service is refused by name', () => {
  const compose = ['services:', '  app:', '    ports:', '      - "3000:3000"', ''].join('\n');
  const r = findPortLine(compose, 'worker', '3000', '3000');
  assert.match(r.error, /service "worker" not found/);
});

test('a service with no ports: block is refused', () => {
  const compose = ['services:', '  app:', '    image: nginx', '    restart: always', ''].join('\n');
  const r = findPortLine(compose, 'app', '3000', '80');
  assert.match(r.error, /no `ports:` block/);
});

test('no matching mapping is refused, and the entries found are listed', () => {
  const compose = ['services:', '  app:', '    ports:', '      - "8080:80"', '      - "8443:443"', ''].join('\n');
  const r = findPortLine(compose, 'app', '3000', '3000');
  assert.match(r.error, /no entry publishing 3000:3000/);
  assert.match(r.error, /8080:80, 8443:443/);
});

test('a file without a services: block is refused', () => {
  const r = findPortLine('version: "3"\n', 'app', '3000', '3000');
  assert.match(r.error, /no `services:` block/);
});

test('a container-port-only entry does not match and is not mangled', () => {
  const compose = ['services:', '  app:', '    ports:', '      - "3000"', ''].join('\n');
  const r = findPortLine(compose, 'app', '3000', '3000');
  assert.match(r.error, /no entry publishing 3000:3000/);
});
