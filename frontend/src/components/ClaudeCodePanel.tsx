import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import SkillsPanel from './SkillsPanel';
import EditConfirm from './EditConfirm';
import type { ClaudeCodeState, PreviewResult } from '../types';

const API_BASE = '/api';
const APP_ID = 'claude-code';

const cardClass = 'bg-surface border border-line rounded-xl p-4';
const buttonClass =
  'px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2';
const inputClass = 'h-9 px-2.5 rounded-lg border border-line bg-base text-sm';

const TOGGLE_KEYS = new Set(['inputNeededNotifEnabled', 'agentPushNotifEnabled']);

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
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

function renderReadOnlyValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function ClaudeCodePanel() {
  const [state, setState] = useState<ClaudeCodeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Local edits for editableKeys in settings.json, seeded once from the loaded state.
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [seeded, setSeeded] = useState(false);
  const [showAllAllow, setShowAllAllow] = useState(false);

  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`${API_BASE}/apps/${APP_ID}`);
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
    load();
  }, []);

  const settingsJson = state?.settingsFiles?.find((f) => f.name === 'settings.json');
  const editableKeys = state?.editableKeys ?? [];

  useEffect(() => {
    if (settingsJson && !seeded) {
      const seed: Record<string, unknown> = {};
      for (const key of editableKeys) {
        seed[key] = settingsJson.values[key];
      }
      setEdited(seed);
      setSeeded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsJson, seeded]);

  const previewSetting = async (key: string, value: unknown) => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${APP_ID}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'setting', key, value }),
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

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Skills are shared: opencode loads <code className="font-mono text-xs">~/.claude/skills</code> and{' '}
        <code className="font-mono text-xs">~/.agents/skills</code> automatically.
      </p>

      {state.settingsFiles && state.settingsFiles.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
          {state.settingsFiles.map((file) => {
            // permissions.allow lives nested under values.permissions.allow per the API contract.
            const nestedPermissions = file.values.permissions as { allow?: string[] } | undefined;
            const allowList = file.name === 'settings.local.json' ? nestedPermissions?.allow : undefined;

            return (
              <div key={file.name} className={cardClass}>
                <h3 className="text-sm font-semibold tracking-tight mb-1">{file.name}</h3>
                <p className="text-xs text-muted font-mono mb-3">{file.path}</p>
                {!file.exists ? (
                  <p className="text-sm text-muted">File does not exist.</p>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(file.values).map(([key, value]) => {
                      if (file.name === 'settings.local.json' && key === 'permissions' && allowList) {
                        const shown = showAllAllow ? allowList : allowList.slice(0, 10);
                        return (
                          <div key={key}>
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-mono">permissions.allow</span>
                              <span className="text-xs text-muted">{allowList.length} entries</span>
                            </div>
                            <ul className="mt-1 space-y-0.5">
                              {shown.map((entry, i) => (
                                <li key={i} className="text-xs font-mono text-muted truncate">
                                  {entry}
                                </li>
                              ))}
                            </ul>
                            {allowList.length > 10 && (
                              <button
                                onClick={() => setShowAllAllow(!showAllAllow)}
                                className="mt-1.5 text-xs font-medium text-accent hover:underline"
                              >
                                {showAllAllow ? 'Show less' : 'Show all'}
                              </button>
                            )}
                          </div>
                        );
                      }

                      const isEditable = file.name === 'settings.json' && editableKeys.includes(key);
                      if (!isEditable) {
                        return (
                          <div key={key} className="flex items-center justify-between gap-3">
                            <span className="text-sm font-mono">{key}</span>
                            <span className="flex items-center gap-2">
                              <span className="text-xs text-muted font-mono truncate max-w-[24rem]">
                                {renderReadOnlyValue(value)}
                              </span>
                              <span className="text-[10px] uppercase tracking-wide text-muted border border-line rounded px-1.5 py-0.5">
                                read-only
                              </span>
                            </span>
                          </div>
                        );
                      }

                      const currentValue = edited[key];
                      return (
                        <div key={key} className="flex items-center justify-between gap-3">
                          <span className="text-sm font-mono">{key}</span>
                          <div className="flex items-center gap-2">
                            {TOGGLE_KEYS.has(key) ? (
                              <Toggle
                                checked={Boolean(currentValue)}
                                onChange={() => setEdited({ ...edited, [key]: !currentValue })}
                              />
                            ) : (
                              <input
                                value={typeof currentValue === 'string' ? currentValue : ''}
                                onChange={(e) => setEdited({ ...edited, [key]: e.target.value })}
                                className={`${inputClass} w-48`}
                              />
                            )}
                            <button
                              onClick={() => previewSetting(key, edited[key])}
                              disabled={previewing}
                              className={buttonClass}
                            >
                              {previewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
                              Preview
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {file.name === 'settings.json' && (
                  <p className="text-xs text-muted mt-3">
                    <code className="font-mono">permissions</code>, <code className="font-mono">hooks</code>,{' '}
                    <code className="font-mono">enabledPlugins</code> and{' '}
                    <code className="font-mono">extraKnownMarketplaces</code> are shown read-only on purpose: this
                    app has no authentication, and writing them would silently widen what Claude Code may execute.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {state.plugins && (
        <div className={cardClass}>
          <h2 className="text-sm font-semibold tracking-tight mb-3">Plugins</h2>
          {state.plugins.installed.length === 0 ? (
            <p className="text-sm text-muted">No plugin installed.</p>
          ) : (
            <div className="overflow-x-auto mb-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-muted uppercase tracking-wide">
                    <th className="py-1.5 pr-3">ID</th>
                    <th className="py-1.5 pr-3">Version</th>
                    <th className="py-1.5 pr-3">Scope</th>
                    <th className="py-1.5 pr-3">Installed at</th>
                    <th className="py-1.5 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {state.plugins.installed.map((p) => (
                    <tr key={p.id} className="border-t border-line">
                      <td className="py-1.5 pr-3 font-mono text-xs">{p.id}</td>
                      <td className="py-1.5 pr-3">{p.version}</td>
                      <td className="py-1.5 pr-3">{p.scope}</td>
                      <td className="py-1.5 pr-3 text-xs text-muted">{p.installedAt}</td>
                      <td className="py-1.5 pr-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs ${
                            state.plugins!.enabled[p.id]
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'bg-hover text-muted'
                          }`}
                        >
                          {state.plugins!.enabled[p.id] ? 'enabled' : 'disabled'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted">Marketplaces: {state.plugins.marketplaces.join(', ') || 'none'}</p>
        </div>
      )}

      {state.mcp && (
        <div className={cardClass}>
          <h2 className="text-sm font-semibold tracking-tight mb-3">MCP</h2>
          {state.mcp.configured.length === 0 ? (
            <p className="text-sm text-muted">{state.mcp.note}</p>
          ) : (
            <ul className="text-sm space-y-1">
              {state.mcp.configured.map((c, i) => (
                <li key={i} className="font-mono text-xs">
                  {JSON.stringify(c)}
                </li>
              ))}
            </ul>
          )}
          {state.mcp.pendingAuth && state.mcp.pendingAuth.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
                Provided by plugins, awaiting authentication
              </p>
              <ul className="space-y-0.5">
                {state.mcp.pendingAuth.map((id) => (
                  <li key={id} className="text-xs font-mono text-muted">
                    {id}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {state.hooks && (
        <div className={cardClass}>
          <h2 className="text-sm font-semibold tracking-tight mb-3">Hooks</h2>
          {!state.hooks.present ? (
            <p className="text-sm text-muted">No hook configured.</p>
          ) : (
            <ul className="space-y-1">
              {state.hooks.files.map((f) => (
                <li key={f} className="flex items-center justify-between gap-3">
                  <span className="text-xs font-mono text-muted">{f}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted border border-line rounded px-1.5 py-0.5">
                    read-only
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {previewError && (
        <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
          {previewError}
        </div>
      )}

      {preview && (
        <EditConfirm
          appId={APP_ID}
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={() => {
            setSeeded(false);
            load();
          }}
        />
      )}

      <SkillsPanel />
    </div>
  );
}
