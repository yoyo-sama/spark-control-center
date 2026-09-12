// GB10 tuning API: exposes desired/actual/status for GPU clock, persistence,
// swap and vm.swappiness knobs. Never applies anything itself — that's
// host/gb10-tuning/apply.py's job, run out-of-band. This module only reads
// /proc + nvidia-smi and reads/writes state.json (desired) + result.json
// (last apply outcome, written by apply.py).
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const STATE_DIR = process.env.GB10_STATE_DIR || '/etc/gb10-tuning';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const RESULT_FILE = path.join(STATE_DIR, 'result.json');
const THERMAL_SCRIPT = process.env.GB10_THERMAL_SCRIPT || 'thermal-monitor.sh';

const DEFAULT_DESIRED = {
  version: 1,
  updatedAt: null,
  gpuClockLimitMhz: 2100,
  gpuPersistenceMode: true,
  swapDisabled: false,
  vmSwappiness: 10,
  thermalMonitor: false,
};

const RECOMMENDED_ENV = [
  { name: 'CUDA_CACHE_MAXSIZE', expected: '4294967296' },
  { name: 'NCCL_P2P_DISABLE', expected: '1' },
];
const BANNED_ENV = ['CUDA_CACHE_DISABLE', 'PYTORCH_NO_CUDA_MEMORY_CACHING'];

const BOUNDS = {
  gpuClockLimitMhz: (v) => v === null || (Number.isInteger(v) && v >= 300 && v <= 3003),
  gpuPersistenceMode: (v) => typeof v === 'boolean',
  swapDisabled: (v) => typeof v === 'boolean',
  vmSwappiness: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  thermalMonitor: (v) => typeof v === 'boolean',
};

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function readDesired() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { ...DEFAULT_DESIRED };
  }
}

function readLastApply() {
  try {
    return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function readGpuActual() {
  try {
    const out = execSync(
      'nvidia-smi -i 0 --query-gpu=persistence_mode,clocks.gr,clocks.applications.graphics,clocks.max.graphics,temperature.gpu,power.draw --format=csv,noheader,nounits'
    ).toString().trim();
    const [persistence, clockCur, clockApp, clockMax, temp, power] = out.split(',').map((s) => s.trim());
    return {
      gpuPersistenceMode: persistence === 'Enabled' ? true : persistence === 'Disabled' ? false : null,
      gpuClockCurrentMhz: num(clockCur),
      gpuClockApplicationsMhz: num(clockApp),
      gpuClockMaxMhz: num(clockMax),
      gpuTemperatureCelsius: num(temp),
      gpuPowerDrawWatts: num(power),
    };
  } catch {
    return {
      gpuPersistenceMode: null,
      gpuClockCurrentMhz: null,
      gpuClockApplicationsMhz: null,
      gpuClockMaxMhz: null,
      gpuTemperatureCelsius: null,
      gpuPowerDrawWatts: null,
    };
  }
}

function readSwapActual() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(meminfo.match(/SwapTotal:\s+(\d+) kB/)[1], 10) * 1024;
    const free = parseInt(meminfo.match(/SwapFree:\s+(\d+) kB/)[1], 10) * 1024;
    return { swapTotalBytes: total, swapUsedBytes: total - free };
  } catch {
    return { swapTotalBytes: null, swapUsedBytes: null };
  }
}

function readVmSwappiness() {
  try {
    return parseInt(fs.readFileSync('/proc/sys/vm/swappiness', 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function readThermalMonitor() {
  try {
    const pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
    for (const pid of pids) {
      try {
        if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(THERMAL_SCRIPT)) return true;
      } catch {
        // pid can vanish mid-scan, that's normal
      }
    }
    return false;
  } catch {
    return null;
  }
}

function readActual() {
  const gpu = readGpuActual();
  const swap = readSwapActual();
  return {
    gpuPersistenceMode: gpu.gpuPersistenceMode,
    gpuClockCurrentMhz: gpu.gpuClockCurrentMhz,
    gpuClockApplicationsMhz: gpu.gpuClockApplicationsMhz,
    gpuClockMaxMhz: gpu.gpuClockMaxMhz,
    gpuTemperatureCelsius: gpu.gpuTemperatureCelsius,
    gpuPowerDrawWatts: gpu.gpuPowerDrawWatts,
    swapTotalBytes: swap.swapTotalBytes,
    swapUsedBytes: swap.swapUsedBytes,
    vmSwappiness: readVmSwappiness(),
    thermalMonitor: readThermalMonitor(),
  };
}

const KEYS = ['gpuClockLimitMhz', 'gpuPersistenceMode', 'swapDisabled', 'vmSwappiness', 'thermalMonitor'];

function computeKeyStatus(key, desired, actual, lastApply) {
  const action = (lastApply.actions || {})[key];
  if (action && (action.state === 'failed' || action.state === 'skipped')) {
    return { state: action.state, message: action.detail || '' };
  }
  const n = desired[key];
  if (key === 'gpuPersistenceMode' || key === 'thermalMonitor' || key === 'vmSwappiness') {
    return actual[key] === n
      ? { state: 'ok', message: '' }
      : { state: 'diverged', message: `Host reports ${actual[key]}, desired ${n}` };
  }
  if (key === 'swapDisabled') {
    const isDisabled = actual.swapTotalBytes === 0;
    return (n === true) === isDisabled
      ? { state: 'ok', message: '' }
      : { state: 'diverged', message: `Host reports ${actual.swapTotalBytes} bytes swap, desired disabled=${n}` };
  }
  // gpuClockLimitMhz
  if (n === null) return { state: 'ok', message: '' };
  if (actual.gpuClockCurrentMhz === null) return { state: 'unverified', message: 'GPU idle, cap not observable' };
  if (actual.gpuClockCurrentMhz > n + 15) {
    return { state: 'diverged', message: 'GPU running above the requested cap — this firmware likely ignores -lgc' };
  }
  if (actual.gpuClockCurrentMhz < n - 50) {
    return { state: 'unverified', message: 'GPU idle, cap not observable' };
  }
  return { state: 'ok', message: '' };
}

function computeStatus(desired, actual, lastApply) {
  const status = {};
  for (const key of KEYS) {
    if (!lastApply) {
      status[key] = { state: 'pending', message: 'Pipeline not installed' };
    } else if (lastApply.stateUpdatedAt !== desired.updatedAt) {
      status[key] = { state: 'pending', message: 'Change not applied yet' };
    } else {
      status[key] = computeKeyStatus(key, desired, actual, lastApply);
    }
  }
  return status;
}

async function getEnvAdvice() {
  let envs = [];
  try {
    const containers = await docker.listContainers(); // default: running only
    const inspects = await Promise.all(containers.map((c) => docker.getContainer(c.Id).inspect()));
    envs = inspects.map((i) => ({ name: i.Name.replace(/^\//, ''), env: i.Config.Env || [] }));
  } catch {
    envs = [];
  }
  const recommended = RECOMMENDED_ENV.map(({ name, expected }) => ({
    name,
    expected,
    containers: envs.filter((c) => c.env.includes(`${name}=${expected}`)).map((c) => c.name),
  }));
  const banned = BANNED_ENV.map((name) => ({
    name,
    containers: envs.filter((c) => c.env.some((e) => e.startsWith(`${name}=`))).map((c) => c.name),
  }));
  return { recommended, banned };
}

async function buildFullState(desired) {
  const actual = readActual();
  const lastApply = readLastApply();
  return {
    desired,
    actual,
    status: computeStatus(desired, actual, lastApply),
    lastApply,
    pipelineInstalled: lastApply !== null,
    envAdvice: await getEnvAdvice(),
  };
}

router.get('/state', async (req, res) => {
  res.json(await buildFullState(readDesired()));
});

router.put('/state', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  for (const key of Object.keys(body)) {
    if (!BOUNDS[key]) return res.status(400).json({ error: `Unknown field: ${key}` });
    if (!BOUNDS[key](body[key])) return res.status(400).json({ error: `Invalid value for ${key}` });
  }
  if (body.swapDisabled === true) {
    const swap = readSwapActual();
    const threshold = 512 * 1024 * 1024;
    if (swap.swapUsedBytes !== null && swap.swapUsedBytes > threshold) {
      const usedGiB = (swap.swapUsedBytes / 1024 ** 3).toFixed(1);
      return res.status(409).json({
        error: `Swap in use: ${usedGiB} GiB > 512 MiB threshold; disabling swap now risks an OOM kill`,
      });
    }
  }
  const desired = { ...readDesired(), ...body, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(desired, null, 2));
  res.json(await buildFullState(desired));
});

router.post('/reapply', async (req, res) => {
  const desired = { ...readDesired(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(desired, null, 2));
  res.json(await buildFullState(desired));
});

module.exports = router;
