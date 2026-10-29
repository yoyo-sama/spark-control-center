// Benchmarks: runs a tool from benchtools.js against an inference server, one
// throwaway container per step, and keeps every run on disk.
//
// One run at a time, on purpose: two benchmarks sharing the GPU measure each other.
// A run is 1..N steps (a concurrency sweep is N steps); each step is one container
// whose artifact folder is bind-mounted from the run folder, then parsed.
//
// Layout under BENCH_DIR (same path on the host and in this container — the Docker
// daemon resolves bind sources on the HOST, see docker-compose.yml):
//   runs/<id>/run.json          config, status, steps, results, telemetry summaries
//   runs/<id>/log.jsonl         the run's log lines
//   runs/<id>/gpu.jsonl         GPU samples (1 s) for the whole run
//   runs/<id>/steps/<n>/        the tool's own artifacts for step n
//   hf-cache/                   HF_HOME of the tool containers (tokenizers)
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const Docker = require('dockerode');
const { TOOLS, publicTool, validateTarget, resolveTokenizer, displayArgv } = require('./benchtools');
const { discoverTargets, SELF_LABEL } = require('./benchtargets');
const { readGpuSample, getGpuMemoryByContainer } = require('./metrics');
const { buildFullState, readStored } = require('./gb10');

const BENCH_DIR = process.env.BENCH_DIR || '/var/lib/spark-control-center/benchmarks';
const RUNS_DIR = path.join(BENCH_DIR, 'runs');
const HF_CACHE_DIR = path.join(BENCH_DIR, 'hf-cache');

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const LOG_BUFFER = 3000;
const MAX_SWEEP_VALUES = 12;
const STEP_TIMEOUT_MS = 4 * 3600 * 1000;
// SIGINT lets AIPerf write partial results (SIGTERM kills it before it exports
// anything). Cancelled before its profiling phase, it can then hang: a second SIGINT
// ("Ctrl+C again") forces it out, then SIGKILL.
const STOP_GRACE_MS = 15000;
const FORCE_STOP_S = 10;
const TELEMETRY_POINTS = 1500;

const ACTIVE_STATUSES = ['queued', 'preparing', 'running'];

// ---------- store ----------

function newRunId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

// Every disk access goes through here: the id comes from the URL.
function runDir(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return null;
  return path.join(RUNS_DIR, id);
}

function saveRun(run) {
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.run.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
  fs.renameSync(tmp, path.join(dir, 'run.json'));
}

function loadRun(id) {
  const dir = runDir(id);
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}

function listRuns() {
  let ids;
  try {
    ids = fs.readdirSync(RUNS_DIR).filter((d) => RUN_ID_RE.test(d));
  } catch {
    return [];
  }
  return ids
    .map(loadRun)
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function deleteRun(id) {
  const dir = runDir(id);
  if (!dir || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function readJsonLines(file, limit) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (const line of limit ? lines.slice(-limit) : lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn last line of an interrupted run */
    }
  }
  return out;
}

// ---------- pure helpers ----------

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(v, digits = 1) {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// Same thresholds as computeKeyStatus() in gb10.js: above cap + 15 MHz the firmware is
// ignoring the cap; well below it, the cap was never reached so nothing can be said.
const LOADED_UTIL_PCT = 80;

function capVerdict(capMhz, loadedClocks) {
  if (capMhz === null || capMhz === undefined) {
    return { verdict: 'no-cap', message: 'No GB10 clock cap was set during this run' };
  }
  if (loadedClocks.length < 3) {
    return { verdict: 'not-observable', message: 'The GPU was not busy long enough to observe the cap' };
  }
  const max = Math.max(...loadedClocks);
  if (max > capMhz + 15) {
    return { verdict: 'exceeded', message: `Clock reached ${max} MHz under load, above the ${capMhz} MHz cap — this firmware likely ignores -lgc` };
  }
  if (median(loadedClocks) < capMhz - 50) {
    return { verdict: 'not-observable', message: `Clock stayed around ${median(loadedClocks)} MHz under load, below the ${capMhz} MHz cap: the cap was never reached` };
  }
  return { verdict: 'held', message: `Clock held at or below ${capMhz} MHz under load` };
}

// samples: [{ t (ms), clockMhz, powerW, tempC, utilPct }] for ONE step.
function summarizeTelemetry(samples, capMhz, metrics) {
  const valid = samples.filter((s) => s && Number.isFinite(s.t));
  const power = valid.map((s) => s.powerW).filter(Number.isFinite);
  const temp = valid.map((s) => s.tempC).filter(Number.isFinite);
  // utilization.gpu may be N/A on some firmwares: then every sample counts as loaded
  const loaded = valid.filter((s) => (Number.isFinite(s.utilPct) ? s.utilPct >= LOADED_UTIL_PCT : true));
  const loadedClocks = loaded.map((s) => s.clockMhz).filter(Number.isFinite);

  let energyJ = null;
  if (power.length >= 2) {
    energyJ = 0;
    for (let i = 1; i < valid.length; i++) {
      const a = valid[i - 1];
      const b = valid[i];
      if (!Number.isFinite(a.powerW) || !Number.isFinite(b.powerW)) continue;
      energyJ += ((a.powerW + b.powerW) / 2) * ((b.t - a.t) / 1000);
    }
  }
  const powerAvgW = power.length ? power.reduce((x, y) => x + y, 0) / power.length : null;
  const throughput = metrics && metrics.output_token_throughput ? metrics.output_token_throughput.avg : null;
  const tokensPerJoule = Number.isFinite(throughput) && powerAvgW > 0 ? throughput / powerAvgW : null;

  return {
    samples: valid.length,
    durationS: valid.length >= 2 ? round((valid[valid.length - 1].t - valid[0].t) / 1000) : null,
    powerAvgW: round(powerAvgW),
    powerMaxW: power.length ? round(Math.max(...power)) : null,
    tempMaxC: temp.length ? Math.max(...temp) : null,
    clockMedianMhz: loadedClocks.length ? median(loadedClocks) : null,
    clockMaxMhz: loadedClocks.length ? Math.max(...loadedClocks) : null,
    loadedSamples: loaded.length,
    energyJ: round(energyJ, 0),
    tokensPerJoule: round(tokensPerJoule, 2),
    cap: { mhz: capMhz ?? null, ...capVerdict(capMhz, loadedClocks) },
  };
}

// Two runs are only comparable under the same workload — the lesson of the clock-cap
// card, where watts measured under different loads were shown side by side. The model,
// the server and the clock cap are deliberately NOT part of it: comparing those is the
// point. Concurrency isn't either: steps are matched by concurrency level instead.
function workloadFingerprint(run) {
  const p = run.params || {};
  const swept = run.sweep ? run.sweep.key : null;
  const shape = {
    tool: run.tool && run.tool.id,
    version: run.tool && run.tool.version,
    endpointType: p.endpointType,
    streaming: p.streaming,
    isl: p.isl,
    islStddev: p.islStddev,
    osl: p.osl,
    oslStddev: p.oslStddev,
    ignoreEos: p.ignoreEos,
    requestCount: p.requestCount,
    benchmarkDurationS: p.benchmarkDurationS,
    requestRate: swept === 'requestRate' ? null : p.requestRate,
    warmupRequestCount: p.warmupRequestCount,
    randomSeed: p.randomSeed,
  };
  return crypto.createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
}

// Turns the tool's last log lines into one sentence a user can act on.
function explainFailure(lines, target) {
  const text = lines.join('\n');
  if (/ClientConnectorError|Connection refused|Connect call failed|Cannot connect to host/i.test(text)) {
    return `Nothing answered at ${target.url}. Check that the server is running and listening on that port of the host.`;
  }
  if (/TokenizerError|Failed to load tokenizer/i.test(text)) {
    return 'The tokenizer could not be loaded. Pick "builtin", or a Hugging Face repo id that matches the model.';
  }
  if (/\b404\b|model .* (not found|does not exist)|NotFound/i.test(text)) {
    return `The server refused the request (404): check the model name "${target.model}" and the endpoint type.`;
  }
  if (/\b401\b|\b403\b|Unauthorized|Forbidden/i.test(text)) {
    return 'The server refused the request (401/403): an API key is probably required.';
  }
  return null;
}

function stepSummary(step) {
  const m = (step.result && step.result.metrics) || {};
  const pick = (tag, stat) => (m[tag] && Number.isFinite(m[tag][stat]) ? m[tag][stat] : null);
  return {
    value: step.value,
    status: step.status,
    outputTokenThroughput: pick('output_token_throughput', 'avg'),
    ttftP50: pick('time_to_first_token', 'p50'),
    itlP50: pick('inter_token_latency', 'p50'),
    tokensPerJoule: step.telemetry ? step.telemetry.tokensPerJoule : null,
    capVerdict: step.telemetry ? step.telemetry.cap.verdict : null,
  };
}

// What the history list needs, without the per-step metric blocks.
function summarizeRun(run) {
  const steps = (run.steps || []).map(stepSummary);
  const done = steps.filter((s) => s.outputTokenThroughput !== null);
  const best = done.reduce((a, s) => (a === null || s.outputTokenThroughput > a.outputTokenThroughput ? s : a), null);
  return {
    id: run.id,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    status: run.status,
    error: run.error,
    tool: run.tool,
    target: { label: run.target.label, model: run.target.model, kind: run.target.kind, url: run.target.url },
    params: {
      endpointType: run.params.endpointType,
      streaming: run.params.streaming,
      concurrency: run.params.concurrency,
      isl: run.params.isl,
      osl: run.params.osl,
      requestCount: run.params.requestCount,
      benchmarkDurationS: run.params.benchmarkDurationS,
    },
    sweep: run.sweep,
    gb10: run.gb10 ? { capMhz: run.gb10.capMhz } : null,
    fingerprint: run.fingerprint,
    stepCount: steps.length,
    stepsDone: steps.filter((s) => ['success', 'cancelled', 'failed'].includes(s.status)).length,
    steps,
    best,
  };
}

function downsample(samples, max = TELEMETRY_POINTS) {
  if (samples.length <= max) return samples;
  const every = Math.ceil(samples.length / max);
  return samples.filter((_, i) => i % every === 0 || i === samples.length - 1);
}

// ---------- runner ----------

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

// A machine behind a corporate proxy needs it for pip (build) and for tokenizer
// downloads (run) — but the run must never send the benchmark traffic through it.
function proxyEnv() {
  const env = {};
  for (const k of PROXY_VARS) if (process.env[k]) env[k] = process.env[k];
  if (Object.keys(env).length === 0) return env;
  const local = 'localhost,127.0.0.1,::1,host.docker.internal';
  env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${local}` : local;
  env.no_proxy = env.NO_PROXY;
  return env;
}

async function defaultGb10Snapshot() {
  const stored = readStored();
  const state = await buildFullState(stored);
  // DEFAULT_DESIRED carries 2100 MHz even when the user never set a cap: only a cap the
  // user set AND the host pipeline applied is a cap the run was measured under.
  const managed = 'gpuClockLimitMhz' in stored && state.pipelineInstalled;
  return {
    capMhz: managed ? state.desired.gpuClockLimitMhz : null,
    capStatus: state.status.gpuClockLimitMhz || null,
    pipelineInstalled: state.pipelineInstalled,
    appliedAt: state.lastApply ? state.lastApply.appliedAt || null : null,
    clockMaxMhz: state.actual.gpuClockMaxMhz,
  };
}

// Some of AIPerf's rich panels carry colour codes even when stdout is not a TTY.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function lineSplitter(onLine) {
  let buf = '';
  const emit = (line) => {
    const clean = line.replace(ANSI_RE, '').trimEnd();
    if (clean.trim()) onLine(clean);
  };
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      for (const p of parts) emit(p);
    },
    flush() {
      emit(buf);
      buf = '';
    },
  };
}

function stopGracefully(container) {
  container.kill({ signal: 'SIGINT' }).catch(() => {});
  setTimeout(() => container.stop({ t: FORCE_STOP_S }).catch(() => {}), STOP_GRACE_MS).unref();
}

function createRunner({
  docker,
  sampleGpu = readGpuSample,
  gb10Snapshot = defaultGb10Snapshot,
  sampleIntervalMs = 1000,
  stepTimeoutMs = STEP_TIMEOUT_MS,
} = {}) {
  let hub = null; // the active run: { run, tool, apiKey, listeners, logs, samples, … }

  function emit(event) {
    if (!hub) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of hub.listeners) {
      try {
        res.write(payload);
      } catch {
        /* client gone */
      }
    }
  }

  function log(type, text) {
    if (!hub) return;
    const entry = { type, text, time: new Date().toISOString() };
    hub.logs.push(entry);
    if (hub.logs.length > LOG_BUFFER) hub.logs.splice(0, hub.logs.length - LOG_BUFFER);
    hub.logFile.write(`${JSON.stringify(entry)}\n`);
    emit({ type: 'log', log: entry });
  }

  function persist() {
    saveRun(hub.run);
    emit({ type: 'run', run: hub.run });
  }

  function sleepCancellable(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        hub.wake = null;
        resolve();
      }
      hub.wake = done;
    });
  }

  async function imageReady(tool) {
    try {
      await docker.getImage(tool.image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async function ensureImage(tool) {
    if (await imageReady(tool)) return;
    log('info', `Preparing ${tool.label} ${tool.version}: building ${tool.image} (first run only, downloads ${tool.imageSizeHint || 'a few hundred MB'})…`);
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-bench-build-'));
    try {
      fs.writeFileSync(path.join(ctx, 'Dockerfile'), tool.dockerfile);
      const stream = await docker.buildImage(
        { context: ctx, src: ['Dockerfile'] },
        // host network: a proxy listening on the host's localhost (cntlm…) stays reachable
        { t: tool.image, labels: { 'spark-control-center.tool': tool.id }, buildargs: proxyEnv(), networkmode: 'host', rm: true, forcerm: true },
      );
      hub.buildStream = stream;
      const split = lineSplitter((line) => log('output', line));
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(
          stream,
          (err, output) => {
            split.flush();
            const failed = err || (output || []).find((o) => o && (o.error || o.errorDetail));
            if (failed) reject(new Error(err ? err.message : failed.error || failed.errorDetail.message));
            else resolve();
          },
          (evt) => {
            if (evt && typeof evt.stream === 'string') split.push(evt.stream);
            else if (evt && evt.status) split.push(`${evt.status}${evt.progress ? ` ${evt.progress}` : ''}\n`);
          },
        );
      });
      if (hub.cancelRequested) throw new Error('Cancelled during image build');
      log('success', `${tool.image} is ready`);
    } finally {
      hub.buildStream = null;
      fs.rm(ctx, { recursive: true, force: true }, () => {});
    }
  }

  function startSampler() {
    let busy = false;
    let stopped = false;
    const file = fs.createWriteStream(path.join(runDir(hub.run.id), 'gpu.jsonl'), { flags: 'a' });
    file.on('error', () => {});
    const h = hub;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await sampleGpu();
        if (s && !stopped) {
          const sample = { t: Date.now(), step: h.currentStep, ...s };
          h.samples.push(sample);
          file.write(`${JSON.stringify(sample)}\n`);
          if (h === hub) emit({ type: 'telemetry', sample });
        }
      } finally {
        busy = false;
      }
    }, sampleIntervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
      file.end();
    };
  }

  async function runStep(index) {
    const { run, tool, apiKey } = hub;
    const step = run.steps[index];
    const stepParams = { ...run.params, ...step.params };
    const argv = tool.buildArgv(stepParams, { model: run.target.model, url: run.target.url, apiKey });
    const stepDir = path.join(runDir(run.id), 'steps', String(index));
    fs.mkdirSync(stepDir, { recursive: true });

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    step.command = `${tool.id} ${displayArgv(argv).join(' ')}`;
    hub.currentStep = index;
    persist();
    log('info', `Step ${index + 1}/${run.steps.length}${run.sweep ? ` — ${run.sweep.key} ${step.value}` : ''}`);
    log('cmd', `$ ${step.command}`);

    const tail = [];
    const split = lineSplitter((line) => {
      tail.push(line);
      if (tail.length > 60) tail.shift();
      log('output', line);
    });
    let container = null;
    let timedOut = false;
    try {
      container = await docker.createContainer({
        Image: tool.image,
        Cmd: argv,
        Labels: { [SELF_LABEL]: run.id, 'spark-control-center.step': String(index) },
        Env: Object.entries({
          HF_HOME: '/hf',
          // `builtin` is tiktoken: it downloads its BPE file once, cache it next to the tokenizers
          TIKTOKEN_CACHE_DIR: '/hf/tiktoken',
          PYTHONUNBUFFERED: '1',
          // rich renders its summary tables to this width when stdout is not a TTY
          COLUMNS: '160',
          ...proxyEnv(),
        }).map(([k, v]) => `${k}=${v}`),
        StopSignal: 'SIGINT',
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          // The target URL is http://localhost:<port> of the HOST
          NetworkMode: 'host',
          Binds: [`${stepDir}:${tool.artifactDir}`, `${HF_CACHE_DIR}:/hf`],
          ShmSize: 1024 * 1024 * 1024,
          // tini as PID 1 forwards the stop signal to the tool
          Init: true,
        },
      });
      hub.container = container;
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const out = new PassThrough();
      out.on('data', (c) => split.push(c));
      docker.modem.demuxStream(stream, out, out);
      const streamEnded = new Promise((resolve) => stream.on('end', resolve));
      await container.start();
      if (hub.cancelRequested) stopGracefully(container);
      const timer = setTimeout(() => {
        timedOut = true;
        log('error', `Step exceeded ${Math.round(stepTimeoutMs / 60000)} min, stopping it`);
        stopGracefully(container);
      }, stepTimeoutMs);
      const { StatusCode } = await container.wait();
      clearTimeout(timer);
      await Promise.race([streamEnded, new Promise((r) => setTimeout(r, 2000))]);
      step.exitCode = StatusCode;
    } catch (err) {
      step.error = err.message;
      log('error', err.message);
    } finally {
      split.flush();
      hub.container = null;
      hub.currentStep = null;
      if (container) await container.remove({ force: true }).catch(() => {});
    }

    const result = tool.parseResult(stepDir);
    step.result = result;
    const samples = hub.samples.filter((s) => s.step === index);
    step.telemetry = summarizeTelemetry(samples, run.gb10 ? run.gb10.capMhz : null, result ? result.metrics : null);
    if (timedOut) {
      step.status = 'failed';
      step.error = `Timed out after ${Math.round(stepTimeoutMs / 60000)} min${result ? ' (partial results kept)' : ''}`;
    } else if (result) {
      step.status = result.wasCancelled ? 'cancelled' : 'success';
      if (result.errorCount > 0) log('error', `${result.errorCount} request(s) failed during this step`);
    } else {
      step.status = hub.cancelRequested ? 'cancelled' : 'failed';
      if (step.status === 'failed') {
        step.error = explainFailure(tail, run.target) || step.error || `${tool.label} exited with code ${step.exitCode} without writing results`;
      }
    }
    step.finishedAt = new Date().toISOString();
    if (step.status === 'success') {
      const s = stepSummary(step);
      const parts = [
        s.outputTokenThroughput !== null ? `${round(s.outputTokenThroughput)} tok/s` : null,
        s.ttftP50 !== null ? `TTFT p50 ${round(s.ttftP50)} ms` : null,
        s.tokensPerJoule !== null ? `${s.tokensPerJoule} tok/J` : null,
      ].filter(Boolean);
      log('success', `Step ${index + 1} done${parts.length ? `: ${parts.join(' · ')}` : ''}`);
    } else if (step.status === 'failed') {
      log('error', step.error);
    }
    persist();
  }

  async function execute() {
    const { run, tool } = hub;
    let stopSampler = null;
    try {
      run.status = 'preparing';
      persist();
      await ensureImage(tool);
      try {
        run.gb10 = await gb10Snapshot();
      } catch {
        run.gb10 = null;
      }
      const tk = resolveTokenizer(run.params.tokenizer, run.target.model);
      if (tk.warning) {
        run.warnings.push(tk.warning);
        log('info', tk.warning);
      }
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      persist();
      stopSampler = startSampler();

      for (let i = 0; i < run.steps.length; i++) {
        if (hub.cancelRequested) break;
        if (i > 0 && run.cooldownS > 0) {
          log('info', `Cooling down for ${run.cooldownS} s before the next step…`);
          await sleepCancellable(run.cooldownS * 1000);
          if (hub.cancelRequested) break;
        }
        await runStep(i);
        if (run.steps[i].status === 'failed') break;
      }

      for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped';
      const statuses = run.steps.map((s) => s.status);
      if (hub.cancelRequested) run.status = 'cancelled';
      else if (statuses.includes('failed')) {
        run.status = 'failed';
        run.error = run.steps.find((s) => s.status === 'failed').error;
      } else run.status = 'success';
    } catch (err) {
      run.status = hub.cancelRequested ? 'cancelled' : 'failed';
      run.error = err.message;
      for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped';
      log('error', err.message);
    } finally {
      if (stopSampler) stopSampler();
      run.finishedAt = new Date().toISOString();
      log(run.status === 'success' ? 'success' : run.status === 'cancelled' ? 'info' : 'error', `Run ${run.status}`);
      try {
        persist();
      } catch (err) {
        console.error(`benchmark ${run.id}: could not save the final state: ${err.message}`);
      }
      emit({ type: 'end' });
      for (const res of hub.listeners) res.end();
      hub.logFile.end();
      hub = null;
    }
  }

  return {
    activeRunId: () => (hub ? hub.run.id : null),

    imageReady,

    // ctx: { tool, target (validated, with apiKey), params, sweep, cooldownS }
    start({ tool, target, params, sweep, cooldownS }) {
      if (hub) return { error: 'A benchmark is already running', activeRunId: hub.run.id };
      const { apiKey, ...publicTarget } = target;
      const values = sweep ? sweep.values : [params[tool.params.find((p) => p.sweepable).key]];
      const sweepKey = sweep ? sweep.key : 'concurrency';
      const run = {
        id: newRunId(),
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        status: 'queued',
        error: null,
        tool: { id: tool.id, label: tool.label, version: tool.version },
        target: { ...publicTarget, hasApiKey: Boolean(apiKey) },
        params,
        sweep: sweep || null,
        cooldownS: sweep ? cooldownS : 0,
        gb10: null,
        warnings: [],
        steps: values.map((value, index) => ({
          index,
          key: sweepKey,
          value,
          params: sweep ? { [sweep.key]: value } : {},
          status: 'pending',
        })),
      };
      run.fingerprint = workloadFingerprint(run);
      fs.mkdirSync(path.join(runDir(run.id), 'steps'), { recursive: true });
      fs.mkdirSync(HF_CACHE_DIR, { recursive: true });
      hub = {
        run,
        tool,
        apiKey,
        listeners: new Set(),
        logs: [],
        samples: [],
        currentStep: null,
        container: null,
        buildStream: null,
        wake: null,
        cancelRequested: false,
        logFile: fs.createWriteStream(path.join(runDir(run.id), 'log.jsonl'), { flags: 'a' }),
      };
      hub.logFile.on('error', () => {});
      saveRun(run);
      log('info', `${tool.label} → ${run.target.label || run.target.url} · model ${run.target.model}`);
      execute().catch((err) => console.error(`benchmark ${run.id}: ${err.stack || err.message}`));
      return { run };
    },

    cancel(id) {
      if (!hub || hub.run.id !== id) return false;
      if (hub.cancelRequested) return true;
      hub.cancelRequested = true;
      log('info', 'Cancel requested — letting the tool write partial results…');
      if (hub.container) stopGracefully(hub.container);
      if (hub.buildStream && hub.buildStream.destroy) hub.buildStream.destroy();
      if (hub.wake) hub.wake();
      return true;
    },

    // Live view of the active run, for the SSE route; null when `id` isn't running.
    live(id) {
      if (!hub || hub.run.id !== id) return null;
      return {
        run: hub.run,
        logs: hub.logs.slice(-1000),
        samples: downsample(hub.samples),
        subscribe(res) {
          hub.listeners.add(res);
          const h = hub;
          return () => h.listeners.delete(res);
        },
      };
    },

    // At startup: a run still marked active was cut short by a restart of this app.
    async reconcile() {
      for (const run of listRuns()) {
        if (!ACTIVE_STATUSES.includes(run.status)) continue;
        run.status = 'interrupted';
        run.error = 'Spark Control Center restarted while this run was in progress';
        run.finishedAt = run.finishedAt || new Date().toISOString();
        for (const s of run.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
        saveRun(run);
      }
      try {
        const orphans = await docker.listContainers({ all: true, filters: { label: [SELF_LABEL] } });
        for (const c of orphans) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
      } catch {
        /* docker unavailable */
      }
    },
  };
}

// ---------- request validation ----------

function validateSweep(tool, sweep) {
  if (sweep === undefined || sweep === null) return { sweep: null };
  if (typeof sweep !== 'object') return { error: 'Invalid sweep' };
  const spec = tool.params.find((p) => p.key === sweep.key && p.sweepable);
  if (!spec) return { error: `Cannot sweep over ${sweep.key}` };
  if (!Array.isArray(sweep.values) || sweep.values.length < 2 || sweep.values.length > MAX_SWEEP_VALUES) {
    return { error: `A sweep needs 2 to ${MAX_SWEEP_VALUES} values` };
  }
  for (const v of sweep.values) {
    const { error } = tool.validate({ [spec.key]: v });
    if (error) return { error: `Invalid sweep value ${JSON.stringify(v)} for ${spec.key}` };
  }
  const values = [...new Set(sweep.values)].sort((a, b) => a - b);
  if (values.length < 2) return { error: 'A sweep needs at least 2 distinct values' };
  return { sweep: { key: spec.key, values } };
}

function validateRunRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tool = TOOLS[b.toolId];
  if (!tool || !Object.prototype.hasOwnProperty.call(TOOLS, b.toolId)) return { error: 'Unknown tool' };
  const t = validateTarget(b.target);
  if (t.error) return { error: t.error };
  const p = tool.validate(b.params);
  if (p.error) return { error: p.error };
  const s = validateSweep(tool, b.sweep);
  if (s.error) return { error: s.error };
  const cooldownS = b.cooldownS === undefined ? 10 : b.cooldownS;
  if (!Number.isInteger(cooldownS) || cooldownS < 0 || cooldownS > 600) return { error: 'Invalid cooldown' };
  return { tool, target: t.target, params: p.params, sweep: s.sweep, cooldownS };
}

// ---------- router ----------

function createRouter(runner) {
  const router = express.Router();

  // A cross-site <form> can POST without a CORS preflight, but not with a JSON content type.
  function requireJson(req, res, next) {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Expected a JSON body' });
    next();
  }

  router.get('/tools', async (req, res) => {
    const tools = await Promise.all(Object.values(TOOLS).map(async (tool) => ({
      ...publicTool(tool),
      imageReady: await runner.imageReady(tool),
    })));
    res.json({ tools, activeRunId: runner.activeRunId() });
  });

  router.get('/targets', async (req, res) => {
    let gpuMemoryByContainer = null;
    try {
      gpuMemoryByContainer = await getGpuMemoryByContainer();
    } catch {
      /* no GPU info */
    }
    res.json({ targets: await discoverTargets({ gpuMemoryByContainer }) });
  });

  // Polled by every page for the "benchmark running" indicator: no disk scan.
  router.get('/status', (req, res) => {
    const live = runner.activeRunId() ? runner.live(runner.activeRunId()) : null;
    if (!live) return res.json({ active: null });
    const { run } = live;
    res.json({
      active: {
        id: run.id,
        status: run.status,
        model: run.target.model,
        tool: run.tool.label,
        stepCount: run.steps.length,
        stepsDone: run.steps.filter((s) => !['pending', 'running'].includes(s.status)).length,
      },
    });
  });

  router.get('/runs', (req, res) => {
    res.json({ runs: listRuns().map(summarizeRun), activeRunId: runner.activeRunId() });
  });

  router.post('/runs', requireJson, (req, res) => {
    const v = validateRunRequest(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const started = runner.start(v);
    if (started.error) return res.status(409).json({ error: started.error, activeRunId: started.activeRunId });
    res.status(202).json({ id: started.run.id, run: started.run });
  });

  router.get('/runs/:id', (req, res) => {
    const live = runner.live(req.params.id);
    const run = live ? live.run : loadRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  router.get('/runs/:id/telemetry', (req, res) => {
    const live = runner.live(req.params.id);
    if (live) return res.json({ samples: live.samples });
    const dir = runDir(req.params.id);
    if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'Run not found' });
    res.json({ samples: downsample(readJsonLines(path.join(dir, 'gpu.jsonl'))) });
  });

  router.get('/runs/:id/steps/:n/result.json', (req, res) => {
    const run = loadRun(req.params.id);
    const n = Number(req.params.n);
    if (!run || !Number.isInteger(n) || n < 0 || n >= run.steps.length) return res.status(404).json({ error: 'Not found' });
    const step = run.steps[n];
    if (!step.result || !step.result.file) return res.status(404).json({ error: 'This step has no result file' });
    const file = path.join(runDir(run.id), 'steps', String(n), step.result.file);
    res.download(file, `${run.id}-step${n}-${path.basename(file)}`);
  });

  // SSE. compression() would buffer this stream: `no-transform` makes it skip it.
  router.get('/runs/:id/events', (req, res) => {
    const live = runner.live(req.params.id);
    const run = live ? live.run : loadRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const dir = runDir(run.id);
    const snapshot = live
      ? { type: 'snapshot', run, logs: live.logs, samples: live.samples }
      : {
        type: 'snapshot',
        run,
        logs: readJsonLines(path.join(dir, 'log.jsonl'), 1000),
        samples: downsample(readJsonLines(path.join(dir, 'gpu.jsonl'))),
      };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    if (!live) {
      res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
      return res.end();
    }
    const unsubscribe = live.subscribe(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post('/runs/:id/cancel', requireJson, (req, res) => {
    if (!runner.cancel(req.params.id)) return res.status(409).json({ error: 'This run is not running' });
    res.json({ ok: true });
  });

  router.delete('/runs/:id', (req, res) => {
    if (!runDir(req.params.id)) return res.status(404).json({ error: 'Run not found' });
    if (runner.activeRunId() === req.params.id) return res.status(409).json({ error: 'Cancel the run before deleting it' });
    if (!deleteRun(req.params.id)) return res.status(404).json({ error: 'Run not found' });
    res.json({ ok: true });
  });

  return router;
}

const runner = createRunner({ docker: new Docker({ socketPath: '/var/run/docker.sock' }) });
const router = createRouter(runner);

module.exports = {
  router,
  runner,
  createRunner,
  createRouter,
  validateRunRequest,
  summarizeTelemetry,
  capVerdict,
  workloadFingerprint,
  explainFailure,
  summarizeRun,
  lineSplitter,
  newRunId,
  runDir,
  saveRun,
  loadRun,
  listRuns,
  deleteRun,
  downsample,
  BENCH_DIR,
};
