import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import LogView, { type LogEntry } from './LogView';

interface Props {
  deployId: string;
  onDone: () => void;
}

export default function DeployLog({ deployId, onDone }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<string>('running');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/events/deploy/${deployId}`);

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'status') {
        setStatus(data.text);
        if (data.text !== 'running') {
          es.close();
        }
      } else {
        setLogs(prev => [...prev, data]);
      }
    };

    es.onerror = () => {
      setStatus('error');
      es.close();
    };

    return () => es.close();
  }, [deployId]);

  const handleCopyLogs = async () => {
    const text = logs.map(l => l.text).join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusLabel = status === 'running' ? 'In progress' : status === 'success' ? 'Completed' : 'Failed';
  const statusColor =
    status === 'success'
      ? 'text-emerald-600 dark:text-emerald-400'
      : status === 'error'
        ? 'text-red-500'
        : 'text-sky-600 dark:text-sky-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Deploy logs">
      <div className="bg-elevated border border-line rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] mx-4 flex flex-col">
        <div className="px-6 h-16 border-b border-line flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold tracking-tight">Deploy logs</h2>
            <span className={`text-xs font-medium inline-flex items-center gap-1.5 ${statusColor}`}>
              {status === 'running' && <Loader2 size={12} className="animate-spin" />}
              {statusLabel}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCopyLogs}
              disabled={logs.length === 0}
              className="px-3 h-8 rounded-lg border border-line text-xs font-medium hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
            >
              {copied ? 'Copied!' : 'Copy logs'}
            </button>
            <button
              onClick={onDone}
              className="px-3 h-8 rounded-lg border border-line text-xs font-medium hover:bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
            >
              Close
            </button>
          </div>
        </div>
        <LogView logs={logs} running={status === 'running'} className="flex-1 px-6 py-4" />
      </div>
    </div>
  );
}
