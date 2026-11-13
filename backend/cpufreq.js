// Reads the big-core (Cortex-X925) cpufreq state for the CPU clock cap. Applying the
// cap is apply.py's job on the host; this only reads the host's /sys, bind-mounted
// read-only at /host/sys. Big cores are found the same way apply.py finds them:
// cpuinfo_max_freq above the A725 maximum (2808 MHz), so cpu5-9 and cpu15-19 on a GB10.
const fs = require('fs');
const path = require('path');

const CPU_FLOOR_MHZ = 2808;

function readKhz(file) {
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function toMhz(khz) {
  return khz === null ? null : Math.round(khz / 1000);
}

// [5, 6, 7, 8, 9, 15] -> "5-9,15"
function cpuList(cpus) {
  const out = [];
  for (let i = 0; i < cpus.length; ) {
    let j = i;
    while (j + 1 < cpus.length && cpus[j + 1] === cpus[j] + 1) j++;
    out.push(i === j ? `${cpus[i]}` : `${cpus[i]}-${cpus[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

function readBigCores(sysRoot = process.env.HOST_SYS || '/host/sys') {
  const root = path.join(sysRoot, 'devices/system/cpu');
  let names = [];
  try {
    names = fs.readdirSync(root).filter((n) => /^cpu\d+$/.test(n));
  } catch {
    return [];
  }
  const cores = [];
  for (const name of names) {
    const dir = path.join(root, name, 'cpufreq');
    const hwMax = readKhz(path.join(dir, 'cpuinfo_max_freq'));
    if (hwMax === null || hwMax <= CPU_FLOOR_MHZ * 1000) continue;
    cores.push({
      cpu: parseInt(name.slice(3), 10),
      hwMaxMhz: toMhz(hwMax),
      maxMhz: toMhz(readKhz(path.join(dir, 'scaling_max_freq'))),
      curMhz: toMhz(readKhz(path.join(dir, 'scaling_cur_freq'))),
    });
  }
  return cores.sort((a, b) => a.cpu - b.cpu);
}

function maxOf(cores, field) {
  const vals = cores.map((c) => c[field]).filter((v) => v !== null);
  return vals.length ? Math.max(...vals) : null;
}

// Fields merged into gb10's `actual`.
function summarize(cores) {
  return {
    cpuBigCores: cores.length ? cpuList(cores.map((c) => c.cpu)) : null,
    cpuBigCoreMaxMhz: maxOf(cores, 'maxMhz'),
    cpuBigCoreCurrentMhz: maxOf(cores, 'curMhz'),
    cpuBigCoreHwMaxMhz: maxOf(cores, 'hwMaxMhz'),
  };
}

// Reads back scaling_max_freq (and scaling_cur_freq) per core, so a cap that
// nv-cpu-governor rewrote after apply.py shows as diverged rather than ok.
function capStatus(desiredMhz, cores) {
  if (!cores.length) return { state: 'unverified', message: 'cpufreq not readable, cap not observable' };
  for (const c of cores) {
    const target = desiredMhz === null ? c.hwMaxMhz : Math.min(desiredMhz, c.hwMaxMhz);
    if (c.maxMhz === null) return { state: 'unverified', message: `cpu${c.cpu}: scaling_max_freq not readable` };
    if (desiredMhz === null && c.maxMhz < target - 1) {
      return { state: 'diverged', message: `cpu${c.cpu} still capped at ${c.maxMhz} MHz` };
    }
    if (c.maxMhz > target + 1) {
      return {
        state: 'diverged',
        message: `cpu${c.cpu} max is ${c.maxMhz} MHz, above the cap — likely rewritten by nv-cpu-governor, re-apply`,
      };
    }
    if (c.curMhz !== null && c.curMhz > target + 50) {
      return { state: 'diverged', message: `cpu${c.cpu} running at ${c.curMhz} MHz, above the cap` };
    }
  }
  return { state: 'ok', message: '' };
}

module.exports = { CPU_FLOOR_MHZ, readBigCores, summarize, capStatus, cpuList };
