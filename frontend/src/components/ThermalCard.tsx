import { useEffect, useState } from 'react';
import { Fan } from 'lucide-react';
import type { ThermalInfo } from '../types';

const API_BASE = '/api';

// Colour a temperature by how close it is to the critical trip (104.8 °C on GB10).
function tempClass(t: number | null, crit: number | null): string {
  if (t == null) return 'text-muted';
  const limit = crit ?? 105;
  if (t >= limit - 15) return 'text-red-600 dark:text-red-400';
  if (t >= limit - 30) return 'text-amber-600 dark:text-amber-400';
  return '';
}

function Field({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-1">
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums text-right">{value}</span>
    </div>
  );
}

// Read-only. Fans are driven by the Embedded Controller; nothing here writes to the host.
export default function ThermalCard() {
  const [info, setInfo] = useState<ThermalInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/gb10/thermal`);
        if (!res.ok) throw new Error('failed to load thermal info');
        setInfo(await res.json());
        setFailed(false);
      } catch {
        setFailed(true);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  // Same rule as UpdatesCard: on failure the card disappears, the rest of the page is unaffected.
  if (failed || !info || (info.fans.length === 0 && info.zones.length === 0)) return null;

  const { fans, zones, firmware } = info;
  const hottest = zones.reduce<number | null>((m, z) => (z.tempC != null && (m == null || z.tempC > m) ? z.tempC : m), null);
  const critical = zones.find((z) => z.criticalC != null)?.criticalC ?? null;

  return (
    <div className="bg-surface border border-line rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
          <Fan size={15} strokeWidth={2} />
          Thermal &amp; fans
        </h2>
        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide bg-hover text-muted">
          Read-only
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-6 gap-y-4">
        <div>
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">Fans</p>
          {fans.length === 0 && <p className="text-sm text-muted">No fan exposed by the firmware</p>}
          {fans.map((f) => (
            <Field
              key={f.id}
              label={f.name}
              value={
                <>
                  {f.rpm != null ? `${f.rpm} rpm` : 'N/A'}
                  {f.level != null && f.level > 0 && (
                    <span className="ml-2 text-[11px] text-muted">OS level {f.level}/{f.maxLevel ?? '?'}</span>
                  )}
                </>
              }
            />
          ))}
        </div>

        <div>
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
            Temperatures{hottest != null && <span className="normal-case tracking-normal"> · max {hottest.toFixed(1)} °C</span>}
          </p>
          {zones.map((z) => (
            <Field
              key={z.id}
              label={<span title={z.name}>{z.label}</span>}
              value={<span className={tempClass(z.tempC, z.criticalC)}>{z.tempC != null ? `${z.tempC.toFixed(1)} °C` : 'N/A'}</span>}
            />
          ))}
        </div>

        <div>
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">Firmware</p>
          <Field label="BIOS" value={firmware.biosVersion ?? 'N/A'} />
          {firmware.biosDate && <Field label="BIOS date" value={firmware.biosDate} />}
          <Field label="Embedded Controller" value={<span className="font-mono text-xs">{firmware.ecVersion ?? 'N/A'}</span>} />
          {critical != null && <Field label="Critical shutdown" value={`${critical.toFixed(1)} °C`} />}
        </div>
      </div>

      <p className="mt-3 pt-3 border-t border-line text-xs text-muted leading-relaxed">
        The Embedded Controller drives both fans on its own from its temperature sensors; the OS only holds a
        critical shutdown trip per zone. Fan control from this page is not available yet: whether the ACPI fan
        level (0–100) is honoured by the EC is still being tested on this firmware.
      </p>
    </div>
  );
}
