// Pure logic only: synthetic container lists, no Docker, no fixtures, no env vars.
const test = require('node:test');
const assert = require('node:assert');
const { findPortConflicts } = require('./insights');
const rules = require('./rules');

const rule = rules.find((r) => r.id === 'container-port-conflict');

function container(name, running, hostPorts, restartPolicy = 'no') {
  return { name, running, restartPolicy, hostPorts };
}

test('stopped container wanting a port held by a running one is reported', () => {
  const conflicts = findPortConflicts([
    container('open-webui', true, ['3000']),
    container('flux-studio', false, ['3000']),
  ]);
  assert.deepStrictEqual(conflicts, [{ name: 'flux-studio', port: '3000', heldBy: 'open-webui', restartPolicy: 'no' }]);
});

test('stopped container whose port nobody holds is not reported', () => {
  const conflicts = findPortConflicts([
    container('open-webui', true, ['3000']),
    container('idle-app', false, ['4000']),
  ]);
  assert.deepStrictEqual(conflicts, []);
});

test('two stopped containers wanting the same port is latent, not a conflict', () => {
  const conflicts = findPortConflicts([
    container('app-a', false, ['3000']),
    container('app-b', false, ['3000']),
  ]);
  assert.deepStrictEqual(conflicts, []);
});

test('a running container is never reported as a victim', () => {
  const conflicts = findPortConflicts([
    container('open-webui', true, ['3000']),
    // Docker would refuse this in reality (port already bound); guard it anyway.
    container('other-running', true, ['3000']),
  ]);
  assert.deepStrictEqual(conflicts, []);
});

test('a container with several published ports reports only the conflicting one', () => {
  const conflicts = findPortConflicts([
    container('open-webui', true, ['3000']),
    container('multi-port', false, ['3000', '8080']),
  ]);
  assert.deepStrictEqual(conflicts, [{ name: 'multi-port', port: '3000', heldBy: 'open-webui', restartPolicy: 'no' }]);
});

test('rule: detect is false on empty facts', () => {
  assert.strictEqual(rule.detect({ portConflicts: [] }), false);
});

test('rule: detect is true with a conflict', () => {
  const facts = { portConflicts: [{ name: 'flux-studio', port: '3000', heldBy: 'open-webui', restartPolicy: 'no' }] };
  assert.strictEqual(rule.detect(facts), true);
});

test('rule: severity is medium when a conflicting container has unless-stopped, low when all are no', () => {
  const medium = { portConflicts: [{ name: 'flux-studio', port: '3000', heldBy: 'open-webui', restartPolicy: 'unless-stopped' }] };
  const low = { portConflicts: [{ name: 'flux-studio', port: '3000', heldBy: 'open-webui', restartPolicy: 'no' }] };
  assert.strictEqual(rule.severity(medium), 'medium');
  assert.strictEqual(rule.severity(low), 'low');
});

test('rule: one port blocking several containers is stated once, victims split by intent', () => {
  const c = (name, restartPolicy) => ({ name, port: '3000', heldBy: 'open-webui', restartPolicy });
  const why = rule.why({
    portConflicts: [c('a', 'no'), c('b', 'unless-stopped'), c('c', 'always'), c('d', 'no')],
  });
  // the cause is named once, not once per victim
  assert.strictEqual(why.split('held by open-webui').length - 1, 1);
  assert.match(why, /b and c are set to restart automatically/);
  assert.match(why, /a and d are stopped with restart policy "no"/);
});

test('rule: two distinct blocked ports each get their own sentence', () => {
  const why = rule.why({
    portConflicts: [
      { name: 'a', port: '3000', heldBy: 'open-webui', restartPolicy: 'always' },
      { name: 'b', port: '8188', heldBy: 'comfyui-nvidia', restartPolicy: 'no' },
    ],
  });
  assert.match(why, /Host port 3000 is held by open-webui\./);
  assert.match(why, /Host port 8188 is held by comfyui-nvidia\./);
  assert.match(why, /a is set to restart automatically/);
  assert.match(why, /b is stopped with restart policy/);
});
