import {
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { BenchRun, BenchSample } from '../types';
import { fmt, metricOf, seriesColor, stepConcurrency } from '../lib/bench';

// One axis per chart, thin 2px lines, recessive grid, hover tooltip on every chart,
// a legend as soon as there are two series. Colours are theme tokens (index.css).

const tooltipStyle = {
  contentStyle: {
    backgroundColor: 'var(--elevated)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--fg)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
    padding: '6px 10px',
  },
  labelStyle: { color: 'var(--muted)', marginBottom: 2 },
  cursor: { stroke: 'var(--line)' },
};
const tick = { fontSize: 10, fill: 'var(--muted)' };
const axisLine = { stroke: 'var(--line)' };
const legendStyle = { fontSize: 11, paddingTop: 4 };
// Legend text stays in text colour; the line sample next to it carries the identity.
const legendText = (value: string) => <span style={{ color: 'var(--muted)' }}>{value}</span>;

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4 min-w-0">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface TelemetryProps {
  samples: BenchSample[];
  field: 'powerW' | 'clockMhz' | 'tempC';
  title: string;
  unit: string;
  capMhz?: number | null;
  stepLabels?: Record<number, string>;
  live?: boolean;
}

// GPU telemetry over the run, with the clock cap and step boundaries drawn in.
export function TelemetryChart({ samples, field, title, unit, capMhz, stepLabels, live }: TelemetryProps) {
  const t0 = samples.length ? samples[0].t : 0;
  const data = samples.map((s) => ({ x: s.t - t0, v: s[field], step: s.step }));
  const starts: { x: number; label: string }[] = [];
  let prev: number | null = null;
  for (const d of data) {
    if (d.step !== null && d.step !== prev) starts.push({ x: d.x, label: stepLabels?.[d.step] ?? `#${d.step + 1}` });
    prev = d.step;
  }
  const values = data.map((d) => d.v).filter((v): v is number => v !== null);
  const max = Math.max(...values, capMhz ?? 0);
  const min = Math.min(...values);
  const pad = Math.max(1, (max - min) * 0.1);
  const domain: [number, number] = values.length ? [Math.max(0, Math.floor(min - pad)), Math.ceil(max + pad)] : [0, 1];
  const last = values.length ? values[values.length - 1] : null;
  const subtitle = !values.length ? 'no samples' : live ? `now ${fmt(last, 0)} ${unit}` : `peak ${fmt(Math.max(...values), 0)} ${unit}`;

  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={tick} tickLine={false} axisLine={axisLine} tickFormatter={elapsed} />
          <YAxis tick={tick} tickLine={false} axisLine={false} domain={domain} width={44} />
          <Tooltip
            {...tooltipStyle}
            labelFormatter={(x) => `t+${elapsed(Number(x))}`}
            formatter={(v) => [`${fmt(Number(v), 0)} ${unit}`, title]}
          />
          {starts.map((s) => (
            <ReferenceLine key={s.x} x={s.x} stroke="var(--line)" strokeDasharray="3 3" label={{ value: s.label, position: 'insideTopLeft', fontSize: 10, fill: 'var(--muted)' }} />
          ))}
          {capMhz ? (
            <ReferenceLine y={capMhz} stroke="var(--muted)" strokeDasharray="4 4" label={{ value: `cap ${capMhz}`, position: 'insideBottomRight', fontSize: 10, fill: 'var(--muted)' }} />
          ) : null}
          <Line type="monotone" dataKey="v" stroke={seriesColor(0)} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

interface SweepPoint {
  c: number;
  [k: string]: number | null;
}

function sweepPoints(run: BenchRun): SweepPoint[] {
  return run.steps
    .filter((s) => s.result)
    .map((s) => ({
      c: stepConcurrency(s, run.params),
      throughput: metricOf(s, 'output_token_throughput'),
      perUser: metricOf(s, 'output_token_throughput_per_user'),
      ttftP50: metricOf(s, 'time_to_first_token', 'p50'),
      ttftP99: metricOf(s, 'time_to_first_token', 'p99'),
      itlP50: metricOf(s, 'inter_token_latency', 'p50'),
      itlP99: metricOf(s, 'inter_token_latency', 'p99'),
      tpj: s.telemetry?.tokensPerJoule ?? null,
    }));
}

function TwoSeries({ data, keys, unit }: { data: SweepPoint[]; keys: [string, string, string, string]; unit: string }) {
  const [k1, n1, k2, n2] = keys;
  return (
    <ResponsiveContainer width="100%" height={190}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <XAxis dataKey="c" type="category" tick={tick} tickLine={false} axisLine={axisLine} />
        <YAxis tick={tick} tickLine={false} axisLine={false} width={44} />
        <Tooltip {...tooltipStyle} labelFormatter={(c) => `Concurrency ${c}`} formatter={(v, name) => [`${fmt(Number(v))} ${unit}`, name]} />
        <Legend wrapperStyle={legendStyle} iconType="plainline" formatter={legendText} />
        <Line name={n1} dataKey={k1} stroke={seriesColor(0)} strokeWidth={2} dot={{ r: 4, strokeWidth: 0, fill: seriesColor(0) }} isAnimationActive={false} />
        <Line name={n2} dataKey={k2} stroke={seriesColor(1)} strokeWidth={2} strokeDasharray="5 3" dot={{ r: 4, strokeWidth: 0, fill: seriesColor(1) }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// The four views of a concurrency sweep: what the server delivers, what each user
// waits, and the trade-off between the two.
export function SweepCharts({ run }: { run: BenchRun }) {
  const data = sweepPoints(run);
  if (data.length < 2) return null;
  const best = data.reduce((a, d) => ((d.throughput ?? -1) > (a.throughput ?? -1) ? d : a), data[0]);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard title="Output throughput" subtitle={`tok/s, all users combined — peak ${fmt(best.throughput, 0)} tok/s at concurrency ${best.c}`}>
        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={data} margin={{ top: 18, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="c" type="category" tick={tick} tickLine={false} axisLine={axisLine} />
            <YAxis tick={tick} tickLine={false} axisLine={false} width={44} />
            <Tooltip {...tooltipStyle} labelFormatter={(c) => `Concurrency ${c}`} formatter={(v) => [`${fmt(Number(v), 0)} tok/s`, 'Throughput']} />
            <Line dataKey="throughput" stroke={seriesColor(0)} strokeWidth={2} dot={{ r: 4, strokeWidth: 0, fill: seriesColor(0) }} isAnimationActive={false}>
              <LabelList
                dataKey="throughput"
                position="top"
                fontSize={10}
                fill="var(--fg)"
                formatter={(v) => (Number(v) === best.throughput ? fmt(Number(v), 0) : '')}
              />
            </Line>
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Throughput vs speed per user" subtitle="Each point is a concurrency level: up and to the right is better">
        <ResponsiveContainer width="100%" height={190}>
          <ScatterChart margin={{ top: 12, right: 16, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--line)" />
            <XAxis dataKey="perUser" type="number" name="Per user" unit=" tok/s" tick={tick} tickLine={false} axisLine={axisLine} domain={['auto', 'auto']} />
            <YAxis dataKey="throughput" type="number" name="Total" tick={tick} tickLine={false} axisLine={false} width={44} domain={['auto', 'auto']} />
            <ZAxis range={[64, 64]} />
            <Tooltip
              {...tooltipStyle}
              formatter={(v, name) => [`${fmt(Number(v), 0)} tok/s`, name === 'perUser' || name === 'Per user' ? 'Per user' : 'Total']}
              labelFormatter={() => ''}
            />
            <Scatter data={data} fill={seriesColor(0)} line={{ stroke: seriesColor(0), strokeWidth: 2 }} isAnimationActive={false}>
              <LabelList dataKey="c" position="right" fontSize={10} fill="var(--muted)" formatter={(c) => `×${c}`} />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Time to first token" subtitle="ms — how long a user waits before the answer starts">
        <TwoSeries data={data} keys={['ttftP50', 'median (p50)', 'ttftP99', 'worst 1% (p99)']} unit="ms" />
      </ChartCard>
      <ChartCard title="Inter-token latency" subtitle="ms between two tokens — lower feels faster">
        <TwoSeries data={data} keys={['itlP50', 'median (p50)', 'itlP99', 'worst 1% (p99)']} unit="ms" />
      </ChartCard>
    </div>
  );
}

// p50 / p90 / p99 as bars on a shared scale: the gap between them is the tail.
export function PercentileLadder({ rows }: { rows: { label: string; unit: string; p50?: number; p90?: number; p99?: number }[] }) {
  return (
    <div className="space-y-4">
      {rows.map((r) => {
        const max = Math.max(r.p50 ?? 0, r.p90 ?? 0, r.p99 ?? 0) || 1;
        const bars: [string, number | undefined, number][] = [
          ['p50', r.p50, 0.45],
          ['p90', r.p90, 0.7],
          ['p99', r.p99, 1],
        ];
        return (
          <div key={r.label}>
            <p className="text-xs font-medium mb-1.5">{r.label}</p>
            <div className="space-y-1">
              {bars.map(([name, v, opacity]) => (
                <div key={name} className="flex items-center gap-2 text-[11px]">
                  <span className="w-7 text-muted tabular-nums">{name}</span>
                  <div className="flex-1 h-3.5 rounded bg-hover overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{ width: `${v ? Math.max(2, (v / max) * 100) : 0}%`, backgroundColor: seriesColor(0), opacity }}
                    />
                  </div>
                  <span className="w-20 text-right tabular-nums">
                    {fmt(v)} <span className="text-muted">{r.unit}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface CompareSeries {
  name: string;
  points: { c: number; v: number | null }[];
}

// One metric across runs, matched by concurrency level.
export function CompareChart({ title, subtitle, unit, series }: { title: string; subtitle?: string; unit: string; series: CompareSeries[] }) {
  const levels = [...new Set(series.flatMap((s) => s.points.map((p) => p.c)))].sort((a, b) => a - b);
  const data = levels.map((c) => {
    const row: Record<string, number | null> = { c };
    series.forEach((s, i) => {
      row[`s${i}`] = s.points.find((p) => p.c === c)?.v ?? null;
    });
    return row;
  });
  const single = levels.length === 1;
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="c" type="category" tick={tick} tickLine={false} axisLine={axisLine} />
          <YAxis tick={tick} tickLine={false} axisLine={false} width={44} />
          <Tooltip {...tooltipStyle} labelFormatter={(c) => `Concurrency ${c}`} formatter={(v, name) => [`${fmt(Number(v))} ${unit}`, name]} />
          <Legend wrapperStyle={legendStyle} iconType="plainline" formatter={legendText} />
          {series.map((s, i) => (
            <Line
              key={i}
              name={s.name}
              dataKey={`s${i}`}
              stroke={seriesColor(i)}
              strokeWidth={2}
              dot={{ r: single ? 6 : 4, strokeWidth: 0, fill: seriesColor(i) }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
