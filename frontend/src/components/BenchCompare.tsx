import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Loader2, TriangleAlert } from 'lucide-react';
import { CompareChart } from './BenchCharts';
import type { BenchRun } from '../types';
import { CAP_VERDICT, METRICS, benchFetch, fmt, fmtDate, metricOf, pctDelta, seriesColor, stepConcurrency } from '../lib/bench';

const WORKLOAD_KEYS: [string, string][] = [
  ['isl', 'Input tokens'],
  ['osl', 'Output tokens'],
  ['requestCount', 'Requests per step'],
  ['benchmarkDurationS', 'Seconds per step'],
  ['endpointType', 'Endpoint'],
  ['streaming', 'Streaming'],
  ['ignoreEos', 'Fixed output length'],
  ['randomSeed', 'Seed'],
];

const TABLE_METRICS: { tag: string; stat: 'avg' | 'p50' | 'p99' }[] = [
  { tag: 'output_token_throughput', stat: 'avg' },
  { tag: 'output_token_throughput_per_user', stat: 'avg' },
  { tag: 'time_to_first_token', stat: 'p50' },
  { tag: 'time_to_first_token', stat: 'p99' },
  { tag: 'inter_token_latency', stat: 'p50' },
  { tag: 'request_latency', stat: 'p50' },
  { tag: 'request_throughput', stat: 'avg' },
];

function Swatch({ i }: { i: number }) {
  return <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: seriesColor(i) }} />;
}

// Arrow + sign + colour: a delta never relies on colour alone.
function Delta({ value, better }: { value: number | null; better: 'higher' | 'lower' }) {
  if (value === null || Math.abs(value) < 0.05) return <span className="text-muted">±0%</span>;
  const good = better === 'higher' ? value > 0 : value < 0;
  const Icon = value > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-0.5 ${good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
      <Icon size={11} />
      {value > 0 ? '+' : ''}
      {fmt(value, 1)}%
    </span>
  );
}

export default function BenchCompare({ ids, onBack, onOpen }: { ids: string[]; onBack: () => void; onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<BenchRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<number | null>(null);

  useEffect(() => {
    Promise.all(ids.map((id) => benchFetch<BenchRun>(`/runs/${id}`)))
      .then(setRuns)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load runs'));
  }, [ids]);

  const levels = useMemo(() => {
    if (!runs) return [];
    const per = runs.map((r) => new Set(r.steps.filter((s) => s.result).map((s) => stepConcurrency(s, r.params))));
    return [...per[0]].filter((c) => per.every((set) => set.has(c))).sort((a, b) => a - b);
  }, [runs]);

  useEffect(() => {
    if (levels.length && (level === null || !levels.includes(level))) setLevel(levels[levels.length - 1]);
  }, [levels, level]);

  if (error) return <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">{error}</div>;
  if (!runs) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  const sameWorkload = runs.every((r) => r.fingerprint === runs[0].fingerprint);
  const workloadDiffs = WORKLOAD_KEYS.filter(([k]) => runs.some((r) => String(r.params[k]) !== String(runs[0].params[k])));
  const name = (r: BenchRun, i: number) => `${i + 1}. ${r.target.model}${r.gb10?.capMhz ? ` @${r.gb10.capMhz}` : ''}`;
  const series = (fn: (r: BenchRun, step: BenchRun['steps'][number]) => number | null) =>
    runs.map((r, i) => ({
      name: name(r, i),
      points: r.steps.filter((s) => s.result).map((s) => ({ c: stepConcurrency(s, r.params), v: fn(r, s) })),
    }));
  const stepAt = (r: BenchRun) => r.steps.find((s) => s.result && stepConcurrency(s, r.params) === level);

  // What differs between the runs — the reason a comparison is being made.
  const conditions: { label: string; values: string[] }[] = [
    { label: 'Model', values: runs.map((r) => r.target.model) },
    { label: 'Server', values: runs.map((r) => r.target.label ?? r.target.url) },
    { label: 'Clock cap', values: runs.map((r) => (r.gb10?.capMhz ? `${r.gb10.capMhz} MHz` : 'none')) },
    {
      label: 'Cap under load',
      values: runs.map((r) => {
        const v = r.steps.find((s) => s.telemetry)?.telemetry?.cap.verdict;
        return v ? CAP_VERDICT[v].label : '—';
      }),
    },
    { label: 'Tool', values: runs.map((r) => `${r.tool.label} ${r.tool.version}`) },
    { label: 'Work', values: runs.map((r) => `${fmt(Number(r.params.isl), 0)} → ${fmt(Number(r.params.osl), 0)}`) },
    { label: 'Date', values: runs.map((r) => fmtDate(r.createdAt)) },
  ];

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg transition-colors">
        <ArrowLeft size={14} /> All runs
      </button>

      {!sameWorkload && (
        <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm flex gap-2.5">
          <TriangleAlert size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">These runs did not use the same workload</p>
            <p className="mt-0.5">
              Differences may come from the work asked, not from the server, the model or the clock cap.
              {workloadDiffs.length > 0 && <> Differs: {workloadDiffs.map(([, l]) => l).join(', ')}.</>}
            </p>
          </div>
        </div>
      )}

      <div className="overflow-x-auto bg-surface rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted w-36">Run</th>
              {runs.map((r, i) => (
                <th key={r.id} className="px-4 py-3 text-left font-medium">
                  <button onClick={() => onOpen(r.id)} className="inline-flex items-center gap-2 hover:underline">
                    <Swatch i={i} />
                    {i === 0 ? 'Baseline' : `Run ${i + 1}`}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {conditions.map((row) => {
              const differs = row.values.some((v) => v !== row.values[0]);
              return (
                <tr key={row.label}>
                  <td className="px-4 py-2.5 text-xs text-muted">{row.label}</td>
                  {row.values.map((v, i) => (
                    <td key={i} className={`px-4 py-2.5 ${differs && row.label !== 'Date' ? 'font-semibold' : ''} ${row.label === 'Model' ? 'font-mono text-xs' : ''}`}>
                      {v}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CompareChart title="Output throughput" subtitle="tok/s by concurrency — higher is better" unit="tok/s" series={series((_, s) => metricOf(s, 'output_token_throughput'))} />
        <CompareChart title="Efficiency" subtitle="tokens per joule of GPU energy — higher is better" unit="tok/J" series={series((_, s) => s.telemetry?.tokensPerJoule ?? null)} />
        <CompareChart title="Time to first token (p50)" subtitle="ms by concurrency — lower is better" unit="ms" series={series((_, s) => metricOf(s, 'time_to_first_token', 'p50'))} />
        <CompareChart title="Inter-token latency (p50)" subtitle="ms by concurrency — lower is better" unit="ms" series={series((_, s) => metricOf(s, 'inter_token_latency', 'p50'))} />
      </div>

      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Side by side</h3>
            <p className="text-xs text-muted">Each run against the baseline (run 1), at the same concurrency</p>
          </div>
          {levels.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted mr-1">Concurrency</span>
              {levels.map((c) => (
                <button
                  key={c}
                  onClick={() => setLevel(c)}
                  className={`px-2.5 h-7 rounded-md border font-mono ${level === c ? 'border-fg/60 bg-hover' : 'border-line text-muted hover:text-fg'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
        {levels.length === 0 ? (
          <p className="text-sm text-muted">These runs share no concurrency level: compare them on the charts above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Metric</th>
                  {runs.map((r, i) => (
                    <th key={r.id} className="py-2 px-3 font-medium">
                      <span className="inline-flex items-center gap-1.5"><Swatch i={i} /> {i === 0 ? 'Baseline' : `Run ${i + 1}`}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {TABLE_METRICS.map(({ tag, stat }) => {
                  const meta = METRICS[tag];
                  const base = metricOf(stepAt(runs[0]), tag, stat);
                  return (
                    <tr key={`${tag}.${stat}`}>
                      <td className="py-2.5 pr-3" title={meta.help}>
                        {meta.label} {stat !== 'avg' && <span className="text-xs text-muted">{stat}</span>}
                      </td>
                      {runs.map((r, i) => {
                        const v = metricOf(stepAt(r), tag, stat);
                        return (
                          <td key={r.id} className="py-2.5 px-3 tabular-nums whitespace-nowrap">
                            {fmt(v)} <span className="text-xs text-muted">{meta.unit}</span>
                            {i > 0 && <span className="ml-2 text-xs"><Delta value={pctDelta(base, v)} better={meta.better} /></span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr>
                  <td className="py-2.5 pr-3">Efficiency</td>
                  {runs.map((r, i) => {
                    const v = stepAt(r)?.telemetry?.tokensPerJoule ?? null;
                    const base = stepAt(runs[0])?.telemetry?.tokensPerJoule ?? null;
                    return (
                      <td key={r.id} className="py-2.5 px-3 tabular-nums whitespace-nowrap">
                        {fmt(v)} <span className="text-xs text-muted">tok/J</span>
                        {i > 0 && <span className="ml-2 text-xs"><Delta value={pctDelta(base, v)} better="higher" /></span>}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td className="py-2.5 pr-3">GPU power (avg)</td>
                  {runs.map((r, i) => {
                    const v = stepAt(r)?.telemetry?.powerAvgW ?? null;
                    const base = stepAt(runs[0])?.telemetry?.powerAvgW ?? null;
                    return (
                      <td key={r.id} className="py-2.5 px-3 tabular-nums whitespace-nowrap">
                        {fmt(v, 0)} <span className="text-xs text-muted">W</span>
                        {i > 0 && <span className="ml-2 text-xs"><Delta value={pctDelta(base, v)} better="lower" /></span>}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
