// Run: node --test backend/benchtools.test.js
// Fixtures under fixtures/aiperf are real AIPerf 0.13.0 exports (schema 1.4) recorded
// against a mock OpenAI server, with local paths scrubbed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TOOLS, publicTool, validateTarget, normalizeTargetUrl, resolveTokenizer, displayArgv } = require('./benchtools');

const aiperf = TOOLS.aiperf;
const FIX = path.join(__dirname, 'fixtures', 'aiperf');

test('validate fills defaults and rejects unknown keys', () => {
  const { params } = aiperf.validate({ concurrency: 8 });
  assert.strictEqual(params.concurrency, 8);
  assert.strictEqual(params.requestCount, 50);
  assert.strictEqual(params.benchmarkDurationS, null);
  assert.strictEqual(params.streaming, true);
  assert.match(aiperf.validate({ image: 'evil' }).error, /Unknown parameter: image/);
});

test('validate enforces types and bounds', () => {
  assert.ok(aiperf.validate({ concurrency: 0 }).error);
  assert.ok(aiperf.validate({ concurrency: 1025 }).error);
  assert.ok(aiperf.validate({ concurrency: 2.5 }).error);
  assert.ok(aiperf.validate({ concurrency: true }).error, 'a boolean is not an integer');
  assert.ok(aiperf.validate({ concurrency: '4' }).error);
  assert.ok(aiperf.validate({ endpointType: 'embeddings' }).error);
  assert.ok(aiperf.validate({ streaming: 'yes' }).error);
  assert.strictEqual(aiperf.validate({ requestRate: 2.5 }).params.requestRate, 2.5);
});

test('a duration replaces the default request count, but not an explicit one', () => {
  assert.strictEqual(aiperf.validate({ benchmarkDurationS: 60 }).params.requestCount, null);
  assert.match(aiperf.validate({ benchmarkDurationS: 60, requestCount: 10 }).error, /not both/);
  assert.match(aiperf.validate({ requestCount: null }).error, /request count or a duration/);
});

test('tokenizer: auto, builtin, HF id or a folder under /hf only', () => {
  for (const ok of ['auto', 'builtin', 'Qwen/Qwen3-8B', '/hf/tokenizers/llama']) {
    assert.ok(!aiperf.validate({ tokenizer: ok }).error, ok);
  }
  for (const bad of ['-x', '--help', '/etc/passwd', '/hf/../etc', 'a b', 'Qwen']) {
    assert.ok(aiperf.validate({ tokenizer: bad }).error, bad);
  }
});

test('resolveTokenizer: auto uses HF ids, falls back to builtin with a warning', () => {
  assert.deepStrictEqual(resolveTokenizer('auto', 'Qwen/Qwen3-8B'), { tokenizer: 'Qwen/Qwen3-8B', warning: null });
  const ollama = resolveTokenizer('auto', 'llama3.2:1b');
  assert.strictEqual(ollama.tokenizer, 'builtin');
  assert.match(ollama.warning, /approximate/);
  assert.strictEqual(resolveTokenizer('builtin', 'Qwen/Qwen3-8B').tokenizer, 'builtin');
});

test('target URL is reduced to the base the tool appends /v1/... to', () => {
  assert.strictEqual(normalizeTargetUrl('http://localhost:8000'), 'http://localhost:8000');
  assert.strictEqual(normalizeTargetUrl('http://localhost:8000/v1/'), 'http://localhost:8000');
  assert.strictEqual(normalizeTargetUrl('https://gpu-box.lan:30000/'), 'https://gpu-box.lan:30000');
  for (const bad of ['localhost:8000', 'ftp://x:1', 'http://u:p@host:1', 'http://host:1/?q=1', 'http://host:99999', '-http://x', 'http://host:1 --help']) {
    assert.strictEqual(normalizeTargetUrl(bad), null, bad);
  }
});

test('validateTarget: model names as servers report them, never an option', () => {
  for (const model of ['Qwen/Qwen3-8B', 'llama3.2:1b', 'hf.co/unsloth/gemma-3-4b-it-GGUF:Q4_K_M', 'gpt-oss:20b']) {
    assert.ok(!validateTarget({ url: 'http://localhost:1', model }).error, model);
  }
  for (const model of ['-m', '--help', '', 'a b', 'x'.repeat(201)]) {
    assert.ok(validateTarget({ url: 'http://localhost:1', model }).error, model);
  }
  assert.ok(validateTarget({ url: 'http://localhost:1', model: 'm', apiKey: 'has space' }).error);
  assert.strictEqual(validateTarget({ url: 'http://localhost:1', model: 'm', apiKey: '' }).target.apiKey, null);
});

test('buildArgv: exact argv, no shell, artifacts in the mounted folder', () => {
  const { params } = aiperf.validate({ concurrency: 4, isl: 512, osl: 64 });
  const argv = aiperf.buildArgv(params, { model: 'Qwen/Qwen3-8B', url: 'http://localhost:8000', apiKey: null });
  assert.deepStrictEqual(argv, [
    'profile',
    '--model', 'Qwen/Qwen3-8B',
    '--url', 'http://localhost:8000',
    '--endpoint-type', 'chat',
    '--streaming',
    '--concurrency', '4',
    '--request-count', '50',
    '--isl', '512', '--isl-stddev', '0',
    '--osl', '64', '--osl-stddev', '0',
    '--extra-inputs', 'ignore_eos:true',
    '--warmup-request-count', '4',
    '--random-seed', '42',
    '--tokenizer', 'Qwen/Qwen3-8B',
    '--request-timeout-seconds', '600',
    '--artifact-dir', '/artifacts',
    '--ui-type', 'none',
    '--no-gpu-telemetry',
  ]);
});

test('buildArgv: duration, rate, no streaming, no warmup', () => {
  const { params } = aiperf.validate({ benchmarkDurationS: 120, requestRate: 2, streaming: false, warmupRequestCount: 0, ignoreEos: false });
  const argv = aiperf.buildArgv(params, { model: 'llama3.2:1b', url: 'http://localhost:11434' });
  assert.ok(!argv.includes('--streaming'));
  assert.ok(!argv.includes('--request-count'));
  assert.ok(!argv.includes('--warmup-request-count'));
  assert.ok(!argv.includes('--extra-inputs'));
  assert.deepStrictEqual(argv.slice(argv.indexOf('--benchmark-duration'), argv.indexOf('--benchmark-duration') + 2), ['--benchmark-duration', '120']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('--request-rate'), argv.indexOf('--request-rate') + 2), ['--request-rate', '2']);
  assert.strictEqual(argv[argv.indexOf('--tokenizer') + 1], 'builtin');
});

test('the API key reaches the tool but never a log line', () => {
  const { params } = aiperf.validate({});
  const argv = aiperf.buildArgv(params, { model: 'm', url: 'http://localhost:1', apiKey: 'sk-secret' });
  assert.strictEqual(argv[argv.indexOf('--api-key') + 1], 'sk-secret');
  const shown = displayArgv(argv);
  assert.ok(!shown.join(' ').includes('sk-secret'));
  assert.strictEqual(shown[shown.indexOf('--api-key') + 1], '***');
  assert.strictEqual(shown[shown.indexOf('--tokenizer') + 1], 'builtin', 'only the key is masked');
});

test('parseResult reads a real AIPerf export into the canonical metrics', () => {
  const r = aiperf.parseResult(path.join(FIX, 'success'));
  assert.strictEqual(r.toolVersion, '0.13.0');
  assert.strictEqual(r.schemaVersion, '1.4');
  assert.strictEqual(r.wasCancelled, false);
  assert.strictEqual(r.isComplete, true);
  assert.strictEqual(r.errorCount, 0);
  assert.strictEqual(r.metrics.time_to_first_token.unit, 'ms');
  for (const k of ['avg', 'p50', 'p90', 'p99', 'min', 'max']) assert.ok(Number.isFinite(r.metrics.time_to_first_token[k]), k);
  assert.strictEqual(r.metrics.output_token_throughput.unit, 'tokens/sec');
  assert.ok(r.metrics.output_token_throughput.avg > 0);
  assert.strictEqual(r.metrics.output_token_throughput.p50, undefined, 'derived metrics only carry avg');
  assert.strictEqual(r.metrics.request_count.avg, 12);
  assert.strictEqual(r.metrics.http_req_duration, undefined, 'non-canonical metrics are left in the raw file');
});

test('parseResult: cancelled run with errors', () => {
  const r = aiperf.parseResult(path.join(FIX, 'cancelled'));
  assert.strictEqual(r.wasCancelled, true);
  assert.strictEqual(r.isComplete, false);
  assert.strictEqual(r.errorCount, 3);
  assert.strictEqual(r.metrics.request_count.avg, 16, 'not the warmup phase copy');
});

test('parseResult: summary nested in a run-named folder, phases/ copies ignored, absent file', () => {
  assert.strictEqual(aiperf.parseResult(path.join(FIX, 'nested')).file, path.join('my-model-openai-chat-concurrency1', 'profile_export_aiperf.json'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiperf-test-'));
  try {
    assert.strictEqual(aiperf.parseResult(dir), null);
    fs.mkdirSync(path.join(dir, 'phases', 'profiling'), { recursive: true });
    fs.copyFileSync(path.join(FIX, 'success', 'profile_export_aiperf.json'), path.join(dir, 'phases', 'profiling', 'profile_export_aiperf.json'));
    assert.strictEqual(aiperf.parseResult(dir), null, 'a per-phase copy is not the run summary');
    fs.writeFileSync(path.join(dir, 'profile_export_aiperf.json'), '{ torn');
    assert.strictEqual(aiperf.parseResult(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publicTool exposes the form schema but not the functions or Dockerfile', () => {
  const t = publicTool(aiperf);
  assert.ok(Array.isArray(t.params));
  assert.strictEqual(t.image, `spark-control-center/aiperf:${aiperf.version}`);
  assert.strictEqual(t.validate, undefined);
  assert.strictEqual(t.dockerfile, undefined);
  assert.match(aiperf.dockerfile, new RegExp(`aiperf==${aiperf.version.replace(/\./g, '\\.')}`));
});
