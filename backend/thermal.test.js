// node --test backend/thermal.test.js
// Builds a fake /sys with the layout seen on a Dell Pro Max with GB10 under BIOS 5.0
// (two PNP0C0B fans, ACPI thermal zones, ESRT entries) and checks the read-only view.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readThermal, acpiName, hex32 } = require('./thermal');

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${content}\n`);
}

function fakeSys({ withEsrt = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thermal-test-'));
  [['00', 'FAN0', 2027], ['01', 'FAN1', 2055]].forEach(([i, name, rpm]) => {
    const dev = `bus/platform/devices/PNP0C0B:${i}`;
    write(root, `${dev}/firmware_node/path`, `\\_SB_.${name}`);
    write(root, `${dev}/hwmon/hwmon${i}/fan1_input`, rpm);
    write(root, `${dev}/thermal_cooling/cur_state`, 0);
    write(root, `${dev}/thermal_cooling/max_state`, 100);
  });
  write(root, 'bus/platform/devices/OTHER:00/uevent', ''); // not a fan, must be ignored
  // zone10 sorts after zone2 numerically, not lexically
  [['0', 'TSOC', 38700], ['2', 'TGPU', 41200], ['10', 'TXYZ', 30000]].forEach(([i, name, t]) => {
    const z = `class/thermal/thermal_zone${i}`;
    write(root, `${z}/type`, 'acpitz');
    write(root, `${z}/temp`, t);
    write(root, `${z}/device/path`, `\\_TZ_.${name}`);
    write(root, `${z}/trip_point_0_type`, 'critical');
    write(root, `${z}/trip_point_0_temp`, 104800);
  });
  write(root, 'class/thermal/cooling_device0/type', 'Fan'); // not a zone
  write(root, 'class/dmi/id/bios_version', '5.36_5.0.0');
  write(root, 'class/dmi/id/bios_date', '10/28/2026');
  if (withEsrt) {
    write(root, 'firmware/efi/esrt/entries/entry0/fw_class', 'c8a8158c-76de-4129-a08d-d31bbea42c36');
    write(root, 'firmware/efi/esrt/entries/entry0/fw_version', 327680);
    write(root, 'firmware/efi/esrt/entries/entry1/fw_class', '78C7F535-9B96-43C8-8E4C-84415507151C');
    write(root, 'firmware/efi/esrt/entries/entry1/fw_version', 33557760);
  }
  return root;
}

test('reads both ACPI fans with RPM and level', () => {
  assert.deepStrictEqual(readThermal(fakeSys()).fans, [
    { id: 'PNP0C0B:00', name: 'FAN0', rpm: 2027, level: 0, maxLevel: 100 },
    { id: 'PNP0C0B:01', name: 'FAN1', rpm: 2055, level: 0, maxLevel: 100 },
  ]);
});

test('reads zones in numeric order, labelled, in °C with the critical trip', () => {
  const zones = readThermal(fakeSys()).zones;
  assert.deepStrictEqual(zones.map((z) => z.id), ['thermal_zone0', 'thermal_zone2', 'thermal_zone10']);
  assert.deepStrictEqual(zones[1], { id: 'thermal_zone2', name: 'TGPU', label: 'GPU', tempC: 41.2, criticalC: 104.8 });
  assert.strictEqual(zones[2].label, 'TXYZ'); // unknown zone keeps its ACPI name
});

test('reads BIOS from DMI and EC / UEFI versions from ESRT', () => {
  assert.deepStrictEqual(readThermal(fakeSys()).firmware, {
    biosVersion: '5.36_5.0.0',
    biosDate: '10/28/2026',
    uefiCapsuleVersion: '0x00050000',
    ecVersion: '0x02000d00',
  });
});

test('ESRT unreadable -> versions null, nothing throws', () => {
  const fw = readThermal(fakeSys({ withEsrt: false })).firmware;
  assert.strictEqual(fw.ecVersion, null);
  assert.strictEqual(fw.biosVersion, '5.36_5.0.0');
});

test('missing /sys -> empty view', () => {
  const t = readThermal('/nonexistent-sys');
  assert.deepStrictEqual(t.fans, []);
  assert.deepStrictEqual(t.zones, []);
});

test('helpers', () => {
  assert.strictEqual(acpiName('\\_SB_.FAN0'), 'FAN0');
  assert.strictEqual(acpiName(null), null);
  assert.strictEqual(hex32(33557760), '0x02000d00');
});
