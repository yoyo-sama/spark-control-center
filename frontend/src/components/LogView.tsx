import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

export interface LogEntry {
  type: string;
  text: string;
  time?: string;
}

const logColors: Record<string, string> = {
  error: 'text-red-500',
  cmd: 'text-amber-600 dark:text-amber-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-sky-600 dark:text-sky-400',
  output: 'text-muted',
};

interface Props {
  logs: LogEntry[];
  running: boolean;
  className?: string;
}

// Shared by the deploy log modal and the benchmark run view.
export default function LogView({ logs, running, className = '' }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Follow new lines only while the reader is at the bottom: scrolling up to read
  // an earlier line must not be yanked back down by the next one. Scrolls this box
  // only — scrollIntoView would also scroll the page around it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className={`overflow-y-auto font-mono text-xs leading-relaxed ${className}`}>
      {logs.length === 0 && running && <div className="text-muted">Waiting for logs...</div>}
      {logs.map((log, i) => (
        <div key={i} className={`whitespace-pre-wrap break-words ${logColors[log.type] ?? 'text-muted'}`}>
          {log.text}
        </div>
      ))}
      {running && logs.length > 0 && (
        <div className="inline-flex items-center gap-1.5 text-muted mt-1">
          <Loader2 size={11} className="animate-spin" />
          Running...
        </div>
      )}
    </div>
  );
}
