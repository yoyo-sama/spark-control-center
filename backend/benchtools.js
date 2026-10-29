// Benchmark tool registry. Each tool is an adapter: the image it runs in, the
// parameters the UI may set (with bounds), how those become an argv, and how its
// result files map onto the canonical metric set. Pure functions only — everything
// that touches Docker lives in benchmarks.js.
//
// Not part of APPS (apps.js): a benchmark tool has no config file to edit, and
// listing it there would surface it in /api/apps and in the insight engine.
const fs = require('fs');
const path = require('path');

// Pinned: the image tag carries the version, so bumping it rebuilds the image.
const AIPERF_VERSION = /^\d+\.\d+\.\d+$/.test(process.env.AIPERF_VERSION || '')
  ? process.env.AIPERF_VERSION
  : '0.13.0';

// Model names as servers report them: `Qwen/Qwen3-8B`, `llama3.2:1b`,
// `hf.co/unsloth/gemma-3-4b-it-GGUF:Q4_K_M`. Never a leading `-`, so it can't be
// read as an option by the tool's CLI parser.
const MODEL_RE = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;
// HF repo id (`org/name`), or a tokenizer folder copied under the HF cache mount.
const HF_ID_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,96}$/;
const LOCAL_TOKENIZER_RE = /^\/hf\/[\w.\/-]{1,200}$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[\w.\/-]*)?$/;

// Canonical metric names are AIPerf's tags; a future tool's parseResult maps onto them.
const CANONICAL_METRICS = [
  'time_to_first_token',
  'inter_token_latency',
  'request_latency',
  'output_token_throughput',
  'output_token_throughput_per_user',
  'request_throughput',
  'total_token_throughput',
  'input_sequence_length',
  'output_sequence_length',
  'request_count',
  'error_request_count',
  'request_error_rate',
  'benchmark_duration',
  'total_output_tokens',
];
const KEPT_STATS = ['unit', 'avg', 'min', 'max', 'p50', 'p90', 'p95', 'p99', 'std'];

// Declarative: served as-is to the UI, which renders its form from it.
const AIPERF_PARAMS = [
  { key: 'endpointType', type: 'enum', choices: ['chat', 'completions'], default: 'chat', label: 'Endpoint' },
  { key: 'streaming', type: 'bool', default: true, label: 'Streaming', help: 'Required to measure TTFT and inter-token latency' },
  { key: 'concurrency', type: 'int', min: 1, max: 1024, default: 1, sweepable: true, label: 'Concurrency', help: 'Requests kept in flight at once' },
  { key: 'requestCount', type: 'int', min: 1, max: 100000, default: 50, nullable: true, label: 'Requests' },
  { key: 'benchmarkDurationS', type: 'int', min: 5, max: 7200, default: null, nullable: true, label: 'Duration (s)' },
  { key: 'requestRate', type: 'number', min: 0.01, max: 10000, default: null, nullable: true, label: 'Request rate (req/s)' },
  { key: 'isl', type: 'int', min: 1, max: 262144, default: 128, label: 'Input tokens' },
  { key: 'islStddev', type: 'int', min: 0, max: 65536, default: 0, label: 'Input tokens stddev' },
  { key: 'osl', type: 'int', min: 1, max: 131072, default: 128, label: 'Output tokens' },
  { key: 'oslStddev', type: 'int', min: 0, max: 65536, default: 0, label: 'Output tokens stddev' },
  { key: 'ignoreEos', type: 'bool', default: true, label: 'Fixed output length', help: 'Sends ignore_eos so every answer is exactly "Output tokens" long (vLLM, SGLang, llama.cpp honor it)' },
  { key: 'warmupRequestCount', type: 'int', min: 0, max: 10000, default: 4, label: 'Warmup requests', help: 'Not measured; also absorbs model loading (Ollama loads on first request)' },
  { key: 'randomSeed', type: 'int', min: 0, max: 2147483647, default: 42, label: 'Random seed' },
  { key: 'tokenizer', type: 'string', default: 'auto', label: 'Tokenizer', help: '"auto" uses the model id when it is a Hugging Face repo, else the built-in tiktoken tokenizer' },
  { key: 'requestTimeoutS', type: 'int', min: 1, max: 86400, default: 600, label: 'Request timeout (s)' },
];

function checkParam(spec, v) {
  if (v === null) return spec.nullable === true || spec.default === null;
  switch (spec.type) {
    case 'enum': return spec.choices.includes(v);
    case 'bool': return typeof v === 'boolean';
    // typeof check first: Number.isInteger(true) is false, but keep bools out explicitly
    case 'int': return typeof v === 'number' && Number.isInteger(v) && v >= spec.min && v <= spec.max;
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max;
    case 'string': return typeof v === 'string';
    default: return false;
  }
}

// Unknown key → error, like BOUNDS in gb10.js. Returns { params } with defaults filled,
// or { error }.
function validateParams(specs, input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const params = {};
  for (const key of Object.keys(body)) {
    if (!specs.some((s) => s.key === key)) return { error: `Unknown parameter: ${key}` };
  }
  for (const spec of specs) {
    const v = has(body, spec.key) ? body[spec.key] : spec.default;
    if (!checkParam(spec, v)) return { error: `Invalid value for ${spec.key}` };
    params[spec.key] = v;
  }
  return { params };
}

function has(obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

function validateAiperf(input) {
  // A duration replaces the default request count unless one was given explicitly.
  const body = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : input;
  if (body && body.benchmarkDurationS != null && !has(body, 'requestCount')) body.requestCount = null;
  const { params, error } = validateParams(AIPERF_PARAMS, body);
  if (error) return { error };
  if (params.requestCount !== null && params.benchmarkDurationS !== null) {
    return { error: 'Set either a request count or a duration, not both' };
  }
  if (params.requestCount === null && params.benchmarkDurationS === null) {
    return { error: 'Set a request count or a duration' };
  }
  const t = params.tokenizer;
  if (!(t === 'auto' || t === 'builtin' || HF_ID_RE.test(t) || (LOCAL_TOKENIZER_RE.test(t) && !t.includes('..')))) {
    return { error: 'Tokenizer must be "auto", "builtin", a Hugging Face repo id (org/name) or a folder under /hf/' };
  }
  return { params };
}

// `--url http://host:8000/v1` would make the tool call /v1/v1/chat/completions:
// it appends the OpenAI path itself, so keep only the base.
function normalizeTargetUrl(url) {
  if (typeof url !== 'string' || !URL_RE.test(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.port && (Number(u.port) < 1 || Number(u.port) > 65535)) return null;
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function validateTarget(input) {
  const t = input && typeof input === 'object' ? input : {};
  const url = normalizeTargetUrl(t.url);
  if (!url) return { error: 'Target URL must look like http://host:port' };
  if (typeof t.model !== 'string' || !MODEL_RE.test(t.model)) return { error: 'Invalid model name' };
  const apiKey = t.apiKey === undefined || t.apiKey === null || t.apiKey === '' ? null : t.apiKey;
  if (apiKey !== null && (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(apiKey))) {
    return { error: 'Invalid API key' };
  }
  const label = typeof t.label === 'string' ? t.label.slice(0, 120) : null;
  const kind = typeof t.kind === 'string' && /^[a-z0-9-]{1,32}$/.test(t.kind) ? t.kind : null;
  const containerName = typeof t.containerName === 'string' && /^[\w.-]{1,128}$/.test(t.containerName) ? t.containerName : null;
  return { target: { url, model: t.model, apiKey, label, kind, containerName } };
}

function resolveTokenizer(tokenizer, model) {
  if (tokenizer !== 'auto') return { tokenizer, warning: null };
  if (HF_ID_RE.test(model)) return { tokenizer: model, warning: null };
  return {
    tokenizer: 'builtin',
    warning: `"${model}" is not a Hugging Face repo id: token counts use the built-in tiktoken tokenizer and are approximate`,
  };
}

function buildAiperfArgv(params, { model, url, apiKey }) {
  const { tokenizer } = resolveTokenizer(params.tokenizer, model);
  const argv = [
    'profile',
    '--model', model,
    '--url', url,
    '--endpoint-type', params.endpointType,
  ];
  if (params.streaming) argv.push('--streaming');
  argv.push('--concurrency', String(params.concurrency));
  if (params.requestRate !== null) argv.push('--request-rate', String(params.requestRate));
  if (params.requestCount !== null) argv.push('--request-count', String(params.requestCount));
  if (params.benchmarkDurationS !== null) argv.push('--benchmark-duration', String(params.benchmarkDurationS));
  argv.push(
    '--isl', String(params.isl),
    '--isl-stddev', String(params.islStddev),
    '--osl', String(params.osl),
    '--osl-stddev', String(params.oslStddev),
  );
  if (params.ignoreEos) argv.push('--extra-inputs', 'ignore_eos:true');
  if (params.warmupRequestCount > 0) argv.push('--warmup-request-count', String(params.warmupRequestCount));
  argv.push(
    '--random-seed', String(params.randomSeed),
    '--tokenizer', tokenizer,
    '--request-timeout-seconds', String(params.requestTimeoutS),
    '--artifact-dir', '/artifacts',
    '--ui-type', 'none',
    // GPU telemetry is sampled by the app itself (nvidia-smi), the tool container has no GPU
    '--no-gpu-telemetry',
  );
  if (apiKey) argv.push('--api-key', apiKey);
  return argv;
}

// For logs and run.json: the argv with the API key value replaced.
function displayArgv(argv) {
  return argv.map((v, i) => (argv[i - 1] === '--api-key' ? '***' : v));
}

// With an explicit --artifact-dir the summary sits at the top level; AIPerf also writes
// per-phase copies under phases/{warmup,profiling}/ which must not be mistaken for it.
// The bounded search covers versions that nest the summary in a run-named subfolder.
function findSummaryFile(dir, name, depth = 0) {
  const direct = path.join(dir, name);
  if (fs.existsSync(direct)) return direct;
  if (depth >= 2) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'phases' || e.name === 'logs') continue;
    const found = findSummaryFile(path.join(dir, e.name), name, depth + 1);
    if (found) return found;
  }
  return null;
}

function pickStats(block) {
  const out = {};
  for (const k of KEPT_STATS) if (block[k] !== undefined) out[k] = block[k];
  return out;
}

// Open schema (the AIPerf docs say so explicitly): read what is there, ignore the rest.
function parseAiperfResult(stepDir) {
  const file = findSummaryFile(stepDir, 'profile_export_aiperf.json');
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const metrics = {};
  for (const tag of CANONICAL_METRICS) {
    const block = data[tag];
    if (block && typeof block === 'object' && typeof block.unit === 'string') metrics[tag] = pickStats(block);
  }
  const errorSummary = Array.isArray(data.error_summary) ? data.error_summary : [];
  return {
    file: path.relative(stepDir, file),
    schemaVersion: data.schema_version ?? null,
    toolVersion: data.aiperf_version ?? null,
    wasCancelled: data.was_cancelled === true,
    isComplete: data.is_complete !== false,
    errorCount: errorSummary.reduce((n, e) => n + (Number(e.count) || 0), 0),
    errorSummary: errorSummary.slice(0, 10),
    metrics,
  };
}

const TOOLS = {
  aiperf: {
    id: 'aiperf',
    label: 'AIPerf',
    vendor: 'NVIDIA ai-dynamo',
    description: 'Load generator for OpenAI-compatible LLM servers: TTFT, inter-token latency, throughput, percentiles.',
    homepage: 'https://github.com/ai-dynamo/aiperf',
    version: AIPERF_VERSION,
    image: `spark-control-center/aiperf:${AIPERF_VERSION}`,
    imageSizeHint: '~1.7 GB',
    // AIPerf 0.13 hard-requires `crick`, which ships no Linux aarch64 wheel: on the
    // Spark pip compiles it from source. The full python image has the compiler; the
    // final slim image (same Python, same /usr/local layout) only gets the virtualenv.
    dockerfile: [
      'FROM python:3.12 AS build',
      `RUN python -m venv /opt/aiperf && /opt/aiperf/bin/pip install --no-cache-dir aiperf==${AIPERF_VERSION}`,
      'FROM python:3.12-slim',
      'COPY --from=build /opt/aiperf /opt/aiperf',
      'ENV PATH=/opt/aiperf/bin:$PATH',
      'ENTRYPOINT ["aiperf"]',
    ].join('\n') + '\n',
    // Where the step's artifact folder is mounted, and the summary file inside it.
    artifactDir: '/artifacts',
    resultFile: 'profile_export_aiperf.json',
    params: AIPERF_PARAMS,
    validate: validateAiperf,
    buildArgv: buildAiperfArgv,
    parseResult: parseAiperfResult,
  },
};

function publicTool(tool) {
  const { validate, buildArgv, parseResult, dockerfile, ...rest } = tool;
  return rest;
}

module.exports = {
  TOOLS,
  CANONICAL_METRICS,
  publicTool,
  validateTarget,
  normalizeTargetUrl,
  resolveTokenizer,
  displayArgv,
  findSummaryFile,
};
