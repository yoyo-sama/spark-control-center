import { useCallback, useEffect, useState } from 'react';
import { ChartNoAxesColumn, GitCompareArrows, Loader2, Play, Trash2 } from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import type { BenchRunSummary } from '../types';
import { CAP_VERDICT, MAX_COMPARE, RUN_STATUS, benchFetch, fmt, fmtDate, isActive, seriesColor } from '../lib/bench';

// Throughput of each step as tiny bars: the shape of a sweep at a glance.
function StepBars({ run }: { run: BenchRunSummary }) {
  const values = run.steps.map((s) => s.outputTokenThroughput ?? 0);
  const max = Math.max(...values, 1);
  if (run.steps.length < 2) return null;
  return (
    <svg width={run.steps.length * 7} height={22} className="shrink-0" aria-hidden="true">
      {run.steps.map((s, i) => {
        const h = Math.max(2, ((s.outputTokenThroughput ?? 0) / max) * 20);
        return <rect key={i} x={i * 7} y={22 - h} width={5} height={h} rx={1.5} fill={s.outputTokenThroughput ? seriesColor(0) : 'var(--line)'} />;
      })}
    </svg>
  );
}

interface Props {
  onOpen: (id: string) => void;
  onCompare: (ids: string[]) => void;
  onNew: () => void;
  preselect: string | null;
}

export default function BenchHistory({ onOpen, onCompare, onNew, preselect }: Props) {
  const [runs, setRuns] = useState<BenchRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(preselect ? [preselect] : []);
  const [confirmDelete, setConfirmDelete] = useState<BenchRunSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await benchFetch<{ runs: BenchRunSummary[] }>('/runs');
      setRuns(data.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh while something runs, so its row fills in.
  useEffect(() => {
    if (!runs?.some((r) => isActive(r.status))) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [runs, load]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= MAX_COMPARE ? s : [...s, id]));

  const remove = async (run: BenchRunSummary) => {
    setConfirmDelete(null);
    try {
      await benchFetch(`/runs/${run.id}`, { method: 'DELETE' });
      setSelected((s) => s.filter((x) => x !== run.id));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  if (error && !runs) {
    return <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">{error}</div>;
  }
  if (!runs) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="bg-surface border border-line rounded-xl p-10 text-center">
        <ChartNoAxesColumn size={28} className="mx-auto text-muted" />
        <h3 className="text-sm font-semibold mt-3">No benchmark yet</h3>
        <p className="text-sm text-muted mt-1">Measure how fast your models answer on this machine, and what the clock cap costs.</p>
        <button onClick={onNew} className="mt-5 px-4 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 inline-flex items-center gap-2">
          <Play size={14} /> Start a benchmark
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {runs.length} run{runs.length > 1 ? 's' : ''} · select up to {MAX_COMPARE} to compare them
        </p>
        <button
          onClick={() => onCompare(selected)}
          disabled={selected.length < 2}
          className="px-3 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          <GitCompareArrows size={14} /> Compare{selected.length ? ` (${selected.length})` : ''}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="overflow-x-auto bg-surface rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-line">
              <th className="w-10 px-4 py-3" />
              {['Date', 'Model', 'Work', 'Users', 'Cap', 'Throughput', 'First token', 'Efficiency', 'Status', ''].map((h) => (
                <th key={h} className="px-3 py-3 text-xs font-medium uppercase tracking-wider text-muted whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {runs.map((r) => {
              const st = RUN_STATUS[r.status];
              const isSel = selected.includes(r.id);
              const verdict = r.best?.capVerdict;
              return (
                <tr key={r.id} onClick={() => onOpen(r.id)} className="hover:bg-hover cursor-pointer">
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSel}
                      disabled={!isSel && selected.length >= MAX_COMPARE}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select run ${r.id} for comparison`}
                      className="accent-current"
                    />
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-muted tabular-nums">{fmtDate(r.createdAt)}</td>
                  <td className="px-3 py-3 max-w-[260px]">
                    <p className="font-medium truncate">{r.target.model}</p>
                    <p className="text-xs text-muted truncate">{r.target.label ?? r.target.url}</p>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap font-mono text-xs tabular-nums">
                    {fmt(r.params.isl, 0)} → {fmt(r.params.osl, 0)}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap font-mono text-xs">{r.sweep ? r.sweep.values.join('·') : r.params.concurrency}</td>
                  <td className="px-3 py-3 whitespace-nowrap text-xs">
                    {r.gb10?.capMhz ? `${r.gb10.capMhz} MHz` : <span className="text-muted">none</span>}
                    {verdict && verdict !== 'no-cap' && <p className={`text-[11px] ${CAP_VERDICT[verdict].cls}`}>{CAP_VERDICT[verdict].label}</p>}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="tabular-nums whitespace-nowrap">
                        {r.best ? <>{fmt(r.best.outputTokenThroughput, 0)} <span className="text-xs text-muted">tok/s</span></> : <span className="text-muted">—</span>}
                      </span>
                      <StepBars run={r} />
                    </div>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                    {r.best ? <>{fmt(r.best.ttftP50)} <span className="text-xs text-muted">ms</span></> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                    {r.best?.tokensPerJoule != null ? <>{fmt(r.best.tokensPerJoule)} <span className="text-xs text-muted">tok/J</span></> : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${st.cls}`}>
                      {isActive(r.status) && <Loader2 size={10} className="animate-spin" />}
                      {st.label}
                      {isActive(r.status) && ` ${r.stepsDone}/${r.stepCount}`}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {!isActive(r.status) && (
                      <button onClick={() => setConfirmDelete(r)} aria-label={`Delete run ${r.id}`} className="p-1.5 rounded-md text-muted hover:text-red-600 hover:bg-hover">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">Throughput, first token and efficiency are those of each run's best step (highest throughput).</p>

      {confirmDelete && (
        <ConfirmModal
          title="Delete this run?"
          message={`${confirmDelete.target.model}, ${fmtDate(confirmDelete.createdAt)}: its results, telemetry and logs are removed from disk. This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
