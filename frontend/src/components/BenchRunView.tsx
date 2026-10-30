import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Gauge,
  GitCompareArrows,
  Leaf,
  Loader2,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Square,
  Timer,
  TriangleAlert,
  Users,
  Zap,
} from 'lucide-react';
import StatCard from './StatCard';
import ConfirmModal from './ConfirmModal';
import LogView from './LogView';
import { ChartCard, PercentileLadder, SweepCharts, TelemetryChart } from './BenchCharts';
import type { BenchLogEntry, BenchRun, BenchSample, BenchStep } from '../types';
import {
  BENCH_API,
  CAP_VERDICT,
  METRICS,
  RUN_STATUS,
  STEP_STATUS,
  benchPost,
  fmt,
  fmtDate,
  fmtDuration,
  isActive,
  metricOf,
  stepConcurrency,
} from '../lib/bench';

const MAX_LIVE_SAMPLES = 2400;

// Live view through SSE. The server replays a snapshot on every (re)connection, so an
// EventSource auto-reconnect simply resyncs; `end` means the run is over.
function useRunStream(id: string) {
  const [run, setRun] = useState<BenchRun | null>(null);
  const [logs, setLogs] = useState<BenchLogEntry[]>([]);
  const [samples, setSamples] = useState<BenchSample[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`${BENCH_API}/runs/${id}/events`);
    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') {
        setRun(data.run);
        setLogs(data.logs);
        setSamples(data.samples);
        setError(null);
      } else if (data.type === 'run') {
        setRun(data.run);
      } else if (data.type === 'log') {
        setLogs((prev) => (prev.length > 3000 ? [...prev.slice(-2000), data.log] : [...prev, data.log]));
      } else if (data.type === 'telemetry') {
        // halve the resolution instead of growing without bound on a long run
        setSamples((prev) => (prev.length >= MAX_LIVE_SAMPLES ? [...prev.filter((_, i) => i % 2 === 0), data.sample] : [...prev, data.sample]));
      } else if (data.type === 'end') {
        es.close();
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setError('Lost the connection to the server');
    };
    return () => es.close();
  }, [id]);

  return { run, logs, samples, error };
}

// Ticks once a second while `running`, for the elapsed-time display.
function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

function StepPills({ run, selected, onSelect }: { run: BenchRun; selected: number | null; onSelect: (i: number) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {run.steps.map((s) => {
        const tps = metricOf(s, 'output_token_throughput');
        const active = selected === s.index;
        return (
          <button
            key={s.index}
            onClick={() => s.result && onSelect(s.index)}
            disabled={!s.result}
            title={s.error || undefined}
            className={`px-3 py-1.5 rounded-lg border text-xs font-medium tabular-nums inline-flex items-center gap-2 transition-colors ${STEP_STATUS[s.status]} ${active ? 'ring-2 ring-fg/30' : ''} ${s.result ? 'hover:opacity-80' : 'cursor-default'}`}
          >
            {s.status === 'running' && <Loader2 size={12} className="animate-spin" />}
            <span>
              <Users size={11} className="inline -mt-0.5 mr-1" />
              {stepConcurrency(s, run.params)}
            </span>
            {tps !== null && <span className="opacity-80">{fmt(tps, 0)} tok/s</span>}
            {s.status === 'failed' && <span>failed</span>}
            {s.status === 'skipped' && <span>skipped</span>}
          </button>
        );
      })}
    </div>
  );
}

function CapCard({ run, step, active }: { run: BenchRun; step: BenchStep | undefined; active: boolean }) {
  const t = step?.telemetry;
  const verdict = t?.cap.verdict ?? (run.gb10?.capMhz ? null : 'no-cap');
  // No verdict before a step has finished: say what is happening instead of guessing.
  const meta = verdict ? CAP_VERDICT[verdict] : { label: active ? 'Measuring under load…' : 'Not measured', cls: 'text-muted' };
  const Icon = verdict === 'held' ? ShieldCheck : verdict === 'exceeded' ? ShieldAlert : ShieldQuestion;
  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <div className="flex items-start gap-3">
        <span className={`p-2 rounded-lg bg-hover ${meta.cls}`}>
          <Icon size={18} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">GB10 clock cap</p>
          <p className={`text-sm font-semibold mt-0.5 ${meta.cls}`}>
            {meta.label}
            {run.gb10?.capMhz ? <span className="text-muted font-normal"> · {run.gb10.capMhz} MHz</span> : null}
          </p>
          <p className="text-xs text-muted mt-1">
            {t ? t.cap.message : active ? 'The verdict comes when the first step ends: the clock can only be judged while the GPU is busy' : 'No GPU samples were recorded'}
          </p>
          {t && t.clockMedianMhz !== null && (
            <p className="text-xs text-muted mt-1 tabular-nums">
              Under load: median {fmt(t.clockMedianMhz, 0)} MHz, max {fmt(t.clockMaxMhz, 0)} MHz · {fmt(t.powerAvgW, 0)} W avg, {fmt(t.tempMaxC, 0)} °C max
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricsTable({ step }: { step: BenchStep }) {
  const m = step.result?.metrics ?? {};
  const rows = Object.entries(METRICS).filter(([tag]) => m[tag]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-2 pr-3 font-medium">Metric</th>
            {['avg', 'p50', 'p90', 'p99', 'max'].map((h) => (
              <th key={h} className="py-2 px-2 font-medium text-right">{h}</th>
            ))}
            <th className="py-2 pl-2 font-medium">unit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(([tag, meta]) => {
            const s = m[tag]!;
            return (
              <tr key={tag}>
                <td className="py-2 pr-3" title={meta.help}>{meta.label}</td>
                {(['avg', 'p50', 'p90', 'p99', 'max'] as const).map((k) => (
                  <td key={k} className="py-2 px-2 text-right tabular-nums">{fmt(s[k])}</td>
                ))}
                <td className="py-2 pl-2 text-xs text-muted">{s.unit}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  runId: string;
  onBack: () => void;
  onRerun: (run: BenchRun) => void;
  onCompare: (runId: string) => void;
}

export default function BenchRunView({ runId, onBack, onRerun, onCompare }: Props) {
  const { run, logs, samples, error } = useRunStream(runId);
  const [selected, setSelected] = useState<number | null>(null);
  const [showLogs, setShowLogs] = useState<boolean | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const done = run ? run.steps.filter((s) => s.result) : [];
  const best = done.reduce<BenchStep | undefined>(
    (a, s) => ((metricOf(s, 'output_token_throughput') ?? -1) > (metricOf(a, 'output_token_throughput') ?? -1) ? s : a),
    undefined,
  );
  const step = run?.steps.find((s) => s.index === selected) ?? best;
  const active = run ? isActive(run.status) : false;
  const now = useNow(active);
  const logsOpen = showLogs ?? (active || run?.status === 'failed');

  const stepLabels = useMemo(() => {
    const out: Record<number, string> = {};
    if (run) for (const s of run.steps) out[s.index] = `×${stepConcurrency(s, run.params)}`;
    return out;
  }, [run]);

  if (!run) {
    return (
      <div className="flex items-center justify-center py-16 text-muted">
        {error ? <span className="text-sm">{error}</span> : <Loader2 size={20} className="animate-spin" />}
      </div>
    );
  }

  const status = RUN_STATUS[run.status];
  const p = run.params;
  const stepsDone = run.steps.filter((s) => !['pending', 'running'].includes(s.status)).length;
  const runningStep = run.steps.find((s) => s.status === 'running');
  const duration = run.startedAt ? ((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt)) / 1000 : null;
  const t = step?.telemetry;

  const cancel = async () => {
    setConfirmCancel(false);
    setCancelling(true);
    try {
      await benchPost(`/runs/${run.id}/cancel`, {});
    } catch {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg transition-colors">
        <ArrowLeft size={14} /> All runs
      </button>

      {/* header */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${status.cls}`}>
                {active && <Loader2 size={11} className="animate-spin" />}
                {cancelling && active ? 'Stopping' : status.label}
              </span>
              <h2 className="text-lg font-semibold tracking-tight break-all">{run.target.model}</h2>
            </div>
            <p className="text-sm text-muted mt-1.5">
              {run.target.label ?? run.target.url} <span className="font-mono text-xs">({run.target.url})</span>
            </p>
            <p className="text-xs text-muted mt-1">
              {run.tool.label} {run.tool.version} · {String(p.isl)} → {String(p.osl)} tokens ·{' '}
              {p.requestCount !== null ? `${p.requestCount} requests` : `${p.benchmarkDurationS} s`} per step ·{' '}
              {run.sweep ? `concurrency ${run.sweep.values.join(', ')}` : `concurrency ${p.concurrency}`}
              {p.streaming ? ' · streaming' : ''}
            </p>
            <p className="text-xs text-muted mt-1 inline-flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1"><Clock size={11} /> {fmtDate(run.createdAt)}</span>
              {duration !== null && <span className="inline-flex items-center gap-1"><Timer size={11} /> {fmtDuration(duration)}</span>}
              <span className="inline-flex items-center gap-1"><Gauge size={11} /> {run.gb10?.capMhz ? `cap ${run.gb10.capMhz} MHz` : 'no clock cap'}</span>
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {active ? (
              <button
                onClick={() => setConfirmCancel(true)}
                disabled={cancelling}
                className="px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover disabled:opacity-50 inline-flex items-center gap-2"
              >
                {cancelling ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />}
                {cancelling ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <>
                <button onClick={() => onCompare(run.id)} className="px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover inline-flex items-center gap-2">
                  <GitCompareArrows size={14} /> Compare
                </button>
                <button onClick={() => onRerun(run)} className="px-3 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 inline-flex items-center gap-2">
                  <RotateCw size={14} /> Run again
                </button>
              </>
            )}
          </div>
        </div>

        {/* progress */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-muted mb-1.5">
            <span>
              {run.status === 'preparing'
                ? `Preparing ${run.tool.label}…`
                : runningStep
                  ? `Step ${runningStep.index + 1} of ${run.steps.length} — ${stepConcurrency(runningStep, run.params)} concurrent ${stepConcurrency(runningStep, run.params) > 1 ? 'users' : 'user'}`
                  : `${stepsDone} of ${run.steps.length} steps`}
            </span>
            <span className="tabular-nums">{Math.round((stepsDone / run.steps.length) * 100)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${run.status === 'failed' ? 'bg-red-500' : 'bg-accent'}`}
              style={{ width: `${(stepsDone / run.steps.length) * 100}%` }}
            />
          </div>
          <div className="mt-3">
            <StepPills run={run} selected={step?.index ?? null} onSelect={setSelected} />
          </div>
        </div>
      </div>

      {run.error && (
        <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm flex gap-2">
          <TriangleAlert size={16} className="shrink-0 mt-0.5" />
          <span>{run.error}</span>
        </div>
      )}
      {run.warnings.map((w) => (
        <div key={w} className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm">
          {w}
        </div>
      ))}
      {run.status === 'preparing' && (
        <div className="p-4 rounded-lg border border-line bg-surface text-sm text-muted flex gap-2.5 items-start">
          <Loader2 size={16} className="animate-spin shrink-0 mt-0.5" />
          <span>
            First run of {run.tool.label}: its image is being built (a few minutes, once). Progress is in the log below.
          </span>
        </div>
      )}

      {/* headline numbers */}
      {step && step.result && (
        <>
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold tracking-tight">
              Results at concurrency {stepConcurrency(step, run.params)}
              {step === best && done.length > 1 && <span className="text-muted font-normal"> — the highest throughput of the sweep</span>}
            </h3>
            {done.length > 1 && <span className="text-xs text-muted">Click a step above to see its numbers</span>}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard title="Throughput" value={fmt(metricOf(step, 'output_token_throughput'), 0)} unit="tok/s" subtitle={`${fmt(metricOf(step, 'request_throughput'))} requests/s`} icon={<Zap size={15} />} color="blue" />
            <StatCard title="First token" value={fmt(metricOf(step, 'time_to_first_token', 'p50'))} unit="ms" subtitle={`p99 ${fmt(metricOf(step, 'time_to_first_token', 'p99'))} ms`} icon={<Timer size={15} />} color="purple" />
            <StatCard title="Between tokens" value={fmt(metricOf(step, 'inter_token_latency', 'p50'))} unit="ms" subtitle={`p99 ${fmt(metricOf(step, 'inter_token_latency', 'p99'))} ms`} icon={<Clock size={15} />} color="purple" />
            <StatCard title="Speed per user" value={fmt(metricOf(step, 'output_token_throughput_per_user'), 0)} unit="tok/s" subtitle="what one user sees" icon={<Users size={15} />} color="blue" />
            <StatCard
              title="Efficiency"
              value={fmt(t?.tokensPerJoule ?? null)}
              unit="tok/J"
              subtitle={t?.powerAvgW != null ? `${fmt(t.powerAvgW, 0)} W average` : 'needs GPU telemetry'}
              icon={<Leaf size={15} />}
              color="green"
            />
          </div>
          {step.result.errorCount > 0 && (
            <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm">
              {step.result.errorCount} request(s) failed during this step: the numbers only cover the successful ones.
            </div>
          )}
          {step.result.wasCancelled && (
            <div className="p-3 rounded-lg border border-line bg-hover text-muted text-sm">This step was stopped early: partial results.</div>
          )}
        </>
      )}

      <SweepCharts run={run} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CapCard run={run} step={step ?? runningStep} active={active} />
        {step && step.result && (
          <div className="lg:col-span-2">
            <ChartCard title="Latency distribution" subtitle="Median, 90th and 99th percentile: the longer the last bar, the worse the tail">
              <PercentileLadder
                rows={['time_to_first_token', 'inter_token_latency', 'request_latency']
                  .filter((tag) => step.result?.metrics[tag])
                  .map((tag) => ({ label: METRICS[tag].label, unit: 'ms', ...step.result!.metrics[tag] }))}
              />
            </ChartCard>
          </div>
        )}
      </div>

      {samples.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <TelemetryChart samples={samples} field="powerW" title="GPU power" unit="W" stepLabels={stepLabels} live={active} />
          <TelemetryChart samples={samples} field="clockMhz" title="GPU clock" unit="MHz" capMhz={run.gb10?.capMhz} stepLabels={stepLabels} live={active} />
          <TelemetryChart samples={samples} field="tempC" title="GPU temperature" unit="°C" stepLabels={stepLabels} live={active} />
        </div>
      ) : (
        !active && <p className="text-xs text-muted">No GPU telemetry was recorded for this run (nvidia-smi unavailable).</p>
      )}

      {step && step.result && (
        <ChartCard title="All metrics" subtitle={`Concurrency ${stepConcurrency(step, run.params)} — hover a metric name for its definition`}>
          <MetricsTable step={step} />
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <a href={`${BENCH_API}/runs/${run.id}/steps/${step.index}/result.json`} className="inline-flex items-center gap-1.5 text-muted hover:text-fg">
              <Download size={12} /> Raw {run.tool.label} result (JSON)
            </a>
          </div>
          {step.command && <p className="mt-2 font-mono text-[11px] text-muted break-all">{step.command}</p>}
        </ChartCard>
      )}

      <div className="bg-surface border border-line rounded-xl">
        <button onClick={() => setShowLogs(!logsOpen)} className="w-full px-4 h-11 flex items-center gap-2 text-sm font-semibold tracking-tight">
          {logsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          Log
          <span className="text-xs text-muted font-normal">{logs.length} lines</span>
        </button>
        {logsOpen && <LogView logs={logs} running={active} className="max-h-[420px] px-4 pb-4" />}
      </div>

      {confirmCancel && (
        <ConfirmModal
          title="Stop this benchmark?"
          message="The current step is stopped gracefully and keeps its partial results; the remaining steps are skipped."
          confirmLabel="Stop"
          onConfirm={cancel}
          onCancel={() => setConfirmCancel(false)}
        />
      )}
    </div>
  );
}
