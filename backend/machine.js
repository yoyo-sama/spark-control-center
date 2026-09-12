// Machine identity: DMI (vendor/model/serials), DGX platform release file,
// GPU chip via nvidia-smi, and host network interfaces/addresses (via the
// /host/sys bind mount + /proc/1/net, since the container has its own netns).
// Every source is read defensively: a missing/unreadable source yields
// null/[] and a false flag in `sources`, never a thrown error.
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const router = express.Router();

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function normalizeSpace(s) {
  if (s == null) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

// --- DMI (vendor/model/serials) ---
const DMI_FIELDS = ['sys_vendor', 'product_name', 'board_vendor', 'chassis_vendor', 'bios_version', 'bios_vendor', 'product_serial', 'board_serial'];

function readDmi(dmiDir) {
  const raw = {};
  let ok = false;
  for (const f of DMI_FIELDS) {
    const content = readFileSafe(path.join(dmiDir, f));
    if (content !== null) ok = true;
    raw[f] = normalizeSpace(content);
  }
  return { raw, ok };
}

// --- /etc/dgx-release (KEY="VALUE" lines) ---
function readDgxRelease(filePath) {
  const content = readFileSafe(filePath);
  if (content === null) return { ok: false, fields: {} };
  const fields = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_]+)="(.*)"$/);
    if (m) fields[m[1]] = normalizeSpace(m[2]);
  }
  return { ok: true, fields };
}

// --- GPU chip via nvidia-smi ---
function getGpus() {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=index,name,uuid,serial,vbios_version,memory.total --format=csv,noheader,nounits'
    ).toString().trim();
    if (!out) return { ok: false, gpus: [] };
    const gpus = out.split('\n').map((line) => {
      const [index, name, uuid, serial, vbios, memTotal] = line.split(',').map((s) => s.trim());
      const mem = parseFloat(memTotal);
      return {
        index: parseInt(index, 10),
        name: name || null,
        uuid: uuid || null,
        serial: (!serial || serial === '[N/A]') ? null : serial,
        vbios: vbios || null,
        memoryTotalMb: Number.isFinite(mem) ? mem : null,
      };
    });
    return { ok: true, gpus };
  } catch {
    return { ok: false, gpus: [] };
  }
}

function chipNameFromGpu(gpus) {
  const name = gpus[0]?.name;
  if (!name) return null;
  return name.match(/NVIDIA\s+(.+)/i)?.[1]?.trim() || null;
}

// --- OS ---
function getOsInfo() {
  let arch = null;
  try {
    arch = execSync('uname -m').toString().trim();
  } catch {
    arch = null;
  }
  // /etc/os-release inside the container is the IMAGE's distro (Debian), not the
  // machine's (Ubuntu here). The host copy is bind-mounted; the fallback keeps
  // host-side runs working. The kernel needs no such care: it is shared.
  let distro = null;
  const rel =
    readFileSafe(process.env.HOST_OS_RELEASE || '/host/etc/os-release') ||
    readFileSafe('/etc/os-release');
  if (rel) distro = rel.match(/^PRETTY_NAME="(.*)"$/m)?.[1] || null;
  return { arch, kernel: os.release() || null, distro };
}

// --- Network: host interfaces (excluding virtual ones) + address cross-reference ---
const EXCLUDED_IFACE = (name) => name === 'lo' || name.startsWith('veth') || name.startsWith('br-') || name.startsWith('docker');

function hexToInt(hex) {
  if (!hex || hex.length !== 8) return null;
  const bytes = hex.match(/../g).reverse();
  return parseInt(bytes.join(''), 16) >>> 0;
}

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] * 16777216) + (p[1] * 65536) + (p[2] * 256) + p[3]) >>> 0;
}

// Local (host-owned) addresses from /proc/1/net/fib_trie: a bare "|-- <ip>"
// line immediately followed by a "host LOCAL" line. Loopback excluded.
function parseFibLocalAddresses(content) {
  const lines = content.split('\n');
  const addrs = new Set();
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/\|--\s+([\d.]+)\s*$/);
    if (m && /host LOCAL/.test(lines[i + 1]) && !m[1].startsWith('127.')) {
      addrs.add(m[1]);
    }
  }
  return [...addrs];
}

// Directly-connected subnets (Gateway 0.0.0.0, real mask) per iface, and the
// default-route iface, from /proc/1/net/route.
function parseRoute(content) {
  const subnets = [];
  let defaultIface = null;
  for (const line of content.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const [iface, destHex, gwHex, , , , , maskHex] = cols;
    if (defaultIface === null && destHex === '00000000' && maskHex === '00000000') {
      defaultIface = iface;
    }
    if (gwHex === '00000000' && maskHex !== '00000000') {
      const mask = hexToInt(maskHex);
      const network = hexToInt(destHex) & mask;
      subnets.push({ iface, network, mask });
    }
  }
  return { subnets, defaultIface };
}

function getNetworkInfo(hostSys, hostProcNet) {
  const hostSysUsed = fs.existsSync(hostSys);
  const netDir = path.join(hostSysUsed ? hostSys : '/sys', 'class', 'net');

  let names = [];
  try {
    names = fs.readdirSync(netDir);
  } catch {
    names = [];
  }

  const interfaces = names.filter((n) => !EXCLUDED_IFACE(n)).map((name) => ({
    name,
    mac: normalizeSpace(readFileSafe(path.join(netDir, name, 'address'))),
    state: normalizeSpace(readFileSafe(path.join(netDir, name, 'operstate'))),
    addresses: [],
    isDefault: false,
  }));

  const routeContent = readFileSafe(path.join(hostProcNet, 'route'));
  const fibContent = readFileSafe(path.join(hostProcNet, 'fib_trie'));
  const { subnets, defaultIface } = routeContent ? parseRoute(routeContent) : { subnets: [], defaultIface: null };

  const defaultEntry = defaultIface && interfaces.find((i) => i.name === defaultIface);
  if (defaultEntry) defaultEntry.isDefault = true;

  if (fibContent) {
    const unmatched = [];
    for (const addr of parseFibLocalAddresses(fibContent)) {
      const addrInt = ipToInt(addr);
      const hit = subnets.find((s) => (addrInt & s.mask) === s.network);
      if (hit) {
        // Reliably attached: attach to the owning iface if we kept it
        // (a hit on an excluded virtual iface, e.g. docker0/br-*, is
        // correctly dropped here rather than leaking onto a real one).
        const iface = interfaces.find((i) => i.name === hit.iface);
        if (iface && !iface.addresses.includes(addr)) iface.addresses.push(addr);
      } else {
        // Can't reliably attach it to any known subnet: don't guess.
        unmatched.push(addr);
      }
    }
    if (defaultEntry) {
      for (const addr of unmatched) if (!defaultEntry.addresses.includes(addr)) defaultEntry.addresses.push(addr);
    }
  }

  return { defaultInterface: defaultIface, interfaces, hostSysUsed };
}

function getMachineInfo(opts = {}) {
  const dmiDir = opts.dmiDir || process.env.DMI_DIR || '/sys/class/dmi/id';
  const dgxReleaseFile = opts.dgxReleaseFile || process.env.DGX_RELEASE_FILE || '/etc/dgx-release';
  const hostSys = opts.hostSys || process.env.HOST_SYS || '/host/sys';
  const hostProcNet = opts.hostProcNet || process.env.HOST_PROC_NET || '/proc/1/net';

  const dmi = readDmi(dmiDir);
  const dgx = readDgxRelease(dgxReleaseFile);
  const gpuInfo = getGpus();
  const net = getNetworkInfo(hostSys, hostProcNet);

  return {
    vendor: dmi.raw.sys_vendor,
    model: dmi.raw.product_name,
    boardVendor: dmi.raw.board_vendor,
    chassisVendor: dmi.raw.chassis_vendor,
    bios: { vendor: dmi.raw.bios_vendor, version: dmi.raw.bios_version },
    serials: {
      product: dmi.raw.product_serial,
      board: dmi.raw.board_serial,
      dgx: dgx.ok ? (dgx.fields.DGX_SERIAL_NUMBER ?? null) : null,
    },
    platform: dgx.ok ? {
      name: dgx.fields.DGX_NAME ?? null,
      prettyName: dgx.fields.DGX_PRETTY_NAME ?? null,
      swBuild: dgx.fields.DGX_SWBUILD_VERSION ?? null,
      otaVersion: dgx.fields.DGX_OTA_VERSION ?? null,
      otaDate: dgx.fields.DGX_OTA_DATE ?? null,
      commit: dgx.fields.DGX_COMMIT_ID ?? null,
      platform: dgx.fields.DGX_PLATFORM ?? null,
    } : null,
    chip: { name: chipNameFromGpu(gpuInfo.gpus), gpus: gpuInfo.gpus },
    os: getOsInfo(),
    network: {
      defaultInterface: net.defaultInterface,
      interfaces: net.interfaces.map(({ name, mac, state, addresses, isDefault }) => ({ name, mac, state, addresses, isDefault })),
    },
    sources: {
      dmi: dmi.ok,
      dgxRelease: dgx.ok,
      hostSys: net.hostSysUsed,
      gpu: gpuInfo.ok,
    },
  };
}

router.get('/', (req, res) => {
  try {
    res.json(getMachineInfo());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, getMachineInfo };
