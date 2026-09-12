import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import ComfyUiPanel from './ComfyUiPanel';
import OpencodePanel from './OpencodePanel';
import type { AppSummary } from '../types';

const API_BASE = '/api';

const PANELS: Record<string, (appId: string) => React.ReactNode> = {
  comfyui: (appId) => <ComfyUiPanel appId={appId} />,
  opencode: (appId) => <OpencodePanel appId={appId} />,
};

export default function Apps({ initialAppId }: { initialAppId?: string }) {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>(initialAppId);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/apps`);
        if (!res.ok) throw new Error(`Failed to load apps (${res.status})`);
        const data = await res.json();
        setApps(data.apps || []);
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load apps');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (initialAppId) setActiveId(initialAppId);
  }, [initialAppId]);

  useEffect(() => {
    if (!activeId && apps.length > 0) {
      setActiveId((apps.find((a) => a.detected) ?? apps[0]).id);
    }
  }, [apps, activeId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-16">
        <Loader2 size={20} strokeWidth={2} className="animate-spin text-muted" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-6">
        <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
          {loadError}
        </div>
      </div>
    );
  }

  const active = apps.find((a) => a.id === activeId);

  return (
    <div className="p-6 lg:p-8">
      <div className="flex gap-1.5 border-b border-line mb-6 overflow-x-auto">
        {apps.map((app) => (
          <button
            key={app.id}
            onClick={() => setActiveId(app.id)}
            className={`px-3.5 h-9 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              activeId === app.id
                ? 'border-accent text-fg'
                : 'border-transparent text-muted hover:text-fg'
            } ${!app.detected ? 'opacity-50' : ''}`}
          >
            {app.label}
          </button>
        ))}
      </div>

      {!active && <p className="text-sm text-muted">No apps.</p>}

      {active && !active.detected && (
        <p className="text-sm text-muted">{active.reason || 'App not detected.'}</p>
      )}

      {active && active.detected && (PANELS[active.id] ? PANELS[active.id](active.id) : (
        <p className="text-sm text-muted">Nothing to configure here yet.</p>
      ))}
    </div>
  );
}
