import { useEffect, useState } from 'react';
import type { Insight } from '../types';

const SEVERITY_BADGE: Record<Insight['severity'], string> = {
  high: 'bg-red-500/10 text-red-600 dark:text-red-400',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  low: 'bg-hover text-muted',
};

export default function Insights({ onOpenApp }: { onOpenApp?: (appId: string) => void }) {
  const [insights, setInsights] = useState<Insight[]>([]);

  useEffect(() => {
    fetch('/api/insights')
      .then((res) => (res.ok ? res.json() : { insights: [] }))
      .then((data) => setInsights(data.insights ?? []))
      .catch(() => {});
  }, []);

  if (insights.length === 0) {
    return <p className="text-sm text-muted mb-6">Nothing actionable right now</p>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      {insights.map((insight) => (
        <div key={insight.id} className="bg-surface border border-line rounded-xl p-4">
          <div className="flex items-start justify-between gap-2 mb-2">
            <h3 className="text-sm font-semibold tracking-tight">{insight.title}</h3>
            <span
              className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide shrink-0 ${SEVERITY_BADGE[insight.severity]}`}
            >
              {insight.severity}
            </span>
          </div>
          <p className="text-xs text-muted leading-relaxed">{insight.why}</p>
          {insight.action !== null && onOpenApp && (
            <button
              onClick={() => onOpenApp(insight.action!.appId)}
              className="mt-3 px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
            >
              Open settings
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
