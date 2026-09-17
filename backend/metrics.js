const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execFileAsync = promisify(execFile);

// Background CPU sampler: /proc stats are cumulative since boot,
// so usage percent must be computed on a delta between two snapshots.
function snapshotCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

let cpuPrevSample = snapshotCpuTimes();
let cpuDeltaPercent = null;

setInterval(() => {
  const cur = snapshotCpuTimes();
  const idleDiff = cur.idle - cpuPrevSample.idle;
  const totalDiff = cur.total - cpuPrevSample.total;
  if (totalDiff > 0) {
    cpuDeltaPercent = ((totalDiff - idleDiff) / totalDiff) * 100;
  }
  cpuPrevSample = cur;
}, 1000).unref();

function getHostMetrics() {
  // Fallback to boot-average until the first sampler tick
  let cpu = null;
  if (cpuDeltaPercent !== null) {
    cpu = cpuDeltaPercent;
  } else {
    const { idle, total } = snapshotCpuTimes();
    cpu = total > 0 ? ((total - idle) / total) * 100 : 0;
  }
  const memTotal = os.totalmem();
  const memFree = os.freemem(); // MemAvailable on Linux (libuv >= 1.45)
  const mem = ((memTotal - memFree) / memTotal) * 100;
  return {
    cpu_percent: cpu,
    memory_total_bytes: memTotal,
    memory_used_bytes: memTotal - memFree,
    memory_percent: mem,
    uptime_seconds: os.uptime(),
  };
}

function getDiskMetrics() {
  try {
    // statfsSync avoids a subprocess entirely; df's own block rounding is the
    // only source of the few-byte difference from `df -B1 /`.
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    return {
      disk_total_bytes: total,
      disk_used_bytes: used,
      disk_percent: (used / total) * 100,
    };
  } catch {
    return { disk_total_bytes: 0, disk_used_bytes: 0, disk_percent: 0 };
  }
}

// nvidia-smi costs ~26 ms a call and /api/system needs two readings, with every open
// tab polling every 5 s. Caching the in-flight promise makes concurrent callers share
// one subprocess and reuses a reading for `ttl` ms. Safe to cache the promise because
// the wrapped readers catch everything and resolve to a fallback, never reject.
function memo(fn, ttl) {
  let promise = null;
  let time = 0;
  return () => {
    if (!promise || Date.now() - time > ttl) {
      time = Date.now();
      promise = fn();
    }
    return promise;
  };
}

async function _getGpuMetrics() {
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits',
    ]);
    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [index, name, util, memUsed, memTotal, temp, power] = line.split(',').map((s) => s.trim());
        return {
          index: parseInt(index),
          name,
          utilization_percent: num(util),
          vram_used_mb: num(memUsed),
          vram_total_mb: num(memTotal),
          temperature_celsius: num(temp),
          power_draw_watts: num(power),
        };
      });
  } catch {
    return [];
  }
}
const getGpuMetrics = memo(_getGpuMetrics, 2000);

async function _getGpuMemoryByContainer() {
  const map = new Map();
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-compute-apps=pid,used_memory',
      '--format=csv,noheader,nounits',
    ]);
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length < 2) continue;
      const pid = parseInt(parts[0], 10);
      const memMiB = parseFloat(parts[1]);
      if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(memMiB)) continue;
      let cgroup;
      try {
        cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
      } catch {
        continue;
      }
      let m = cgroup.match(/docker-([a-f0-9]{64})\.scope/);
      if (!m) m = cgroup.match(/docker[\/\\]([a-f0-9]{64})/);
      if (!m) continue;
      const id = m[1];
      map.set(id, (map.get(id) || 0) + Math.round(memMiB * 1024 * 1024));
    }
  } catch {
    return new Map();
  }
  return map;
}
const getGpuMemoryByContainer = memo(_getGpuMemoryByContainer, 2000);

function getContainerStats(stats, prevSample) {
  const cpuTotal = stats.cpu_stats?.cpu_usage?.total_usage || 0;
  const systemTotal = stats.cpu_stats?.system_cpu_usage || 0;
  const onlineCpus = stats.cpu_stats?.online_cpus || os.cpus().length;

  // Docker formula: (Δcontainer_cpu / Δsystem_cpu) × online CPUs × 100
  let cpuPercent;
  if (prevSample && systemTotal > prevSample.sys && cpuTotal >= prevSample.cpu) {
    const cpuDelta = cpuTotal - prevSample.cpu;
    const sysDelta = systemTotal - prevSample.sys;
    cpuPercent = (cpuDelta / sysDelta) * onlineCpus * 100;
  } else {
    cpuPercent = (cpuTotal / (systemTotal || 1)) * onlineCpus * 100;
  }
  cpuPercent = Math.min(100, Math.max(0, cpuPercent));

  // Active memory: subtract page cache (same convention as docker stats CLI)
  const memUsageRaw = stats.memory_stats?.usage || 0;
  const inactiveFile = stats.memory_stats?.stats?.inactive_file || 0;
  const memUsage = Math.max(0, memUsageRaw - inactiveFile);
  const memLimit = stats.memory_stats?.limit || 1;
  const memPercent = (memUsage / memLimit) * 100;

  const networks = stats.networks || {};
  const netRx = Object.values(networks).reduce((sum, n) => sum + (n.rx_bytes || 0), 0);
  const netTx = Object.values(networks).reduce((sum, n) => sum + (n.tx_bytes || 0), 0);

  const blkio = stats.blkio_stats?.io_service_bytes || [];
  let blockRead = 0;
  let blockWrite = 0;
  for (const entry of blkio) {
    for (const val of entry.values) {
      if (entry.op === 'Read') blockRead += val;
      else if (entry.op === 'Write') blockWrite += val;
    }
  }

  return {
    cpu_percent: cpuPercent,
    memory_usage_bytes: memUsage,
    memory_percent: memPercent,
    network_rx_bytes: netRx,
    network_tx_bytes: netTx,
    block_read_bytes: blockRead,
    block_write_bytes: blockWrite,
  };
}

module.exports = { getHostMetrics, getDiskMetrics, getGpuMetrics, getGpuMemoryByContainer, getContainerStats, memo };
