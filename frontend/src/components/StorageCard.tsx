import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import type { StorageDisk, StorageInfo } from '../types';

const API_BASE = '/api';

// Decimal units, like the capacity printed on the drive (df -h shows binary units).
function fmtSize(bytes: number | null): string {
  if (bytes == null) return 'N/A';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
}

function usageClass(pct: number): string {
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 75) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function Field({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-1">
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums text-right">{value}</span>
    </div>
  );
}

function Disk({ disk }: { disk: StorageDisk }) {
  const linkDowngraded = disk.maxInterface && disk.interface && disk.maxInterface !== disk.interface;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4">
      <div>
        <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
          Drive <span className="normal-case tracking-normal font-mono">/dev/{disk.name}</span>
        </p>
        <Field label="Model" value={disk.model ?? 'N/A'} />
        <Field
          label="Technology"
          value={
            <>
              {disk.technology ?? 'N/A'}
              {disk.removable && <span className="ml-2 text-[11px] text-muted">removable</span>}
            </>
          }
        />
        <Field
          label="Interface"
          value={
            <span title={linkDowngraded ? `Link capable of ${disk.maxInterface}` : undefined}>
              {disk.interface ?? 'N/A'}
              {linkDowngraded && <span className="ml-2 text-[11px] text-amber-600 dark:text-amber-400">max {disk.maxInterface}</span>}
            </span>
          }
        />
        <Field label="Capacity" value={fmtSize(disk.sizeBytes)} />
        {disk.tempC != null && <Field label="Temperature" value={`${disk.tempC.toFixed(1)} °C`} />}
        {disk.firmware && <Field label="Firmware" value={<span className="font-mono text-xs">{disk.firmware}</span>} />}
        {disk.serial && <Field label="Serial" value={<span className="font-mono text-xs">{disk.serial}</span>} />}
      </div>

      <div>
        <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
          Partitions
          {disk.freeBytes != null && <span className="normal-case tracking-normal"> · {fmtSize(disk.freeBytes)} free</span>}
        </p>
        {disk.partitions.map((p) => {
          const pct = p.totalBytes && p.usedBytes != null ? (p.usedBytes / p.totalBytes) * 100 : null;
          return (
            <div key={p.name} className="py-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">
                  <span className="font-mono text-xs">{p.mountPoint ?? p.name}</span>
                  {p.fsType && <span className="ml-1.5 text-[11px]">{p.fsType}</span>}
                </span>
                <span className="font-medium tabular-nums text-right">
                  {p.freeBytes != null ? (
                    <>
                      {fmtSize(p.freeBytes)} free <span className="text-muted font-normal">/ {fmtSize(p.totalBytes)}</span>
                    </>
                  ) : (
                    <span className="text-muted font-normal">{fmtSize(p.sizeBytes)}</span>
                  )}
                </span>
              </div>
              {pct != null && (
                <div className="mt-1 h-1.5 rounded-full bg-hover overflow-hidden" title={`${pct.toFixed(1)} % used`}>
                  <div className={`h-full ${usageClass(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Read-only. Disks from /sys/block, free space via statfs on a bind mount of each filesystem.
export default function StorageCard() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/gb10/storage`);
        if (!res.ok) throw new Error('failed to load storage info');
        setInfo(await res.json());
        setFailed(false);
      } catch {
        setFailed(true);
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  // Same rule as ThermalCard: on failure the card disappears, the rest of the page is unaffected.
  if (failed || !info || info.disks.length === 0) return null;

  return (
    <div className="bg-surface border border-line rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
          <HardDrive size={15} strokeWidth={2} />
          Storage
        </h2>
        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide bg-hover text-muted">
          Read-only
        </span>
      </div>

      <div className="space-y-5">
        {info.disks.map((d, i) => (
          <div key={d.name} className={i > 0 ? 'pt-4 border-t border-line' : undefined}>
            <Disk disk={d} />
          </div>
        ))}
      </div>

      <p className="mt-3 pt-3 border-t border-line text-xs text-muted leading-relaxed">
        Sizes in decimal units (1 TB = 10¹² bytes), as printed on the drive; <code className="font-mono">df -h</code> shows
        binary units (TiB). Free space is what a regular user can still write, like df&apos;s “Avail”. A partition
        whose filesystem is not mounted into the app (such as the EFI partition) shows its size only.
      </p>
    </div>
  );
}
