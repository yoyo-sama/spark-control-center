// Read-only storage view: physical disks (model, technology, interface, capacity,
// temperature) and their partitions (host mount point, filesystem, free space).
//
// Sources, all readable without root on the host:
// - /host/sys/block/<disk>        model, serial, firmware, size, rotational, PCIe link, hwmon
// - /proc/1/mountinfo             the HOST's mount table (the container runs with pid: host)
// - /proc/self/mountinfo + statfs free space. statfs needs a path on the filesystem; the
//                                 container cannot reach the host's / directly (/proc/1/root
//                                 is EACCES without CAP_SYS_PTRACE), but any bind mount from the
//                                 same partition (e.g. /etc/gb10-tuning) reports the whole
//                                 filesystem. A partition with no such bind keeps null sizes.
const fs = require('fs');
const path = require('path');

// Whole disks worth showing; loop, ram, zram, dm-* and md* are left out.
const DISK_RE = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+|mmcblk\d+)$/;

// PCIe link speed (GT/s) -> generation.
const PCIE_GEN = { '2.5': 1, '5.0': 2, '8.0': 3, '16.0': 4, '32.0': 5, '64.0': 6 };

function read(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ').trim();
    return s.length ? s : null;
  } catch {
    return null;
  }
}

function readInt(file) {
  const s = read(file);
  if (s === null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// mountinfo escapes space, tab, newline and backslash as \ooo octal.
function unescapeMount(s) {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

// -> [{ dev: '259:2', mountPoint: '/', fsType: 'ext4', source: '/dev/nvme0n1p2' }]
function parseMountinfo(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    if (left.length < 5 || right.length < 2) continue;
    out.push({ dev: left[2], mountPoint: unescapeMount(left[4]), fsType: right[0], source: right[1] });
  }
  return out;
}

function readMountinfo(file) {
  try {
    return parseMountinfo(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// "16.0 GT/s PCIe" + "4" -> "PCIe Gen4 x4"
function pcieLink(speed, width) {
  if (!speed) return null;
  const m = speed.match(/^([\d.]+)\s*GT\/s/);
  if (!m) return null;
  const gen = PCIE_GEN[parseFloat(m[1]).toFixed(1)];
  return `PCIe ${gen ? `Gen${gen}` : `${m[1]} GT/s`}${width ? ` x${width}` : ''}`;
}

// First hwmon temperature of the controller ("Composite" on NVMe), in °C.
function readHwmonTemp(deviceDir) {
  for (const h of listDir(deviceDir).filter((n) => /^hwmon\d+$/.test(n))) {
    const t = readInt(path.join(deviceDir, h, 'temp1_input'));
    if (t !== null) return Math.round(t / 100) / 10;
  }
  return null;
}

function describeDisk(blockDir, name) {
  const dev = path.join(blockDir, name);
  const device = path.join(dev, 'device');
  const rotational = read(path.join(dev, 'queue/rotational'));
  const removable = read(path.join(dev, 'removable')) === '1';

  if (name.startsWith('nvme')) {
    // device/ is the controller (nvme0); device/device/ is its PCI function.
    const pci = path.join(device, 'device');
    return {
      model: read(path.join(device, 'model')),
      serial: read(path.join(device, 'serial')),
      firmware: read(path.join(device, 'firmware_rev')),
      technology: 'NVMe SSD',
      interface:
        pcieLink(read(path.join(pci, 'current_link_speed')), read(path.join(pci, 'current_link_width'))) ||
        (read(path.join(device, 'transport')) === 'pcie' ? 'PCIe' : read(path.join(device, 'transport'))),
      maxInterface: pcieLink(read(path.join(pci, 'max_link_speed')), read(path.join(pci, 'max_link_width'))),
      removable,
      tempC: readHwmonTemp(device),
    };
  }

  const real = realpath(device) || '';
  let iface = null;
  if (name.startsWith('mmcblk')) iface = 'MMC / SD';
  else if (real.includes('/usb')) iface = 'USB';
  else if (real.includes('/virtio')) iface = 'virtio';
  else if (/\/ata\d+\//.test(real)) iface = 'SATA';
  else if (real.includes('/host')) iface = 'SCSI / SAS';
  const vendor = read(path.join(device, 'vendor'));
  const model = read(path.join(device, 'model')) || read(path.join(device, 'name'));
  let technology = rotational === '1' ? 'HDD' : rotational === '0' ? 'SSD' : null;
  if (name.startsWith('mmcblk')) technology = 'Flash';
  return {
    model: [vendor && vendor !== 'ATA' ? vendor : null, model].filter(Boolean).join(' ') || null,
    serial: read(path.join(device, 'serial')),
    firmware: read(path.join(device, 'rev')) || read(path.join(device, 'fwrev')),
    technology,
    interface: iface,
    maxInterface: null,
    removable,
    tempC: readHwmonTemp(device),
  };
}

function fsUsage(statfs, mountPoint) {
  try {
    const s = statfs(mountPoint);
    const total = s.blocks * s.bsize;
    return {
      totalBytes: total,
      usedBytes: (s.blocks - s.bfree) * s.bsize,
      // Same as df's "Avail": what a non-root user can still write (reserved blocks excluded).
      freeBytes: s.bavail * s.bsize,
    };
  } catch {
    return null;
  }
}

function readPartitions(blockDir, name, hostMounts, selfMounts, statfs) {
  const dev = path.join(blockDir, name);
  const parts = listDir(dev)
    .filter((n) => n.startsWith(name) && read(path.join(dev, n, 'partition')) !== null)
    .sort((a, b) => readInt(path.join(dev, a, 'partition')) - readInt(path.join(dev, b, 'partition')));
  // A disk without a partition table can carry the filesystem itself.
  const entries = parts.length ? parts.map((p) => [p, path.join(dev, p)]) : [[name, dev]];

  return entries.map(([pname, dir]) => {
    const devId = read(path.join(dir, 'dev'));
    // Shortest host mount point wins: "/" rather than a bind of a subdirectory.
    const host = hostMounts
      .filter((m) => m.dev === devId)
      .sort((a, b) => a.mountPoint.length - b.mountPoint.length)[0];
    let usage = null;
    for (const m of selfMounts.filter((x) => x.dev === devId)) {
      usage = fsUsage(statfs, m.mountPoint);
      if (usage) break;
    }
    const sectors = readInt(path.join(dir, 'size'));
    return {
      name: pname,
      sizeBytes: sectors === null ? null : sectors * 512,
      mountPoint: host ? host.mountPoint : null,
      fsType: host ? host.fsType : null,
      totalBytes: usage ? usage.totalBytes : null,
      usedBytes: usage ? usage.usedBytes : null,
      freeBytes: usage ? usage.freeBytes : null,
    };
  });
}

function readStorage({
  sysRoot = process.env.HOST_SYS || '/host/sys',
  hostMountinfo = '/proc/1/mountinfo',
  selfMountinfo = '/proc/self/mountinfo',
  statfs = fs.statfsSync,
} = {}) {
  const blockDir = path.join(sysRoot, 'block');
  const hostMounts = readMountinfo(hostMountinfo);
  const selfMounts = readMountinfo(selfMountinfo);
  const disks = [];
  for (const name of listDir(blockDir).filter((n) => DISK_RE.test(n)).sort()) {
    const sectors = readInt(path.join(blockDir, name, 'size'));
    if (!sectors) continue; // empty card reader slot, ejected media
    const partitions = readPartitions(blockDir, name, hostMounts, selfMounts, statfs);
    const known = partitions.filter((p) => p.freeBytes !== null);
    disks.push({
      name,
      ...describeDisk(blockDir, name),
      sizeBytes: sectors * 512, // sysfs size is always in 512-byte units
      freeBytes: known.length ? known.reduce((s, p) => s + p.freeBytes, 0) : null,
      partitions,
    });
  }
  return { disks };
}

module.exports = { readStorage, parseMountinfo, pcieLink };
