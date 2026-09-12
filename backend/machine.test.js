// node --test backend/machine.test.js
// Builds a fake DMI/dgx-release/sys/proc tree under a tmpdir and drives
// getMachineInfo() with path overrides so nothing on the real host is read.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getMachineInfo } = require('./machine');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-test-'));

const DMI_DIR = path.join(ROOT, 'dmi');
const DGX_FILE = path.join(ROOT, 'dgx-release');
const SYS_DIR = path.join(ROOT, 'host-sys');
const PROC_NET_DIR = path.join(ROOT, 'proc-net');

fs.mkdirSync(DMI_DIR, { recursive: true });
fs.writeFileSync(path.join(DMI_DIR, 'sys_vendor'), 'Dell  Inc.\n');
fs.writeFileSync(path.join(DMI_DIR, 'product_name'), 'Dell Pro Max with GB10 FCM1253\n');
fs.writeFileSync(path.join(DMI_DIR, 'board_vendor'), 'Dell Inc.\n');
fs.writeFileSync(path.join(DMI_DIR, 'chassis_vendor'), 'Dell Inc.\n');
fs.writeFileSync(path.join(DMI_DIR, 'bios_version'), '5.36_4.0.0\n');
fs.writeFileSync(path.join(DMI_DIR, 'bios_vendor'), 'Dell Inc.\n');
fs.writeFileSync(path.join(DMI_DIR, 'product_serial'), '   \n'); // blank -> null
fs.writeFileSync(path.join(DMI_DIR, 'board_serial'), '/7B197F4/TWCMT005AV01F8/\n');

fs.writeFileSync(DGX_FILE, [
  'DGX_NAME="DGX Spark"',
  'DGX_PRETTY_NAME="NVIDIA DGX Spark"',
  'DGX_SWBUILD_VERSION="7.2.3"',
  'DGX_COMMIT_ID="03dc741"',
  'DGX_PLATFORM="Dell Pro Max with GB10 FCM1253"',
  'DGX_SERIAL_NUMBER=" "',
  'DGX_OTA_VERSION="7.5.0"',
  'DGX_OTA_DATE="Tue Jun  2 13:30:32 CEST 2026"',
  '',
].join('\n'));

// Two host interfaces: eth0 (physical, kept) and veth1234 (virtual, excluded).
for (const [name, mac, state] of [['eth0', 'aa:bb:cc:dd:ee:ff', 'up'], ['veth1234', '11:22:33:44:55:66', 'up']]) {
  const dir = path.join(SYS_DIR, 'class', 'net', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'address'), `${mac}\n`);
  fs.writeFileSync(path.join(dir, 'operstate'), `${state}\n`);
}

fs.mkdirSync(PROC_NET_DIR, { recursive: true });
// route: eth0 default + eth0's own /24, plus docker0's /16 (never listed as
// an interface, but must still "claim" 172.17.0.1 so it isn't dumped on eth0).
fs.writeFileSync(path.join(PROC_NET_DIR, 'route'), [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'eth0\t0000000A\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  '',
].join('\n'));
fs.writeFileSync(path.join(PROC_NET_DIR, 'fib_trie'), [
  '              |-- 10.0.0.5',
  '                 /32 host LOCAL',
  '              |-- 172.17.0.1',
  '                 /32 host LOCAL',
  '              |-- 127.0.0.1',
  '                 /32 host LOCAL',
  '',
].join('\n'));

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('normalizes multi-space DMI fields and trims', () => {
  const info = getMachineInfo({ dmiDir: DMI_DIR, dgxReleaseFile: DGX_FILE, hostSys: SYS_DIR, hostProcNet: PROC_NET_DIR });
  assert.strictEqual(info.vendor, 'Dell Inc.');
  assert.strictEqual(info.model, 'Dell Pro Max with GB10 FCM1253');
  assert.strictEqual(info.bios.version, '5.36_4.0.0');
});

test('blank serial (spaces only) becomes null, real serial passes through', () => {
  const info = getMachineInfo({ dmiDir: DMI_DIR, dgxReleaseFile: DGX_FILE, hostSys: SYS_DIR, hostProcNet: PROC_NET_DIR });
  assert.strictEqual(info.serials.product, null);
  assert.strictEqual(info.serials.board, '/7B197F4/TWCMT005AV01F8/');
  assert.strictEqual(info.serials.dgx, null); // "DGX_SERIAL_NUMBER=\" \"" -> blank -> null
  assert.strictEqual(info.sources.dmi, true);
});

test('excludes virtual interfaces (veth), keeps physical ones with their MAC/state', () => {
  const info = getMachineInfo({ dmiDir: DMI_DIR, dgxReleaseFile: DGX_FILE, hostSys: SYS_DIR, hostProcNet: PROC_NET_DIR });
  const names = info.network.interfaces.map((i) => i.name);
  assert.ok(!names.includes('veth1234'), 'veth1234 should be excluded');
  assert.deepStrictEqual(names, ['eth0']);
  const eth0 = info.network.interfaces[0];
  assert.strictEqual(eth0.mac, 'aa:bb:cc:dd:ee:ff');
  assert.strictEqual(eth0.state, 'up');
  assert.strictEqual(eth0.isDefault, true);
  assert.strictEqual(info.network.defaultInterface, 'eth0');
  assert.ok(info.sources.hostSys, 'hostSys should be true when the fake host-sys dir exists');
});

test('cross-references fib_trie addresses via route subnets: eth0 gets its own address, docker/loopback do not leak onto it', () => {
  const info = getMachineInfo({ dmiDir: DMI_DIR, dgxReleaseFile: DGX_FILE, hostSys: SYS_DIR, hostProcNet: PROC_NET_DIR });
  const eth0 = info.network.interfaces.find((i) => i.name === 'eth0');
  assert.deepStrictEqual(eth0.addresses, ['10.0.0.5']);
  assert.ok(!eth0.addresses.includes('172.17.0.1'), 'docker0-subnet address must not leak onto eth0');
  assert.ok(!eth0.addresses.includes('127.0.0.1'), 'loopback must never appear');
});

test('missing /etc/dgx-release falls back cleanly: platform null, sources.dgxRelease false, no throw', () => {
  const missing = path.join(ROOT, 'no-such-dgx-release');
  const info = getMachineInfo({ dmiDir: DMI_DIR, dgxReleaseFile: missing, hostSys: SYS_DIR, hostProcNet: PROC_NET_DIR });
  assert.strictEqual(info.platform, null);
  assert.strictEqual(info.sources.dgxRelease, false);
  assert.strictEqual(info.serials.dgx, null);
});

test('missing DMI dir yields nulls and sources.dmi false, never throws', () => {
  const info = getMachineInfo({ dmiDir: path.join(ROOT, 'no-such-dmi'), dgxReleaseFile: DGX_FILE, hostSys: SYS_DIR, hostProcNet: PROC_NET_DIR });
  assert.strictEqual(info.vendor, null);
  assert.strictEqual(info.model, null);
  assert.strictEqual(info.sources.dmi, false);
});
