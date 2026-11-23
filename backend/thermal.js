// Read-only thermal view: ACPI fans (RPM + requested level), ACPI thermal zones and
// the BIOS / Embedded Controller firmware versions. Everything comes from the host's
// /sys, bind-mounted read-only at /host/sys. Nothing here writes: on GB10 the EC drives
// the fans on its own, and the kernel only holds a critical trip per zone.
//
// Exposed since BIOS 5.0 on the Dell Pro Max with GB10: two PNP0C0B fans (\_SB.FAN0/1)
// with an acpi_fan hwmon node (fan1_input) and a "Fan" cooling device (max_state 100).
const fs = require('fs');
const path = require('path');

// ESRT fw_class of the Embedded Controller capsule (as listed by fwupdmgr).
const EC_FW_CLASS = '78c7f535-9b96-43c8-8e4c-84415507151c';
// ESRT fw_class of the system firmware (UEFI) capsule.
const UEFI_FW_CLASS = 'c8a8158c-76de-4129-a08d-d31bbea42c36';

// ACPI zone name -> readable label. TS<n>E / TS<n>P are read as CPU cluster n,
// efficiency (A725) / performance (X925) cores: inferred from the names, not documented.
const ZONE_LABELS = {
  TSOC: 'SoC',
  TGPU: 'GPU',
  TS0E: 'CPU cluster 0 · efficiency',
  TS0P: 'CPU cluster 0 · performance',
  TS1E: 'CPU cluster 1 · efficiency',
  TS1P: 'CPU cluster 1 · performance',
  TUNC: 'Uncore',
};

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
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

// "\_SB_.FAN0" -> "FAN0", "\_TZ_.TGPU" -> "TGPU"
function acpiName(p) {
  if (!p) return null;
  const last = p.split('.').pop();
  return last ? last.replace(/_+$/, '') : null;
}

function milliToC(v) {
  return v === null ? null : Math.round(v / 100) / 10;
}

function readFans(sysRoot) {
  const fans = [];
  const platform = path.join(sysRoot, 'bus/platform/devices');
  for (const dev of listDir(platform).filter((n) => n.startsWith('PNP0C0B:')).sort()) {
    const dir = path.join(platform, dev);
    const hwmon = listDir(path.join(dir, 'hwmon')).find((n) => n.startsWith('hwmon'));
    fans.push({
      id: dev,
      name: acpiName(read(path.join(dir, 'firmware_node/path'))) || dev,
      rpm: hwmon ? readInt(path.join(dir, 'hwmon', hwmon, 'fan1_input')) : null,
      level: readInt(path.join(dir, 'thermal_cooling/cur_state')),
      maxLevel: readInt(path.join(dir, 'thermal_cooling/max_state')),
    });
  }
  return fans;
}

function criticalTrip(zoneDir) {
  for (const f of listDir(zoneDir)) {
    const m = f.match(/^trip_point_(\d+)_type$/);
    if (m && read(path.join(zoneDir, f)) === 'critical') {
      return milliToC(readInt(path.join(zoneDir, `trip_point_${m[1]}_temp`)));
    }
  }
  return null;
}

function readZones(sysRoot) {
  const root = path.join(sysRoot, 'class/thermal');
  const zones = [];
  const names = listDir(root)
    .filter((n) => /^thermal_zone\d+$/.test(n))
    .sort((a, b) => parseInt(a.slice(12), 10) - parseInt(b.slice(12), 10));
  for (const n of names) {
    const dir = path.join(root, n);
    const acpi = acpiName(read(path.join(dir, 'device/path')));
    zones.push({
      id: n,
      name: acpi || read(path.join(dir, 'type')) || n,
      label: (acpi && ZONE_LABELS[acpi]) || acpi || read(path.join(dir, 'type')) || n,
      tempC: milliToC(readInt(path.join(dir, 'temp'))),
      criticalC: criticalTrip(dir),
    });
  }
  return zones;
}

// ESRT entries are root-only (0400); the container runs as root, so this works there
// and degrades to null when run unprivileged.
function readEsrtVersions(sysRoot) {
  const root = path.join(sysRoot, 'firmware/efi/esrt/entries');
  const out = {};
  for (const e of listDir(root)) {
    const cls = read(path.join(root, e, 'fw_class'));
    const ver = readInt(path.join(root, e, 'fw_version'));
    if (cls && ver !== null) out[cls.toLowerCase()] = ver;
  }
  return out;
}

function hex32(v) {
  return v === null || v === undefined ? null : `0x${v.toString(16).padStart(8, '0')}`;
}

function readFirmware(sysRoot) {
  const esrt = readEsrtVersions(sysRoot);
  return {
    biosVersion: read(path.join(sysRoot, 'class/dmi/id/bios_version')),
    biosDate: read(path.join(sysRoot, 'class/dmi/id/bios_date')),
    uefiCapsuleVersion: hex32(esrt[UEFI_FW_CLASS]),
    ecVersion: hex32(esrt[EC_FW_CLASS]),
  };
}

function readThermal(sysRoot = process.env.HOST_SYS || '/host/sys') {
  return {
    fans: readFans(sysRoot),
    zones: readZones(sysRoot),
    firmware: readFirmware(sysRoot),
  };
}

module.exports = { readThermal, acpiName, hex32 };
