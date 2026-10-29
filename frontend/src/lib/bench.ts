import type { BenchRunStatus, BenchStep, BenchStepStatus, CapVerdict } from '../types';

export const BENCH_API = '/api/benchmarks';

export async function benchFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BENCH_API}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export function benchPost<T>(path: string, body: unknown): Promise<T> {
  return benchFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Categorical slots (--series-1..4 in index.css, validated on this app's light and dark
// surfaces). Assigned in order, never cycled: the compare view caps at 4 runs.
export const MAX_COMPARE = 4;

export function seriesColor(i: number): string {
  return `var(--series-${i + 1})`;
}

// Readable precision: 0.84 ms, 12.4 ms, 1,234 tok/s.
export function fmt(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = digits ?? (Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0);
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function pctDelta(base: number | null | undefined, v: number | null | undefined): number | null {
  if (base === null || base === undefined || v === null || v === undefined || !base) return null;
  return ((v - base) / base) * 100;
}

// Which way is better, so a delta can be read as good or bad news.
export interface MetricMeta {
  label: string;
  short: string;
  unit: string;
  better: 'higher' | 'lower';
  help: string;
}

export const METRICS: Record<string, MetricMeta> = {
  output_token_throughput: {
    label: 'Output throughput',
    short: 'Throughput',
    unit: 'tok/s',
    better: 'higher',
    help: 'Tokens generated per second, all concurrent users combined',
  },
  output_token_throughput_per_user: {
    label: 'Speed per user',
    short: 'Per user',
    unit: 'tok/s',
    better: 'higher',
    help: 'Generation speed one user sees once the first token has arrived',
  },
  time_to_first_token: {
    label: 'Time to first token',
    short: 'TTFT',
    unit: 'ms',
    better: 'lower',
    help: 'Wait before the first token: queueing + reading the prompt (prefill)',
  },
  inter_token_latency: {
    label: 'Inter-token latency',
    short: 'ITL',
    unit: 'ms',
    better: 'lower',
    help: 'Time between two generated tokens for one user (decode speed)',
  },
  request_latency: {
    label: 'Request latency',
    short: 'Latency',
    unit: 'ms',
    better: 'lower',
    help: 'End to end: from sending the request to the last token',
  },
  request_throughput: {
    label: 'Request throughput',
    short: 'Req/s',
    unit: 'req/s',
    better: 'higher',
    help: 'Completed requests per second',
  },
};

export interface WorkloadPreset {
  id: string;
  label: string;
  description: string;
  isl: number;
  osl: number;
}

export const WORKLOAD_PRESETS: WorkloadPreset[] = [
  { id: 'chat', label: 'Chat', description: 'Short question, short answer', isl: 128, osl: 128 },
  { id: 'code', label: 'Coding agent', description: 'Large context, medium answer', isl: 4096, osl: 512 },
  { id: 'summarize', label: 'Summarize', description: 'Long document in, short summary out', isl: 2048, osl: 256 },
  { id: 'generate', label: 'Long generation', description: 'Short prompt, long answer', isl: 128, osl: 2048 },
  { id: 'rag', label: 'RAG', description: 'Retrieved passages in, concise answer out', isl: 8192, osl: 512 },
];

export const CONCURRENCY_PRESETS: { label: string; values: number[] }[] = [
  { label: 'Single user', values: [1] },
  { label: 'Quick sweep', values: [1, 2, 4, 8] },
  { label: 'Full sweep', values: [1, 2, 4, 8, 16, 32, 64] },
];

export const RUN_STATUS: Record<BenchRunStatus, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  preparing: { label: 'Preparing', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  running: { label: 'Running', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  success: { label: 'Done', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  failed: { label: 'Failed', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  cancelled: { label: 'Cancelled', cls: 'bg-hover text-muted' },
  interrupted: { label: 'Interrupted', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
};

export const STEP_STATUS: Record<BenchStepStatus, string> = {
  pending: 'border-line text-muted',
  running: 'border-sky-500 text-sky-600 dark:text-sky-400',
  success: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  cancelled: 'border-line bg-hover text-muted',
  failed: 'border-red-500/60 bg-red-500/10 text-red-600 dark:text-red-400',
  skipped: 'border-dashed border-line text-muted',
};

export const CAP_VERDICT: Record<CapVerdict, { label: string; cls: string }> = {
  held: { label: 'Cap held', cls: 'text-emerald-600 dark:text-emerald-400' },
  exceeded: { label: 'Cap ignored', cls: 'text-red-600 dark:text-red-400' },
  'not-observable': { label: 'Cap not reached', cls: 'text-muted' },
  'no-cap': { label: 'No cap', cls: 'text-muted' },
};

export function isActive(status: BenchRunStatus): boolean {
  return status === 'queued' || status === 'preparing' || status === 'running';
}

export function stepConcurrency(step: BenchStep, params: Record<string, unknown>): number {
  return step.key === 'concurrency' ? step.value : Number(params.concurrency);
}

export function metricOf(step: BenchStep | undefined, tag: string, stat: 'avg' | 'p50' | 'p90' | 'p99' = 'avg'): number | null {
  const m = step?.result?.metrics?.[tag];
  const v = m ? m[stat] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// localStorage only holds per-viewer conveniences (last form values); it can throw.
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`bench.${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`bench.${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}
