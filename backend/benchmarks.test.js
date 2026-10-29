// Run: node --test backend/benchmarks.test.js
// BENCH_DIR points at a throwaway tmp dir before benchmarks.js is loaded. The runner
// gets a fake Docker: each "container" replays a canned AIPerf output and drops a real
// AIPerf export (fixtures/aiperf) into the folder bind-mounted as its artifact dir —
// exactly what the real tool does — so the whole run lifecycle is exercised without a
// daemon.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const express = require('express');
const Modem = require('docker-modem');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
process.env.BENCH_DIR = ROOT;

const bench = require('./benchmarks');
const { TOOLS } = require('./benchtools');

const FIX = path.join(__dirname, 'fixtures', 'aiperf');

// Docker's multiplexed attach framing: 8-byte header (stream type, size) + payload.
function frame(text, type = 1) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// behaviour(stepIndex) → 'ok' | 'block' | 'fail-connect'
function fakeDocker({ behaviour = () => 'ok', imagePresent = true } = {}) {
  const created = [];
  const built = [];
  let image = imagePresent;
  const docker = {
    modem: new Modem(),
    created,
    built,
    getImage: () => ({ inspect: async () => { if (!image) throw new Error('no such image'); return {}; } }),
    async buildImage(ctx, opts) {
      built.push({ dockerfile: fs.readFileSync(path.join(ctx.context, 'Dockerfile'), 'utf8'), opts });
      const s = new PassThrough();
      setImmediate(() => {
        s.write(`${JSON.stringify({ stream: 'Step 1/2 : FROM python:3.12-slim\n' })}\n`);
        s.write(`${JSON.stringify({ stream: 'Successfully built\n' })}\n`);
        image = true;
        s.end();
      });
      return s;
    },
    async listContainers() {
      return [];
    },
    getContainer: () => ({ remove: async () => {} }),
    async createContainer(spec) {
      const index = created.length;
      created.push(spec);
      const stepDir = spec.HostConfig.Binds[0].split(':')[0];
      const mode = behaviour(index);
      const stream = new PassThrough();
      let finish;
      const exited = new Promise((resolve) => { finish = resolve; });
      const c = {
        removed: false,
        stopped: false,
        async attach() { return stream; },
        async start() {
          stream.write(frame('Benchmarking…\n'));
          if (mode === 'ok') {
            fs.copyFileSync(path.join(FIX, 'success', 'profile_export_aiperf.json'), path.join(stepDir, 'profile_export_aiperf.json'));
            stream.write(frame('Output Token Throughput (tokens/sec) │ 455.80\r\n'));
            setTimeout(() => { stream.end(); finish(0); }, 60);
          } else if (mode === 'fail-connect') {
            stream.write(frame('ERROR Error in aiohttp request: ClientConnectorError(ConnectionRefusedError(111))\n', 2));
            setTimeout(() => { stream.end(); finish(1); }, 20);
          }
          // 'block': runs until stop()
        },
        async kill({ signal }) {
          assert.strictEqual(signal, 'SIGINT', 'first a graceful stop');
          return c.stop();
        },
        async stop() {
          if (c.stopped) return;
          c.stopped = true;
          // SIGINT: AIPerf exports what it has, flagged as cancelled
          fs.copyFileSync(path.join(FIX, 'cancelled', 'profile_export_aiperf.json'), path.join(stepDir, 'profile_export_aiperf.json'));
          stream.end();
          finish(0);
        },
        async wait() { return { StatusCode: await exited }; },
        async remove() { c.removed = true; },
      };
      spec.container = c;
      return c;
    },
  };
  return docker;
}

let gpuClock = 2100;
function fakeRunner(docker, extra = {}) {
  return bench.createRunner({
    docker,
    sampleIntervalMs: 10,
    sampleGpu: async () => ({ clockMhz: gpuClock, powerW: 40, tempC: 60, utilPct: 95 }),
    gb10Snapshot: async () => ({ capMhz: 2100, capStatus: { state: 'ok' }, pipelineInstalled: true }),
    ...extra,
  });
}

async function serve(runner) {
  const app = express();
  app.use(express.json());
  app.use('/api/benchmarks', bench.createRouter(runner));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}/api/benchmarks` };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const finished = (id) => waitFor(() => {
  const r = bench.loadRun(id);
  return r && !['queued', 'preparing', 'running'].includes(r.status) ? r : null;
});

const TARGET = { url: 'http://localhost:8000/v1', model: 'Qwen/Qwen3-8B', label: 'vLLM · vllm', kind: 'vllm', apiKey: 'sk-very-secret' };

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('a concurrency sweep runs one container per step and keeps everything on disk', async () => {
  const docker = fakeDocker();
  const runner = fakeRunner(docker);
  const { server, base } = await serve(runner);
  try {
    const r = await post(`${base}/runs`, { toolId: 'aiperf', target: TARGET, params: { isl: 256, osl: 64 }, sweep: { key: 'concurrency', values: [4, 1, 4, 2] }, cooldownS: 0 });
    assert.strictEqual(r.status, 202);
    const { id } = await r.json();
    const run = await finished(id);

    assert.strictEqual(run.status, 'success', run.error);
    assert.deepStrictEqual(run.sweep, { key: 'concurrency', values: [1, 2, 4] }, 'deduplicated and sorted');
    assert.deepStrictEqual(run.steps.map((s) => [s.value, s.status]), [[1, 'success'], [2, 'success'], [4, 'success']]);
    assert.strictEqual(run.target.url, 'http://localhost:8000', 'normalized base URL');
    assert.strictEqual(run.gb10.capMhz, 2100);

    // containers: fixed image, host network, only the step folder + HF cache mounted
    assert.strictEqual(docker.created.length, 3);
    for (const [i, spec] of docker.created.entries()) {
      assert.strictEqual(spec.Image, TOOLS.aiperf.image);
      assert.strictEqual(spec.HostConfig.NetworkMode, 'host');
      assert.strictEqual(spec.StopSignal, 'SIGINT');
      assert.deepStrictEqual(spec.HostConfig.Binds, [
        `${path.join(ROOT, 'runs', id, 'steps', String(i))}:/artifacts`,
        `${path.join(ROOT, 'hf-cache')}:/hf`,
      ]);
      assert.strictEqual(spec.Cmd[spec.Cmd.indexOf('--concurrency') + 1], String(run.steps[i].value));
      assert.strictEqual(spec.Labels['spark-control-center.benchmark'], id);
      assert.ok(spec.container.removed, 'container removed after the step');
    }

    // results + telemetry
    const step = run.steps[0];
    assert.ok(step.result.metrics.output_token_throughput.avg > 0);
    assert.ok(step.telemetry.samples > 0);
    assert.strictEqual(step.telemetry.cap.verdict, 'held');
    assert.ok(step.telemetry.tokensPerJoule > 0);

    // the API key went to the tool, nowhere else
    const dir = path.join(ROOT, 'runs', id);
    const onDisk = fs.readFileSync(path.join(dir, 'run.json'), 'utf8') + fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8');
    assert.ok(!onDisk.includes('sk-very-secret'));
    assert.strictEqual(run.target.hasApiKey, true);
    assert.ok(docker.created[0].Cmd.includes('sk-very-secret'));
    assert.match(step.command, /--api-key \*\*\*/);

    // log lines, \r-terminated tool output included
    const logs = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8');
    assert.match(logs, /Output Token Throughput/);
    assert.ok(fs.statSync(path.join(dir, 'gpu.jsonl')).size > 0);

    // history, detail, raw result download, finished SSE stream
    const list = await (await fetch(`${base}/runs`)).json();
    const summary = list.runs.find((x) => x.id === id);
    assert.strictEqual(summary.stepCount, 3);
    assert.strictEqual(summary.best.value, 1, 'the fixture is identical for every step: the first max wins');
    assert.strictEqual(list.activeRunId, null);
    assert.strictEqual((await fetch(`${base}/runs/${id}`)).status, 200);
    const raw = await fetch(`${base}/runs/${id}/steps/0/result.json`);
    assert.strictEqual(raw.status, 200);
    assert.strictEqual((await raw.json()).aiperf_version, '0.13.0');
    assert.strictEqual((await fetch(`${base}/runs/${id}/steps/9/result.json`)).status, 404);
    const sse = await (await fetch(`${base}/runs/${id}/events`)).text();
    assert.match(sse, /"type":"snapshot"/);
    assert.match(sse, /"type":"end"/);
    const tele = await (await fetch(`${base}/runs/${id}/telemetry`)).json();
    assert.ok(tele.samples.length > 0);
  } finally {
    server.close();
  }
});

test('one run at a time; cancel stops the container and keeps partial results', async () => {
  const docker = fakeDocker({ behaviour: () => 'block' });
  const runner = fakeRunner(docker);
  const { server, base } = await serve(runner);
  try {
    const r = await post(`${base}/runs`, { toolId: 'aiperf', target: TARGET, params: {}, sweep: { key: 'concurrency', values: [1, 2] }, cooldownS: 0 });
    const { id } = await r.json();
    await waitFor(() => docker.created.length === 1);

    // the cheap status endpoint every page polls
    const status = await (await fetch(`${base}/status`)).json();
    assert.strictEqual(status.active.id, id);
    assert.strictEqual(status.active.stepCount, 2);
    assert.strictEqual(status.active.model, 'Qwen/Qwen3-8B');

    const second = await post(`${base}/runs`, { toolId: 'aiperf', target: TARGET, params: {} });
    assert.strictEqual(second.status, 409);
    assert.strictEqual((await second.json()).activeRunId, id);
    assert.strictEqual((await fetch(`${base}/runs/${id}`, { method: 'DELETE' })).status, 409);

    // live SSE: the snapshot arrives right away
    const ctrl = new AbortController();
    const live = await fetch(`${base}/runs/${id}/events`, { signal: ctrl.signal });
    assert.strictEqual(live.headers.get('cache-control'), 'no-cache, no-transform');
    const reader = live.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"snapshot"/);
    ctrl.abort();

    // cancel needs a JSON body (a cross-site form post can't send one)
    assert.strictEqual((await fetch(`${base}/runs/${id}/cancel`, { method: 'POST' })).status, 415);
    assert.strictEqual((await post(`${base}/runs/${id}/cancel`, {})).status, 200);
    const run = await finished(id);
    assert.strictEqual(run.status, 'cancelled');
    assert.strictEqual(run.steps[0].status, 'cancelled');
    assert.strictEqual(run.steps[0].result.wasCancelled, true);
    assert.strictEqual(run.steps[1].status, 'skipped');
    assert.strictEqual(docker.created.length, 1, 'no new step after a cancel');
    assert.ok(docker.created[0].container.stopped);
    assert.strictEqual((await post(`${base}/runs/${id}/cancel`, {})).status, 409);
    assert.deepStrictEqual(await (await fetch(`${base}/status`)).json(), { active: null });
  } finally {
    server.close();
  }
});

test('a failed step stops the sweep with an actionable message', async () => {
  const docker = fakeDocker({ behaviour: () => 'fail-connect' });
  const runner = fakeRunner(docker);
  const { server, base } = await serve(runner);
  try {
    const r = await post(`${base}/runs`, { toolId: 'aiperf', target: TARGET, params: {}, sweep: { key: 'concurrency', values: [1, 2, 4] }, cooldownS: 0 });
    const run = await finished((await r.json()).id);
    assert.strictEqual(run.status, 'failed');
    assert.match(run.error, /Nothing answered at http:\/\/localhost:8000/);
    assert.deepStrictEqual(run.steps.map((s) => s.status), ['failed', 'skipped', 'skipped']);
    assert.strictEqual(run.steps[0].exitCode, 1);
  } finally {
    server.close();
  }
});

test('a step that runs too long is stopped and counted as failed', async () => {
  const docker = fakeDocker({ behaviour: () => 'block' });
  const runner = fakeRunner(docker, { stepTimeoutMs: 80 });
  const { server, base } = await serve(runner);
  try {
    const r = await post(`${base}/runs`, { toolId: 'aiperf', target: TARGET, params: {} });
    const run = await finished((await r.json()).id);
    assert.strictEqual(run.status, 'failed');
    assert.match(run.steps[0].error, /Timed out .*partial results kept/);
  } finally {
    server.close();
  }
});

test('the tool image is built on first use, its output in the run log', async () => {
  const docker = fakeDocker({ imagePresent: false });
  const runner = fakeRunner(docker);
  const { server, base } = await serve(runner);
  try {
    assert.strictEqual((await (await fetch(`${base}/tools`)).json()).tools[0].imageReady, false);
    const r = await post(`${base}/runs`, { toolId: 'aiperf', target: TARGET, params: {} });
    const run = await finished((await r.json()).id);
    assert.strictEqual(run.status, 'success', run.error);
    assert.strictEqual(docker.built.length, 1);
    assert.match(docker.built[0].dockerfile, /pip install --no-cache-dir aiperf==/);
    assert.strictEqual(docker.built[0].opts.t, TOOLS.aiperf.image);
    const logs = fs.readFileSync(path.join(ROOT, 'runs', run.id, 'log.jsonl'), 'utf8');
    assert.match(logs, /Step 1\/2 : FROM python/);
    assert.strictEqual((await (await fetch(`${base}/tools`)).json()).tools[0].imageReady, true);
  } finally {
    server.close();
  }
});

test('request validation', async () => {
  const runner = fakeRunner(fakeDocker());
  const { server, base } = await serve(runner);
  try {
    const bad = async (body, re) => {
      const r = await post(`${base}/runs`, body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.match((await r.json()).error, re);
    };
    await bad({ toolId: 'nope', target: TARGET }, /Unknown tool/);
    await bad({ toolId: 'constructor', target: TARGET }, /Unknown tool/);
    await bad({ toolId: 'aiperf', target: { ...TARGET, url: 'file:///etc' } }, /URL/);
    await bad({ toolId: 'aiperf', target: { ...TARGET, model: '--help' } }, /model/);
    await bad({ toolId: 'aiperf', target: TARGET, params: { image: 'x' } }, /Unknown parameter/);
    await bad({ toolId: 'aiperf', target: TARGET, sweep: { key: 'isl', values: [1, 2] } }, /Cannot sweep/);
    await bad({ toolId: 'aiperf', target: TARGET, sweep: { key: 'concurrency', values: [1] } }, /2 to 12/);
    await bad({ toolId: 'aiperf', target: TARGET, sweep: { key: 'concurrency', values: [1, 0] } }, /Invalid sweep value/);
    await bad({ toolId: 'aiperf', target: TARGET, sweep: { key: 'concurrency', values: [2, 2] } }, /distinct/);
    await bad({ toolId: 'aiperf', target: TARGET, cooldownS: -1 }, /cooldown/);
    const noJson = await fetch(`${base}/runs`, { method: 'POST', body: 'toolId=aiperf' });
    assert.strictEqual(noJson.status, 415);
    assert.strictEqual((await fetch(`${base}/runs/..%2F..%2Fetc`)).status, 404);
    assert.strictEqual((await fetch(`${base}/runs/20260101-000000-zzzz`, { method: 'DELETE' })).status, 404);
  } finally {
    server.close();
  }
});

test('store: ids are checked before any disk access; delete', () => {
  assert.match(bench.newRunId(new Date('2026-10-29T14:30:12Z')), /^20261029-143012-[0-9a-f]{4}$/);
  assert.strictEqual(bench.runDir('../../etc'), null);
  assert.strictEqual(bench.runDir('20261029-143012-abcd/../x'), null);
  const run = { id: '20200101-000000-abcd', createdAt: '2020-01-01T00:00:00Z', status: 'success', steps: [] };
  bench.saveRun(run);
  assert.deepStrictEqual(bench.loadRun(run.id), run);
  assert.ok(bench.listRuns().some((r) => r.id === run.id));
  assert.strictEqual(bench.deleteRun(run.id), true);
  assert.strictEqual(bench.loadRun(run.id), null);
  assert.strictEqual(bench.deleteRun(run.id), false);
});

test('reconcile marks runs cut short by a restart as interrupted', async () => {
  const run = { id: '20200101-000001-abcd', createdAt: '2020-01-01T00:00:01Z', status: 'running', steps: [{ status: 'success' }, { status: 'running' }, { status: 'pending' }] };
  bench.saveRun(run);
  await fakeRunner(fakeDocker()).reconcile();
  const after = bench.loadRun(run.id);
  assert.strictEqual(after.status, 'interrupted');
  assert.deepStrictEqual(after.steps.map((s) => s.status), ['success', 'skipped', 'skipped']);
  bench.deleteRun(run.id);
});

test('summarizeTelemetry: energy, tokens per joule, peaks', () => {
  const samples = [0, 1000, 2000, 3000].map((t, i) => ({ t, powerW: [40, 60, 60, 40][i], tempC: 60 + i, clockMhz: 2100, utilPct: 99 }));
  const s = bench.summarizeTelemetry(samples, 2100, { output_token_throughput: { avg: 500 } });
  assert.strictEqual(s.energyJ, 160, 'trapezoid over 1 s intervals: 50 + 60 + 50');
  assert.strictEqual(s.powerAvgW, 50);
  assert.strictEqual(s.powerMaxW, 60);
  assert.strictEqual(s.tempMaxC, 63);
  assert.strictEqual(s.tokensPerJoule, 10);
  assert.strictEqual(s.durationS, 3);
  assert.strictEqual(bench.summarizeTelemetry([], 2100, null).tokensPerJoule, null);
});

test('cap verdict under load: held, exceeded, never reached, no cap', () => {
  const at = (clocks, util = 99) => clocks.map((c, i) => ({ t: i * 1000, clockMhz: c, powerW: 50, utilPct: util }));
  assert.strictEqual(bench.summarizeTelemetry(at([2100, 2095, 2100]), 2100).cap.verdict, 'held');
  assert.strictEqual(bench.summarizeTelemetry(at([2100, 2418, 2418]), 2100).cap.verdict, 'exceeded');
  assert.strictEqual(bench.summarizeTelemetry(at([1500, 1500, 1500]), 2100).cap.verdict, 'not-observable');
  assert.strictEqual(bench.summarizeTelemetry(at([2418, 2418, 2418], 5), 2100).cap.verdict, 'not-observable', 'idle samples say nothing');
  assert.strictEqual(bench.summarizeTelemetry(at([2418, 2418, 2418]), null).cap.verdict, 'no-cap');
  assert.strictEqual(bench.summarizeTelemetry(at([2418, 2418, 2418], null), 2100).cap.verdict, 'exceeded', 'utilization N/A: every sample counts');
});

test('workload fingerprint ignores what a comparison is about', () => {
  const run = (over) => ({ tool: { id: 'aiperf', version: '0.13.0' }, params: { ...TOOLS.aiperf.validate({}).params, ...over }, sweep: null });
  const base = bench.workloadFingerprint(run({}));
  assert.strictEqual(bench.workloadFingerprint(run({ concurrency: 16 })), base);
  assert.strictEqual(bench.workloadFingerprint({ ...run({}), target: { model: 'other' }, gb10: { capMhz: 2200 } }), base);
  assert.notStrictEqual(bench.workloadFingerprint(run({ isl: 2048 })), base);
  assert.notStrictEqual(bench.workloadFingerprint(run({ randomSeed: 1 })), base);
});

test('explainFailure turns tool errors into a next step', () => {
  const t = { url: 'http://localhost:8000', model: 'm' };
  assert.match(bench.explainFailure(['ClientConnectorError(...)'], t), /Nothing answered/);
  assert.match(bench.explainFailure(['TokenizerError: Failed to load tokenizer'], t), /tokenizer/);
  assert.match(bench.explainFailure(['HTTP 404 model m does not exist'], t), /404/);
  assert.match(bench.explainFailure(['status 401 Unauthorized'], t), /API key/);
  assert.strictEqual(bench.explainFailure(['something else'], t), null);
});

test('lineSplitter handles \\r progress lines, partial chunks and colour codes', () => {
  const lines = [];
  const s = bench.lineSplitter((l) => lines.push(l));
  s.push('a\r\nb');
  s.push('c\rd\n\n');
  s.push('\x1b[33m│\x1b[0m  \x1b[1;33mBENCHMARK CANCELLED\x1b[0m   \n');
  s.push('\x1b[33m│\x1b[0m\n');
  s.push('tail');
  s.flush();
  assert.deepStrictEqual(lines, ['a', 'bc', 'd', '│  BENCHMARK CANCELLED', '│', 'tail']);
});
