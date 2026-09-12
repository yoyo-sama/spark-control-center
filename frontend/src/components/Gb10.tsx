import { useEffect, useState } from 'react';
import { HardDrive, Loader2, RotateCw, Thermometer, Wind, Zap } from 'lucide-react';
import StatCard from './StatCard';
import ConfirmModal from './ConfirmModal';
import type { Gb10Desired, Gb10EnvAdviceItem, Gb10SettingKey, Gb10State, Gb10Status } from '../types';

const API_BASE = '/api';

const STATE_BADGE: Record<Gb10Status['state'], { label: string; className: string }> = {
  ok: { label: 'OK', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  pending: { label: 'Pending', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  failed: { label: 'Failed', className: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  skipped: { label: 'Skipped', className: 'bg-hover text-muted' },
  diverged: { label: 'Diverged', className: 'bg-orange-500/10 text-orange-600 dark:text-orange-400' },
  unverified: { label: 'Unverified', className: 'bg-hover text-muted' },
};

function fmtBytes(bytes: number | null): string {
  if (bytes == null) return 'N/A';
  const gib = bytes / 2 ** 30;
  return gib >= 0.1 ? `${gib.toFixed(1)} GiB` : `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}

function fmtMhz(v: number | null): string {
  return v == null ? 'N/A' : `${v} MHz`;
}

function fmtNum(v: number | null): string {
  return v == null ? 'N/A' : String(v);
}

function fmtBool(v: boolean | null): string {
  return v == null ? 'N/A' : v ? 'On' : 'Off';
}

function Badge({ status }: { status: Gb10Status }) {
  const meta = STATE_BADGE[status.state];
  return (
    <div className="text-right shrink-0">
      <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${meta.className}`}>
        {meta.label}
      </span>
      {status.message && <p className="mt-1 text-[11px] text-muted max-w-[200px]">{status.message}</p>}
    </div>
  );
}

function SettingCard({ title, badge, children }: { title: string; badge: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {badge}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-1">
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/30 disabled:opacity-40 disabled:cursor-not-allowed ${
        checked ? 'bg-accent' : 'bg-hover'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function EnvRow({ item, kind }: { item: Gb10EnvAdviceItem; kind: 'recommended' | 'banned' }) {
  const active = item.containers.length > 0;
  const colorClass = active
    ? kind === 'recommended'
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400'
    : 'text-muted';
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-line last:border-0 text-sm">
      <div className="min-w-0">
        <span className="font-mono text-xs">
          {item.name}
          {item.expected ? `=${item.expected}` : ''}
        </span>
        {item.name === 'CUDA_CACHE_MAXSIZE' && (
          <p className="text-[11px] text-muted mt-0.5">20 s/step to 6.6 s/step (3x)</p>
        )}
        {active && <p className="text-[11px] text-muted mt-0.5 truncate">{item.containers.join(', ')}</p>}
      </div>
      <span className={`text-xs font-medium shrink-0 ${colorClass}`}>
        {active ? (kind === 'recommended' ? 'Set' : 'Detected') : 'not set'}
      </span>
    </div>
  );
}

const buttonClass =
  'px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20';
const inputClass =
  'h-9 px-2.5 rounded-lg border border-line bg-base text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20 disabled:opacity-50 disabled:cursor-not-allowed';

export default function Gb10() {
  const [state, setState] = useState<Gb10State | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reapplying, setReapplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [showSwapConfirm, setShowSwapConfirm] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [clockInput, setClockInput] = useState('2100');
  const [swappinessInput, setSwappinessInput] = useState('10');

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/gb10/state`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load GB10 state');
        setState(data);
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load GB10 state');
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  // ponytail: seed the editable inputs once from the first load only, so the 5s poll
  // never clobbers text the user is mid-typing. Re-synced explicitly after every apply.
  useEffect(() => {
    if (state && !seeded) {
      setClockInput(String(state.desired.gpuClockLimitMhz ?? 2100));
      setSwappinessInput(String(state.desired.vmSwappiness ?? 10));
      setSeeded(true);
    }
  }, [state, seeded]);

  const apply = async (patch: Partial<Pick<Gb10Desired, Gb10SettingKey>>) => {
    setSaving(true);
    setApplyError(null);
    try {
      const res = await fetch(`${API_BASE}/gb10/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setState(data);
      setClockInput(String(data.desired.gpuClockLimitMhz ?? 2100));
      setSwappinessInput(String(data.desired.vmSwappiness ?? 10));
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSaving(false);
    }
  };

  const handleReapply = async () => {
    setReapplying(true);
    try {
      const res = await fetch(`${API_BASE}/gb10/reapply`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reapply failed');
      setState(data);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Reapply failed');
    } finally {
      setReapplying(false);
    }
  };

  if (loading && !state) {
    return (
      <div className="flex-1 flex items-center justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-line border-t-fg"></div>
      </div>
    );
  }

  const disabledAll = !state || !state.pipelineInstalled || saving;

  return (
    <div className="p-6 lg:p-8 overflow-y-auto">
      {loadError && (
        <div className="mb-6 p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
          {loadError}
        </div>
      )}

      {state && (
        <>
          {!state.pipelineInstalled && (
            <div className="mb-6 p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm">
              Host tuning pipeline not installed — settings below are read-only until the systemd units are
              installed (see README).
            </div>
          )}

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold tracking-tight">GPU metrics</h2>
            <button onClick={handleReapply} disabled={reapplying} className={buttonClass}>
              {reapplying ? (
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <RotateCw size={14} strokeWidth={2} />
              )}
              Re-apply
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard
              title="GPU Temperature"
              value={state.actual.gpuTemperatureCelsius ?? 'N/A'}
              unit={state.actual.gpuTemperatureCelsius != null ? '°C' : undefined}
              color="red"
              icon={<Thermometer size={15} strokeWidth={2} />}
            />
            <StatCard
              title="Power Draw"
              value={state.actual.gpuPowerDrawWatts != null ? state.actual.gpuPowerDrawWatts.toFixed(1) : 'N/A'}
              unit={state.actual.gpuPowerDrawWatts != null ? 'W' : undefined}
              color="purple"
              icon={<Zap size={15} strokeWidth={2} />}
            />
            <StatCard
              title="SM Clock"
              value={state.actual.gpuClockCurrentMhz ?? 'N/A'}
              unit={state.actual.gpuClockCurrentMhz != null ? 'MHz' : undefined}
              color="blue"
              icon={<Wind size={15} strokeWidth={2} />}
            />
            <StatCard
              title="Swap used / total"
              value={fmtBytes(state.actual.swapUsedBytes)}
              subtitle={`of ${fmtBytes(state.actual.swapTotalBytes)}`}
              color="yellow"
              icon={<HardDrive size={15} strokeWidth={2} />}
            />
          </div>

          <h2 className="text-sm font-semibold tracking-tight mb-3">Settings</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <SettingCard title="GPU clock cap" badge={<Badge status={state.status.gpuClockLimitMhz} />}>
              <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">Desired</p>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <input
                  type="number"
                  min={300}
                  max={3003}
                  value={clockInput}
                  onChange={(e) => setClockInput(e.target.value)}
                  disabled={disabledAll}
                  className={`w-24 ${inputClass}`}
                />
                <span className="text-xs text-muted">MHz</span>
                <button
                  onClick={() => apply({ gpuClockLimitMhz: Number(clockInput) })}
                  disabled={disabledAll || !Number.isFinite(Number(clockInput))}
                  className={buttonClass}
                >
                  Apply
                </button>
                <button onClick={() => apply({ gpuClockLimitMhz: null })} disabled={disabledAll} className={buttonClass}>
                  Remove cap
                </button>
              </div>
              <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">Actual</p>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <MiniStat label="Current" value={fmtMhz(state.actual.gpuClockCurrentMhz)} />
                <MiniStat label="Applications" value={fmtMhz(state.actual.gpuClockApplicationsMhz)} />
                <MiniStat label="Max" value={fmtMhz(state.actual.gpuClockMaxMhz)} />
              </div>
              <p className="text-xs text-muted leading-relaxed border-t border-line pt-3">
                Root cause: a 14 W → 85 W power spike trips overcurrent protection (not a thermal throttle).
                Measured at 2100 MHz: 85 W → 50 W stable, 72–79°C, no more crashes. At 2200 MHz: −12°C, −36%
                power, costing 1% in decode and 3.9% in prefill. Power Limit: N/A on this GPU — the clock cap is
                the only lever.
              </p>
            </SettingCard>

            <SettingCard title="GPU persistence mode" badge={<Badge status={state.status.gpuPersistenceMode} />}>
              <Row
                label="Desired"
                value={
                  <Toggle
                    checked={state.desired.gpuPersistenceMode}
                    onChange={() => apply({ gpuPersistenceMode: !state.desired.gpuPersistenceMode })}
                    disabled={disabledAll}
                    label="GPU persistence mode"
                  />
                }
              />
              <Row label="Actual" value={fmtBool(state.actual.gpuPersistenceMode)} />
            </SettingCard>

            <SettingCard title="Swap" badge={<Badge status={state.status.swapDisabled} />}>
              <Row
                label="Desired: disable swap"
                value={
                  <Toggle
                    checked={state.desired.swapDisabled}
                    onChange={() => {
                      if (!state.desired.swapDisabled) setShowSwapConfirm(true);
                      else apply({ swapDisabled: false });
                    }}
                    disabled={disabledAll}
                    label="Disable swap"
                  />
                }
              />
              <Row label="Actual swap" value={`${fmtBytes(state.actual.swapUsedBytes)} / ${fmtBytes(state.actual.swapTotalBytes)}`} />
              <div className="mt-3 pt-3 border-t border-line flex items-center gap-2 flex-wrap">
                <label className="text-sm text-muted" htmlFor="vm-swappiness">
                  vm.swappiness
                </label>
                <input
                  id="vm-swappiness"
                  type="number"
                  min={0}
                  max={100}
                  value={swappinessInput}
                  onChange={(e) => setSwappinessInput(e.target.value)}
                  disabled={disabledAll}
                  className={`w-20 ${inputClass}`}
                />
                <button
                  onClick={() => apply({ vmSwappiness: Number(swappinessInput) })}
                  disabled={disabledAll || !Number.isFinite(Number(swappinessInput))}
                  className={buttonClass}
                >
                  Apply
                </button>
                <span className="text-xs text-muted ml-auto">Actual: {fmtNum(state.actual.vmSwappiness)}</span>
                <Badge status={state.status.vmSwappiness} />
              </div>
              {applyError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{applyError}</p>}
            </SettingCard>

            <SettingCard title="Thermal monitoring" badge={<Badge status={state.status.thermalMonitor} />}>
              <Row
                label="Desired"
                value={
                  <Toggle
                    checked={state.desired.thermalMonitor}
                    onChange={() => apply({ thermalMonitor: !state.desired.thermalMonitor })}
                    disabled={disabledAll}
                    label="Thermal monitoring"
                  />
                }
              />
              <Row label="Actual" value={fmtBool(state.actual.thermalMonitor)} />
              <p className="mt-3 pt-3 border-t border-line text-xs text-muted leading-relaxed">
                Controls the existing script at{' '}
                <code className="font-mono">/home/sparks/comfyui-spark/thermal-monitor.sh</code>.
              </p>
            </SettingCard>
          </div>

          <div className="bg-surface border border-line rounded-xl p-4">
            <h2 className="text-sm font-semibold tracking-tight mb-3">Environment variables (informational)</h2>
            <div className="mb-4">
              <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Recommended</p>
              {state.envAdvice.recommended.map((item) => (
                <EnvRow key={item.name} item={item} kind="recommended" />
              ))}
            </div>
            <div>
              <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Banned</p>
              {state.envAdvice.banned.map((item) => (
                <EnvRow key={item.name} item={item} kind="banned" />
              ))}
            </div>
          </div>
        </>
      )}

      {showSwapConfirm && (
        <ConfirmModal
          title="Disable swap?"
          message="This disables swap on the host. If swap is currently in use, the backend will refuse the change."
          confirmLabel="Disable swap"
          onConfirm={() => {
            setShowSwapConfirm(false);
            apply({ swapDisabled: true });
          }}
          onCancel={() => setShowSwapConfirm(false)}
        />
      )}
    </div>
  );
}
