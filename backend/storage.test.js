// node --test backend/storage.test.js
// Builds a fake /sys/block + mountinfo with the layout seen on a Dell Pro Max with GB10
// (one Micron 2500 NVMe, EFI + ext4 root) and checks the read-only storage view.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { readStorage, parseMountinfo, pcieLink } = require('./storage');

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${content}\n`);
}

const HOST_MOUNTINFO = [
  '37 2 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro',
  '115 37 259:1 / /boot/efi rw,relatime shared:91 - vfat /dev/nvme0n1p1 rw',
  '200 37 259:2 /home/spark /home/spark rw - ext4 /dev/nvme0n1p2 rw',
  '54 37 7:0 / /snap/bare/5 ro - squashfs /dev/loop0 ro',
].join('\n');

const SELF_MOUNTINFO = [
  '900 800 0:65 / / rw - overlay overlay rw',
  '901 900 259:2 /etc/gb10-tuning /etc/gb10-tuning rw - ext4 /dev/nvme0n1p2 rw',
].join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
  const sys = path.join(root, 'sys');
  const d = 'block/nvme0n1';
  write(sys, `${d}/size`, 4000797360);
  write(sys, `${d}/removable`, 0);
  write(sys, `${d}/queue/rotational`, 0);
  write(sys, `${d}/device/model`, '2500 Micron 2048GB                      ');
  write(sys, `${d}/device/serial`, '25164F8B668D        ');
  write(sys, `${d}/device/firmware_rev`, '25000102');
  write(sys, `${d}/device/transport`, 'pcie');
  write(sys, `${d}/device/hwmon9/temp1_input`, 41850);
  write(sys, `${d}/device/device/current_link_speed`, '16.0 GT/s PCIe');
  write(sys, `${d}/device/device/current_link_width`, 4);
  write(sys, `${d}/device/device/max_link_speed`, '16.0 GT/s PCIe');
  write(sys, `${d}/device/device/max_link_width`, 4);
  // p10 must sort after p2 by partition number
  [['1', '259:1', 1048576], ['2', '259:2', 3999744000], ['10', '259:9', 2048]].forEach(([i, dev, size]) => {
    write(sys, `${d}/nvme0n1p${i}/partition`, i);
    write(sys, `${d}/nvme0n1p${i}/dev`, dev);
    write(sys, `${d}/nvme0n1p${i}/size`, size);
  });
  write(sys, 'block/loop0/size', 8); // never listed
  write(sys, 'block/sda/size', 0); // empty slot: skipped
  write(root, 'host-mountinfo', HOST_MOUNTINFO);
  write(root, 'self-mountinfo', SELF_MOUNTINFO);
  return {
    sysRoot: sys,
    hostMountinfo: path.join(root, 'host-mountinfo'),
    selfMountinfo: path.join(root, 'self-mountinfo'),
    statfs: (p) => {
      if (p !== '/etc/gb10-tuning') throw new Error('ENOENT');
      return { bsize: 4096, blocks: 491839228, bfree: 334376581, bavail: 309374085 };
    },
  };
}

test('describes the NVMe disk: model, technology, PCIe link, capacity, temperature', () => {
  const { disks } = readStorage(fixture());
  assert.strictEqual(disks.length, 1);
  const d = disks[0];
  assert.strictEqual(d.name, 'nvme0n1');
  assert.strictEqual(d.model, '2500 Micron 2048GB');
  assert.strictEqual(d.serial, '25164F8B668D');
  assert.strictEqual(d.firmware, '25000102');
  assert.strictEqual(d.technology, 'NVMe SSD');
  assert.strictEqual(d.interface, 'PCIe Gen4 x4');
  assert.strictEqual(d.sizeBytes, 4000797360 * 512);
  assert.strictEqual(d.tempC, 41.9);
  assert.strictEqual(d.removable, false);
});

test('maps partitions to host mount points and reads free space through a bind mount', () => {
  const d = readStorage(fixture()).disks[0];
  assert.deepStrictEqual(d.partitions.map((p) => p.name), ['nvme0n1p1', 'nvme0n1p2', 'nvme0n1p10']);
  const [efi, root, extra] = d.partitions;
  assert.strictEqual(efi.mountPoint, '/boot/efi');
  assert.strictEqual(efi.fsType, 'vfat');
  assert.strictEqual(efi.freeBytes, null); // no bind mount of that filesystem in the container
  assert.strictEqual(root.mountPoint, '/'); // shortest mount point, not /home/spark
  assert.strictEqual(root.fsType, 'ext4');
  assert.strictEqual(root.totalBytes, 491839228 * 4096);
  assert.strictEqual(root.usedBytes, (491839228 - 334376581) * 4096);
  assert.strictEqual(root.freeBytes, 309374085 * 4096);
  assert.strictEqual(extra.mountPoint, null);
  assert.strictEqual(d.freeBytes, 309374085 * 4096);
});

test('missing sources degrade to an empty list, never throw', () => {
  assert.deepStrictEqual(
    readStorage({ sysRoot: '/nonexistent', hostMountinfo: '/nonexistent', selfMountinfo: '/nonexistent' }),
    { disks: [] },
  );
});

test('parseMountinfo unescapes octal sequences in mount points', () => {
  const [m] = parseMountinfo('1 2 8:1 / /mnt/my\\040disk rw - ext4 /dev/sda1 rw');
  assert.deepStrictEqual(m, { dev: '8:1', mountPoint: '/mnt/my disk', fsType: 'ext4', source: '/dev/sda1' });
});

test('pcieLink names the generation from the link speed', () => {
  assert.strictEqual(pcieLink('16.0 GT/s PCIe', '4'), 'PCIe Gen4 x4');
  assert.strictEqual(pcieLink('8.0 GT/s PCIe', '2'), 'PCIe Gen3 x2');
  assert.strictEqual(pcieLink('32.0 GT/s PCIe', null), 'PCIe Gen5');
  assert.strictEqual(pcieLink(null, '4'), null);
});
