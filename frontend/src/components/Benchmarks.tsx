import { useEffect, useState } from 'react';
import BenchNewRun from './BenchNewRun';
import BenchRunView from './BenchRunView';
import BenchHistory from './BenchHistory';
import BenchCompare from './BenchCompare';
import type { BenchRun } from '../types';

type Page =
  | { kind: 'new'; seed: BenchRun | null }
  | { kind: 'history'; preselect: string | null }
  | { kind: 'run'; id: string }
  | { kind: 'compare'; ids: string[] };

interface Props {
  activeRunId: string | null;
  // Set when another page asks to show a given run (the header's "running" chip).
  focusRunId: string | null;
  onOpenGb10: () => void;
}

export default function Benchmarks({ activeRunId, focusRunId, onOpenGb10 }: Props) {
  const [page, setPage] = useState<Page>(() =>
    focusRunId ? { kind: 'run', id: focusRunId } : activeRunId ? { kind: 'run', id: activeRunId } : { kind: 'new', seed: null },
  );

  useEffect(() => {
    if (focusRunId) setPage({ kind: 'run', id: focusRunId });
  }, [focusRunId]);

  const tab = page.kind === 'new' ? 'new' : 'results';
  const tabs: { id: 'new' | 'results'; label: string; go: () => void }[] = [
    { id: 'new', label: 'New benchmark', go: () => setPage({ kind: 'new', seed: null }) },
    { id: 'results', label: 'Results', go: () => setPage({ kind: 'history', preselect: null }) },
  ];

  return (
    <div className="p-6 lg:p-8">
      <div className="flex gap-1.5 border-b border-line mb-6 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={t.go}
            className={`px-3.5 h-9 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {page.kind === 'new' && (
        <BenchNewRun
          key={page.seed?.id ?? 'fresh'}
          seed={page.seed}
          activeRunId={activeRunId}
          onOpenGb10={onOpenGb10}
          onStarted={(id) => setPage({ kind: 'run', id })}
        />
      )}
      {page.kind === 'history' && (
        <BenchHistory
          preselect={page.preselect}
          onOpen={(id) => setPage({ kind: 'run', id })}
          onCompare={(ids) => setPage({ kind: 'compare', ids })}
          onNew={() => setPage({ kind: 'new', seed: null })}
        />
      )}
      {page.kind === 'run' && (
        <BenchRunView
          key={page.id}
          runId={page.id}
          onBack={() => setPage({ kind: 'history', preselect: null })}
          onRerun={(run) => setPage({ kind: 'new', seed: run })}
          onCompare={(id) => setPage({ kind: 'history', preselect: id })}
        />
      )}
      {page.kind === 'compare' && (
        <BenchCompare ids={page.ids} onBack={() => setPage({ kind: 'history', preselect: null })} onOpen={(id) => setPage({ kind: 'run', id })} />
      )}
    </div>
  );
}
