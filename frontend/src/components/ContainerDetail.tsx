import { useEffect, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Cpu, Loader2, MemoryStick, Pencil, SquareTerminal, Trash2 } from 'lucide-react';
import StatCard from './StatCard';
import MetricChart from './MetricChart';
import Terminal from './Terminal';
import EditConfirm from './EditConfirm';
import type { ContainerDetail, ContainerStats, ContainerHistoryPoint, PortBinding, PreviewResult } from '../types';

interface Props {
  containerId: string;
  onBack: () => void;
  onAction: (id: string, action: 'start' | 'stop' | 'restart') => void;
  onDelete: (id: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function ContainerDetail({ containerId, onBack, onAction, onDelete }: Props) {
  const [container, setContainer] = useState<ContainerDetail | null>(null);
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [history, setHistory] = useState<ContainerHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);
  const [editingPort, setEditingPort] = useState<string | null>(null);
  const [newPort, setNewPort] = useState('');
  const [portPreviewing, setPortPreviewing] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [portPreview, setPortPreview] = useState<PreviewResult | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [detailRes, statsRes] = await Promise.all([
          fetch(`/api/containers/${containerId}`),
          fetch(`/api/containers/${containerId}/stats`),
        ]);
        const detailData = await detailRes.json();
        const statsData = await statsRes.json();
        setContainer(detailData);
        setStats(statsData);
        if (!detailData.running) {
          setShowTerminal(false);
        }
        setHistory((prev) => [
          ...prev.slice(-59),
          {
            time: new Date().toISOString(),
            ...statsData,
          },
        ]);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [containerId]);

  if (loading && !container) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-line border-t-fg"></div>
      </div>
    );
  }

  if (!container) return null;

  // Driven by the CONFIGURED bindings, not NetworkSettings.Ports: the latter is empty
  // for a stopped container, which is exactly the container whose port needs changing.
  const bindings = container.portBindings ?? [];
  const keyOf = (b: PortBinding) => `${b.hostPort}:${b.containerPort}/${b.protocol}`;

  const startEdit = (b: PortBinding) => {
    setEditingPort(keyOf(b));
    setNewPort(b.hostPort);
    setPortError(null);
  };

  const previewPort = async (b: PortBinding) => {
    setPortPreviewing(true);
    setPortError(null);
    try {
      const res = await fetch(`/api/ports/${containerId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostPort: b.hostPort, containerPort: b.containerPort, newHostPort: Number(newPort) }),
      });
      const data = await res.json();
      // The refusals (interpolated ${VAR}, missing compose file, long syntax) ARE the
      // output for most containers here: show them, never swallow them.
      if (!res.ok) throw new Error(data.error || 'Failed to preview');
      setPortPreview(data);
      setEditingPort(null);
    } catch (err) {
      setPortError(err instanceof Error ? err.message : 'Failed to preview');
    } finally {
      setPortPreviewing(false);
    }
  };

  return (
    <div className="p-6 lg:p-8 overflow-y-auto">
      <button
        onClick={onBack}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20 rounded px-1 py-0.5"
      >
        <ArrowLeft size={15} strokeWidth={2} />
        Back to Dashboard
      </button>

      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <h1 className="text-xl font-semibold tracking-tight">{container.name}</h1>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <span className={`w-1.5 h-1.5 rounded-full ${container.running ? 'bg-emerald-500' : 'bg-red-500'}`} />
          <span className={container.running ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            {container.running ? 'Running' : 'Stopped'}
          </span>
        </span>
        <span className="font-mono text-[11px] text-muted">{container.shortId}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="CPU"
          value={(stats?.cpu_percent ?? 0).toFixed(1)}
          unit="%"
          color="blue"
          icon={<Cpu size={15} strokeWidth={2} />}
        />
        <StatCard
          title="Memory (CPU + GPU)"
          value={formatBytes(stats?.memory_usage_combined ?? 0)}
          unit={` (${(stats?.memory_percent_combined ?? 0).toFixed(1)}%)`}
          subtitle={`CPU ${formatBytes(stats?.memory_usage_bytes ?? 0)} · GPU ${formatBytes(stats?.vram_usage_bytes ?? 0)}`}
          color="green"
          icon={<MemoryStick size={15} strokeWidth={2} />}
        />
        <StatCard
          title="Network RX"
          value={formatBytes(stats?.network_rx_bytes ?? 0)}
          color="yellow"
          icon={<ArrowDown size={15} strokeWidth={2} />}
        />
        <StatCard
          title="Network TX"
          value={formatBytes(stats?.network_tx_bytes ?? 0)}
          color="purple"
          icon={<ArrowUp size={15} strokeWidth={2} />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <MetricChart
          title="CPU Usage"
          data={history}
          dataKey="cpu_percent"
          unit="%"
          color="#0ea5e9"
          yAxisDomain={[0, 100]}
        />
        <MetricChart
          title="Memory Usage"
          data={history}
          dataKey="memory_percent"
          unit="%"
          color="#10b981"
        />
      </div>

      <div className="bg-surface rounded-xl border border-line mb-6">
        <h2 className="text-sm font-semibold tracking-tight px-5 pt-4 pb-3 border-b border-line">Container Info</h2>
        <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div className="flex justify-between gap-4 min-w-0">
            <span className="text-muted shrink-0">Image</span>
            <span className="font-mono text-xs truncate self-center" title={container.image}>{container.image}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted shrink-0">Status</span>
            <span className="font-medium">{container.status}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted shrink-0">Restart policy</span>
            <span className="font-mono text-xs self-center">{container.restartPolicy || 'none'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted shrink-0">Started</span>
            <span className="tabular-nums">{new Date(container.startedAt).toLocaleString()}</span>
          </div>
          {bindings.length > 0 && (
            <div className="flex justify-between gap-4 min-w-0 md:col-span-2">
              <span className="text-muted shrink-0">Ports</span>
              <div className="min-w-0 space-y-1">
                {bindings.map((b) => (
                  <div key={keyOf(b)} className="flex items-center justify-end gap-2">
                    {editingPort === keyOf(b) ? (
                      <>
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          value={newPort}
                          autoFocus
                          onChange={(e) => setNewPort(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && previewPort(b)}
                          className="w-24 h-9 px-2.5 rounded-lg border border-line bg-base text-xs font-mono"
                          aria-label="New host port"
                        />
                        <span className="font-mono text-xs text-muted">→ {b.containerPort}/{b.protocol}</span>
                        <button
                          onClick={() => previewPort(b)}
                          disabled={portPreviewing}
                          className="px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors inline-flex items-center gap-2 disabled:opacity-50"
                        >
                          {portPreviewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
                          Preview
                        </button>
                        <button
                          onClick={() => setEditingPort(null)}
                          className="px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-xs leading-relaxed">
                          {b.hostPort || '(random)'} → {b.containerPort}/{b.protocol}
                        </span>
                        {b.hostPort && (
                          <button
                            onClick={() => startEdit(b)}
                            title="Change the published host port"
                            aria-label="Change the published host port"
                            className="p-1 rounded-lg text-muted hover:bg-hover hover:text-fg transition-colors"
                          >
                            <Pencil size={13} strokeWidth={2} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {portError && (
                  <p className="text-xs text-red-600 dark:text-red-400 max-w-prose ml-auto pt-1">{portError}</p>
                )}
              </div>
            </div>
          )}
          {container.command && container.command.length > 0 && (
            <div className="flex justify-between gap-4 min-w-0 md:col-span-2">
              <span className="text-muted shrink-0">Command</span>
              <span className="font-mono text-xs truncate self-center" title={container.command.join(' ')}>
                {container.command.join(' ')}
              </span>
            </div>
          )}
        </div>
      </div>

      {container.running && (
        <div className="bg-surface rounded-xl border border-line mb-6">
          <div className="flex justify-between items-center px-5 py-3 border-b border-line">
            <h2 className="text-sm font-semibold tracking-tight inline-flex items-center gap-2">
              <SquareTerminal size={15} strokeWidth={2} className="text-muted" />
              Terminal
            </h2>
            <button
              onClick={() => setShowTerminal((prev) => !prev)}
              className="px-3 h-8 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
            >
              {showTerminal ? 'Hide terminal' : 'Open terminal'}
            </button>
          </div>
          {showTerminal && (
            <div className="p-4">
              <Terminal containerId={containerId} />
            </div>
          )}
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        {container.running ? (
          <>
            <button
              onClick={() => onAction(containerId, 'stop')}
              className="px-4 h-9 rounded-lg border border-line text-sm font-medium text-amber-600 dark:text-amber-400 hover:bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
            >
              Stop
            </button>
            <button
              onClick={() => onAction(containerId, 'restart')}
              className="px-4 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
            >
              Restart
            </button>
          </>
        ) : (
          <button
            onClick={() => onAction(containerId, 'start')}
            className="px-4 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/30"
          >
            Start
          </button>
        )}
        <button
          onClick={() => onDelete(containerId)}
          className="px-4 h-9 rounded-lg border border-red-500/30 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
        >
          <Trash2 size={14} strokeWidth={2} />
          Delete
        </button>
      </div>

      {portPreview && (
        <EditConfirm
          applyUrl={`/api/ports/${containerId}/apply`}
          preview={portPreview}
          onClose={() => setPortPreview(null)}
          // Nothing to reload: the compose file changed, the container keeps its old
          // binding until `docker compose up -d` recreates it — which the modal says.
          onApplied={() => {}}
        />
      )}
    </div>
  );
}
