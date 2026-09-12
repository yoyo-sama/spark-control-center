import { useEffect, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import EditConfirm from './EditConfirm';
import type { AppState, PreviewResult } from '../types';

const API_BASE = '/api';

const cardClass = 'bg-surface border border-line rounded-xl p-4';
const buttonClass =
  'px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2';

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        checked ? 'bg-accent' : 'bg-hover'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export default function ComfyUiPanel({ appId }: { appId: string }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkedFlags, setCheckedFlags] = useState<Record<string, boolean>>({});
  const [freeText, setFreeText] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load the app');
      setState(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load the app');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSeeded(false);
    setState(null);
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  useEffect(() => {
    if (state && !seeded) {
      const known: Record<string, boolean> = {};
      for (const k of state.cmdline.known) known[k.flag] = state.cmdline.flags.includes(k.flag);
      setCheckedFlags(known);
      const knownFlagSet = new Set(state.cmdline.known.map((k) => k.flag));
      setFreeText(state.cmdline.flags.filter((f) => !knownFlagSet.has(f)).join(' '));
      setSeeded(true);
    }
  }, [state, seeded]);

  if (loading && !state) {
    return (
      <div className="flex-1 flex items-center justify-center py-16">
        <Loader2 size={20} strokeWidth={2} className="animate-spin text-muted" />
      </div>
    );
  }

  if (loadError || !state) {
    return (
      <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
        {loadError || 'App not found'}
      </div>
    );
  }

  const buildRaw = () => {
    const flags = state.cmdline.known.filter((k) => checkedFlags[k.flag]).map((k) => k.flag);
    return [...flags, freeText.trim()].filter(Boolean).join(' ');
  };

  const previewCmdline = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'cmdline', value: buildRaw() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to preview');
      setPreview(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview');
    } finally {
      setPreviewing(false);
    }
  };

  const previewScript = async (name: string, enabled: boolean) => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'script', name, enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to preview');
      setPreview(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview');
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Command line</h3>
        <p className="text-xs text-muted mb-3 font-mono break-all">{state.cmdline.raw}</p>
        <div className="space-y-2 mb-3">
          {state.cmdline.known.map((k) => (
            <div key={k.flag} className="flex items-start gap-2.5">
              <input
                type="checkbox"
                id={`flag-${k.flag}`}
                checked={!!checkedFlags[k.flag]}
                onChange={(e) => setCheckedFlags((prev) => ({ ...prev, [k.flag]: e.target.checked }))}
                className="mt-1"
              />
              <label htmlFor={`flag-${k.flag}`} className="text-sm">
                <span className="font-medium">{k.label}</span>{' '}
                <span className="text-muted font-mono text-xs">{k.flag}</span>
                <p className="text-xs text-muted">{k.why}</p>
                {/* Un drapeau avec danger non nul (ex: --highvram, "NUISIBLE en mémoire unifiée") est
                    signalé en rouge ici, avant même l'aperçu — data-driven depuis cmdline.known. */}
                {k.danger && (
                  <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1 mt-0.5">
                    <TriangleAlert size={12} strokeWidth={2} />
                    {k.danger}
                  </p>
                )}
              </label>
            </div>
          ))}
        </div>
        <label className="block text-xs font-medium text-muted uppercase tracking-wide mb-1.5" htmlFor="cmdline-free">
          Rest of the line
        </label>
        <input
          id="cmdline-free"
          type="text"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          className="w-full h-9 px-2.5 rounded-lg border border-line bg-base text-sm font-mono mb-3"
        />
        <button onClick={previewCmdline} disabled={previewing} className={buttonClass}>
          {previewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
          Preview
        </button>
      </div>

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Startup scripts</h3>
        <div className="space-y-2">
          {state.scripts.map((s) => (
            <div key={s.name} className="py-2 border-b border-line last:border-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-mono">{s.name}</span>
                <Toggle checked={s.enabled} onChange={() => previewScript(s.name, !s.enabled)} disabled={previewing} />
              </div>
              {s.note && <p className="text-xs text-muted mt-1">{s.note}</p>}
            </div>
          ))}
        </div>
      </div>

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Environment variables</h3>
        <div className="space-y-1">
          {Object.entries(state.env).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-3 text-sm py-1">
              <span className="font-mono text-xs text-muted">{key}</span>
              <span className="font-mono text-xs">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {previewError && (
        <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
          {previewError}
        </div>
      )}

      {preview && (
        <EditConfirm
          appId={appId}
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={() => {
            setSeeded(false);
            load();
          }}
        />
      )}
    </div>
  );
}
