import { useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Gauge,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Users,
} from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import type { BenchParamSpec, BenchParams, BenchRun, BenchTarget, BenchTool, Gb10State } from '../types';
import { CONCURRENCY_PRESETS, WORKLOAD_PRESETS, benchFetch, benchPost, fmt, loadPref, savePref } from '../lib/bench';

const inputClass = 'h-9 px-2.5 rounded-lg border border-line bg-base text-sm w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20';
const labelClass = 'block text-xs font-medium text-muted uppercase tracking-wide mb-1.5';
const cardClass = 'bg-surface border border-line rounded-xl p-5';
// Rendered in their own sections; every other parameter of the tool's schema lands in
// "Advanced", so a future tool's extra knobs appear without UI work.
const CURATED = ['concurrency', 'requestCount', 'benchmarkDurationS', 'isl', 'osl'];

function Section({ n, title, subtitle, action, children }: { n: number; title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={cardClass}>
      <div className="flex items-start gap-3 mb-4">
        <span className="w-6 h-6 rounded-full bg-accent text-accent-fg text-xs font-semibold flex items-center justify-center shrink-0">{n}</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold tracking-tight leading-6">{title}</h3>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Choice({ selected, onClick, children, className = '' }: { selected: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`text-left rounded-xl border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20 ${
        selected ? 'border-fg/60 bg-hover' : 'border-line hover:bg-hover'
      } ${className}`}
    >
      {children}
    </button>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? 'bg-accent' : 'bg-hover border border-line'}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-surface shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function ParamInput({ spec, value, onChange }: { spec: BenchParamSpec; value: BenchParams[string]; onChange: (v: BenchParams[string]) => void }) {
  if (spec.type === 'bool') {
    return (
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm">{spec.label}</p>
          {spec.help && <p className="text-xs text-muted">{spec.help}</p>}
        </div>
        <Toggle checked={Boolean(value)} onChange={onChange} />
      </div>
    );
  }
  return (
    <label className="block">
      <span className={labelClass}>{spec.label}</span>
      {spec.type === 'enum' ? (
        <select className={inputClass} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.choices?.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : (
        <input
          className={inputClass}
          type={spec.type === 'string' ? 'text' : 'number'}
          min={spec.min}
          max={spec.max}
          step={spec.type === 'number' ? 'any' : 1}
          value={value === null || value === undefined ? '' : String(value)}
          placeholder={spec.nullable ? 'off' : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            if (spec.type === 'string') return onChange(raw);
            if (raw === '') return onChange(spec.nullable ? null : spec.default);
            onChange(Number(raw));
          }}
        />
      )}
      {spec.help && <span className="block text-[11px] text-muted mt-1">{spec.help}</span>}
    </label>
  );
}

function parseList(text: string): number[] | null {
  const values = text.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (values.length === 0 || values.some((v) => !Number.isInteger(v) || v < 1 || v > 1024)) return null;
  return [...new Set(values)].sort((a, b) => a - b);
}

function fmtBytes(b: number | null) {
  return b === null ? null : `${(b / 2 ** 30).toFixed(1)} GiB VRAM`;
}

interface Props {
  seed: BenchRun | null;
  onStarted: (id: string) => void;
  onOpenGb10: () => void;
  activeRunId: string | null;
}

export default function BenchNewRun({ seed, onStarted, onOpenGb10, activeRunId }: Props) {
  const [tools, setTools] = useState<BenchTool[] | null>(null);
  const [targets, setTargets] = useState<BenchTarget[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [gb10, setGb10] = useState<Gb10State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [toolId, setToolId] = useState('aiperf');
  const [targetId, setTargetId] = useState<string>(() => loadPref('targetId', ''));
  const [manualUrl, setManualUrl] = useState<string>(() => loadPref('manualUrl', 'http://localhost:8000'));
  const [model, setModel] = useState<string>(() => loadPref('model', ''));
  const [apiKey, setApiKey] = useState('');
  const [params, setParams] = useState<BenchParams>({});
  const [presetId, setPresetId] = useState<string>(() => loadPref('presetId', 'chat'));
  const [concurrency, setConcurrency] = useState<number[]>(() => loadPref('concurrency', [1, 2, 4, 8]));
  const [customLevels, setCustomLevels] = useState<string>('');
  const [cooldownS, setCooldownS] = useState<number>(() => loadPref('cooldownS', 10));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmBuild, setConfirmBuild] = useState(false);

  const tool = tools?.find((t) => t.id === toolId) ?? null;

  const scan = async () => {
    setScanning(true);
    try {
      const { targets } = await benchFetch<{ targets: BenchTarget[] }>('/targets');
      setTargets(targets);
    } catch (err) {
      setTargets([]);
      setLoadError(err instanceof Error ? err.message : 'Target discovery failed');
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    benchFetch<{ tools: BenchTool[] }>('/tools')
      .then(({ tools }) => setTools(tools))
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load tools'));
    fetch('/api/gb10/state').then((r) => (r.ok ? r.json() : null)).then(setGb10).catch(() => setGb10(null));
    scan();
  }, []);

  // Defaults from the tool schema, then the remembered/seeded values on top.
  useEffect(() => {
    if (!tool) return;
    const defaults: BenchParams = Object.fromEntries(tool.params.map((p) => [p.key, p.default]));
    const remembered = loadPref<BenchParams>(`params.${tool.id}`, {});
    const base = { ...defaults, ...Object.fromEntries(Object.entries(remembered).filter(([k]) => k in defaults)) };
    if (seed && seed.tool.id === tool.id) {
      setParams({ ...base, ...seed.params });
      setConcurrency(seed.sweep ? seed.sweep.values : [Number(seed.params.concurrency)]);
      setCooldownS(seed.cooldownS || 10);
      setModel(seed.target.model);
      const preset = WORKLOAD_PRESETS.find((w) => w.isl === seed.params.isl && w.osl === seed.params.osl);
      setPresetId(preset ? preset.id : 'custom');
    } else {
      setParams(base);
    }
  }, [tool, seed]);

  // Pick the target: the seeded run's, else the remembered one, else the first reachable.
  useEffect(() => {
    if (!targets) return;
    if (seed) {
      const match = targets.find((t) => t.url === seed.target.url);
      if (match) setTargetId(match.id);
      else {
        setTargetId('manual');
        setManualUrl(seed.target.url);
      }
      return;
    }
    setTargetId((cur) => {
      if (cur === 'manual' || targets.some((t) => t.id === cur)) return cur;
      return targets.find((t) => t.reachable)?.id ?? (targets.length ? targets[0].id : 'manual');
    });
  }, [targets, seed]);

  const target = targets?.find((t) => t.id === targetId) ?? null;

  // Keep the model valid for the selected server.
  useEffect(() => {
    if (target && target.models.length > 0 && !target.models.includes(model)) setModel(target.models[0]);
  }, [target, model]);

  const preset = WORKLOAD_PRESETS.find((w) => w.id === presetId);
  const setParam = (key: string, v: BenchParams[string]) => setParams((p) => ({ ...p, [key]: v }));
  const choosePreset = (id: string) => {
    setPresetId(id);
    const w = WORKLOAD_PRESETS.find((x) => x.id === id);
    if (w) setParams((p) => ({ ...p, isl: w.isl, osl: w.osl }));
  };

  const durationMode = params.benchmarkDurationS !== null && params.benchmarkDurationS !== undefined;
  const url = targetId === 'manual' ? manualUrl.trim() : target?.url ?? '';
  const capMhz = gb10 && gb10.status.gpuClockLimitMhz.state !== 'unset' ? gb10.desired.gpuClockLimitMhz : null;

  const estimate = useMemo(() => {
    const steps = concurrency.length;
    if (durationMode) return `${steps} step${steps > 1 ? 's' : ''} × ${params.benchmarkDurationS} s ≈ ${Math.ceil((steps * Number(params.benchmarkDurationS) + (steps - 1) * cooldownS) / 60)} min`;
    return `${steps} step${steps > 1 ? 's' : ''} × ${params.requestCount} requests`;
  }, [concurrency, durationMode, params.benchmarkDurationS, params.requestCount, cooldownS]);

  const advanced = tool ? tool.params.filter((p) => !CURATED.includes(p.key)) : [];
  const canStart = Boolean(tool && url && model && concurrency.length > 0 && !activeRunId && !submitting);

  const start = async () => {
    if (!tool) return;
    setConfirmBuild(false);
    setSubmitting(true);
    setSubmitError(null);
    const sweep = concurrency.length > 1 ? { key: 'concurrency', values: concurrency } : null;
    const body = {
      toolId: tool.id,
      target: {
        url,
        model,
        apiKey: apiKey || undefined,
        label: target ? target.label : null,
        kind: target ? target.kind : null,
        containerName: target ? target.containerName : null,
      },
      params: { ...params, concurrency: concurrency[0] },
      sweep,
      cooldownS,
    };
    try {
      const { id } = await benchPost<{ id: string }>('/runs', body);
      savePref('targetId', targetId);
      savePref('manualUrl', manualUrl);
      savePref('model', model);
      savePref('presetId', presetId);
      savePref('concurrency', concurrency);
      savePref('cooldownS', cooldownS);
      savePref(`params.${tool.id}`, params);
      onStarted(id);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start');
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError && !tools) {
    return <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">{loadError}</div>;
  }
  if (!tools || !tool) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5 items-start">
      <div className="space-y-5 min-w-0">
        <Section
          n={1}
          title="Which server?"
          subtitle="Inference servers running on this machine, detected automatically"
          action={
            <button onClick={scan} disabled={scanning} className="px-2.5 h-8 rounded-lg border border-line text-xs font-medium hover:bg-hover disabled:opacity-50 inline-flex items-center gap-1.5 shrink-0">
              {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Rescan
            </button>
          }
        >
          {targets === null ? (
            <div className="flex items-center gap-2 text-sm text-muted py-4"><Loader2 size={14} className="animate-spin" /> Looking for servers…</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {targets.map((t) => (
                <Choice key={t.id} selected={targetId === t.id} onClick={() => setTargetId(t.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="inline-flex items-center gap-2 font-medium text-sm min-w-0">
                      <Server size={15} className="shrink-0" />
                      <span className="truncate">{t.kindLabel}</span>
                    </span>
                    {targetId === t.id && <Check size={15} className="shrink-0" />}
                  </div>
                  <p className="text-xs text-muted mt-1 truncate">{t.containerName ?? 'installed on the host'} · port {t.port}</p>
                  <p className={`text-xs mt-2 inline-flex items-center gap-1.5 ${t.reachable ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${t.reachable ? 'bg-emerald-500' : 'bg-muted'}`} />
                    {t.reachable ? `${t.models.length} model${t.models.length > 1 ? 's' : ''} served` : 'not answering /v1/models from here'}
                  </p>
                  {t.vramBytes !== null && <p className="text-[11px] text-muted mt-0.5">{fmtBytes(t.vramBytes)}</p>}
                </Choice>
              ))}
              <Choice selected={targetId === 'manual'} onClick={() => setTargetId('manual')}>
                <div className="flex items-start justify-between gap-2">
                  <span className="inline-flex items-center gap-2 font-medium text-sm">
                    <Link2 size={15} /> Other server
                  </span>
                  {targetId === 'manual' && <Check size={15} />}
                </div>
                <p className="text-xs text-muted mt-1">Any OpenAI-compatible URL</p>
              </Choice>
            </div>
          )}
          {targets !== null && targets.length === 0 && (
            <p className="text-xs text-muted mt-3">
              No inference server detected. Start vLLM, SGLang, Ollama, llama.cpp… (from the Containers page or the host), then rescan — or enter its URL.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            {targetId === 'manual' && (
              <label className="block sm:col-span-2">
                <span className={labelClass}>Server URL (as seen from the host)</span>
                <input className={`${inputClass} font-mono`} value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="http://localhost:8000" />
              </label>
            )}
            <label className="block">
              <span className={labelClass}>Model</span>
              {target && target.models.length > 0 ? (
                <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
                  {target.models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input className={`${inputClass} font-mono`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Qwen/Qwen3-8B" />
              )}
            </label>
            <label className="block">
              <span className={labelClass}>API key <span className="normal-case tracking-normal">(optional, never stored)</span></span>
              <input className={inputClass} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="none" />
            </label>
          </div>
        </Section>

        <Section n={2} title="What kind of work?" subtitle="The size of the prompts sent and of the answers requested, in tokens">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {WORKLOAD_PRESETS.map((w) => (
              <Choice key={w.id} selected={presetId === w.id} onClick={() => choosePreset(w.id)}>
                <p className="text-sm font-medium">{w.label}</p>
                <p className="text-xs text-muted mt-0.5">{w.description}</p>
                <p className="text-xs font-mono mt-2 tabular-nums">
                  {fmt(w.isl, 0)} → {fmt(w.osl, 0)}
                </p>
              </Choice>
            ))}
            <Choice selected={presetId === 'custom'} onClick={() => setPresetId('custom')}>
              <p className="text-sm font-medium">Custom</p>
              <p className="text-xs text-muted mt-0.5">Your own sizes</p>
              <p className="text-xs font-mono mt-2 tabular-nums">
                {fmt(Number(params.isl), 0)} → {fmt(Number(params.osl), 0)}
              </p>
            </Choice>
          </div>
          {presetId === 'custom' && (
            <div className="grid grid-cols-2 gap-3 mt-4">
              {tool.params.filter((p) => p.key === 'isl' || p.key === 'osl').map((spec) => (
                <ParamInput key={spec.key} spec={spec} value={params[spec.key]} onChange={(v) => setParam(spec.key, v)} />
              ))}
            </div>
          )}
        </Section>

        <Section n={3} title="How much load?" subtitle="Concurrent users. Several levels = a sweep: one step per level, to find the sweet spot">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {CONCURRENCY_PRESETS.map((c) => (
              <Choice key={c.label} selected={!customLevels && concurrency.join() === c.values.join()} onClick={() => { setCustomLevels(''); setConcurrency(c.values); }}>
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-xs font-mono text-muted mt-1">{c.values.join(' · ')}</p>
              </Choice>
            ))}
            <Choice
              selected={Boolean(customLevels) || !CONCURRENCY_PRESETS.some((c) => c.values.join() === concurrency.join())}
              onClick={() => setCustomLevels(customLevels || concurrency.join(', '))}
            >
              <p className="text-sm font-medium">Custom</p>
              <p className="text-xs font-mono text-muted mt-1 truncate">{customLevels || concurrency.join(' · ')}</p>
            </Choice>
          </div>
          {(customLevels || !CONCURRENCY_PRESETS.some((c) => c.values.join() === concurrency.join())) && (
            <label className="block mt-3">
              <span className={labelClass}>Concurrency levels (comma separated, up to 12)</span>
              <input
                className={`${inputClass} font-mono`}
                value={customLevels || concurrency.join(', ')}
                onChange={(e) => {
                  setCustomLevels(e.target.value);
                  const v = parseList(e.target.value);
                  if (v && v.length <= 12) setConcurrency(v);
                }}
              />
            </label>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4 items-end">
            <div>
              <span className={labelClass}>Each step runs for</span>
              <div className="flex rounded-lg border border-line p-0.5 h-9">
                {['requests', 'seconds'].map((mode) => {
                  const on = (mode === 'seconds') === durationMode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() =>
                        setParams((p) =>
                          mode === 'seconds'
                            ? { ...p, requestCount: null, benchmarkDurationS: 60 }
                            : { ...p, requestCount: 50, benchmarkDurationS: null },
                        )
                      }
                      className={`flex-1 rounded-md text-xs font-medium ${on ? 'bg-hover text-fg' : 'text-muted hover:text-fg'}`}
                    >
                      {mode}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="block">
              <span className={labelClass}>{durationMode ? 'Seconds per step' : 'Requests per step'}</span>
              <input
                className={inputClass}
                type="number"
                min={1}
                value={String(durationMode ? params.benchmarkDurationS ?? '' : params.requestCount ?? '')}
                onChange={(e) => setParam(durationMode ? 'benchmarkDurationS' : 'requestCount', e.target.value === '' ? null : Number(e.target.value))}
              />
            </label>
            {concurrency.length > 1 && (
              <label className="block">
                <span className={labelClass}>Pause between steps (s)</span>
                <input className={inputClass} type="number" min={0} max={600} value={cooldownS} onChange={(e) => setCooldownS(Number(e.target.value) || 0)} />
              </label>
            )}
          </div>
          {!durationMode && concurrency.some((c) => Number(params.requestCount) < c * 4) && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
              Tip: at high concurrency, a few requests per user are needed for stable numbers — try at least {Math.max(...concurrency) * 4} requests.
            </p>
          )}
        </Section>

        <section className={cardClass}>
          <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="w-full flex items-center gap-2 text-sm font-semibold tracking-tight">
            {showAdvanced ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            Advanced settings
            <span className="text-xs text-muted font-normal">streaming, output length, warmup, tokenizer, seed…</span>
          </button>
          {showAdvanced && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              {advanced.map((spec) => (
                <ParamInput key={spec.key} spec={spec} value={params[spec.key]} onChange={(v) => setParam(spec.key, v)} />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* summary + launch */}
      <aside className="xl:sticky xl:top-20 space-y-4">
        <div className={cardClass}>
          <p className="text-xs font-medium uppercase tracking-wider text-muted mb-2">Tool</p>
          {tools.length > 1 ? (
            <select className={inputClass} value={toolId} onChange={(e) => setToolId(e.target.value)}>
              {tools.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          ) : (
            <p className="text-sm font-semibold">
              {tool.label} <span className="text-muted font-normal">{tool.version}</span>
            </p>
          )}
          <p className="text-xs text-muted mt-1">{tool.description}</p>
          <p className={`text-xs mt-2 inline-flex items-center gap-1.5 ${tool.imageReady ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'}`}>
            {tool.imageReady ? <Boxes size={12} /> : <CircleDashed size={12} />}
            {tool.imageReady ? 'Installed' : `Installed on first run (${tool.imageSizeHint} download)`}
          </p>
        </div>

        <div className={cardClass}>
          <p className="text-xs font-medium uppercase tracking-wider text-muted mb-3">Summary</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted">Server</dt><dd className="text-right truncate">{targetId === 'manual' ? url : target?.label ?? '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Model</dt><dd className="text-right truncate font-mono text-xs leading-5">{model || '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Work</dt><dd className="text-right">{preset?.label ?? 'Custom'} · {fmt(Number(params.isl), 0)} → {fmt(Number(params.osl), 0)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted inline-flex items-center gap-1"><Users size={12} /> Users</dt><dd className="text-right font-mono text-xs leading-5">{concurrency.join(' · ')}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Size</dt><dd className="text-right">{estimate}</dd></div>
            <div className="flex justify-between gap-3 items-center">
              <dt className="text-muted inline-flex items-center gap-1"><Gauge size={12} /> Clock cap</dt>
              <dd className="text-right">
                <button onClick={onOpenGb10} className="underline decoration-dotted underline-offset-2 hover:text-fg">
                  {capMhz ? `${capMhz} MHz` : 'none'}
                </button>
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted mt-3">The cap in force is recorded with the results, so runs at different caps can be compared.</p>

          {activeRunId && <p className="text-xs text-amber-700 dark:text-amber-400 mt-3">A benchmark is already running: one at a time, so they don't measure each other.</p>}
          {submitError && <p className="text-xs text-red-600 dark:text-red-400 mt-3">{submitError}</p>}
          <button
            onClick={() => (tool.imageReady ? start() : setConfirmBuild(true))}
            disabled={!canStart}
            className="mt-4 w-full h-11 rounded-lg bg-accent text-accent-fg text-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Start benchmark
          </button>
        </div>
      </aside>

      {confirmBuild && (
        <ConfirmModal
          title={`Install ${tool.label} first?`}
          message={`This first run builds the ${tool.label} image (${tool.imageSizeHint} to download, a few minutes). It only happens once; progress shows in the run's log.`}
          confirmLabel="Install and start"
          variant="primary"
          onConfirm={start}
          onCancel={() => setConfirmBuild(false)}
        />
      )}
    </div>
  );
}
