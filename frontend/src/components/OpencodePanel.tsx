import { useEffect, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import EditConfirm from './EditConfirm';
import type { OpencodeCompaction, OpencodeState, PreviewResult } from '../types';

const API_BASE = '/api';

const cardClass = 'bg-surface border border-line rounded-xl p-4';
const buttonClass =
  'px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2';
const inputClass = 'h-9 px-2.5 rounded-lg border border-line bg-base text-sm';
const labelClass = 'block text-xs font-medium text-muted uppercase tracking-wide mb-1.5';

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

export default function OpencodePanel({ appId, onOpenApp }: { appId: string; onOpenApp?: (appId: string) => void }) {
  const [state, setState] = useState<OpencodeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  const [modelValue, setModelValue] = useState('');
  const [contextValue, setContextValue] = useState(0);
  const [compaction, setCompaction] = useState<OpencodeCompaction | null>(null);
  const [skillPaths, setSkillPaths] = useState<string[]>([]);
  const [skillUrls, setSkillUrls] = useState<string[]>([]);
  const [newSkillPath, setNewSkillPath] = useState('');
  const [newSkillUrl, setNewSkillUrl] = useState('');

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
      setModelValue(state.model);
      setContextValue(state.models[0]?.context ?? 0);
      setCompaction(state.compaction);
      setSkillPaths(state.skills?.paths ?? []);
      setSkillUrls(state.skills?.urls ?? []);
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

  if (loadError || !state || !compaction) {
    return (
      <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
        {loadError || 'App not found'}
      </div>
    );
  }

  const previewModel = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'model', value: modelValue }),
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

  const previewContext = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'context', value: contextValue }),
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

  const previewCompaction = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'compaction', value: compaction }),
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

  const previewSkillPaths = async (paths: string[]) => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'skillPaths', value: paths }),
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

  const previewSkillUrls = async (urls: string[]) => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'skillUrls', value: urls }),
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

  const selectedModel = state.models.find((m) => `ollama/${m.id}` === modelValue);
  const contextMismatch = state.ollama.contextLength != null && contextValue !== state.ollama.contextLength;

  return (
    <div className="space-y-4">
      {onOpenApp && (
        <button
          onClick={() => onOpenApp('claude-code')}
          className="px-3 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-colors"
        >
          Skills
        </button>
      )}

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Default model</h3>
        <label className={labelClass} htmlFor="opencode-model">
          Model
        </label>
        <select
          id="opencode-model"
          value={modelValue}
          onChange={(e) => setModelValue(e.target.value)}
          className={`${inputClass} w-full mb-2`}
        >
          {state.models.map((m) => (
            <option key={m.id} value={`ollama/${m.id}`}>
              {m.name}
              {!m.servedByOllama ? ' (not served)' : ''}
            </option>
          ))}
        </select>
        {selectedModel && !selectedModel.servedByOllama && (
          <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-3">
            <TriangleAlert size={12} strokeWidth={2} />
            This model is not currently served by Ollama.
          </p>
        )}
        <button onClick={previewModel} disabled={previewing} className={buttonClass}>
          {previewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
          Preview
        </button>
      </div>

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Context window</h3>
        <div className="flex items-end gap-4 mb-3">
          <div>
            <label className={labelClass} htmlFor="opencode-context">
              Context length
            </label>
            <input
              id="opencode-context"
              type="number"
              value={contextValue}
              onChange={(e) => setContextValue(Number(e.target.value))}
              className={`${inputClass} w-40`}
            />
          </div>
          <p className="text-xs text-muted pb-2">
            Ollama serves: {state.ollama.contextLength ?? 'unknown'}
          </p>
        </div>
        {contextMismatch && (
          <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-3">
            <TriangleAlert size={12} strokeWidth={2} />
            This differs from what Ollama currently serves ({state.ollama.contextLength}).
          </p>
        )}
        <button onClick={previewContext} disabled={previewing} className={buttonClass}>
          {previewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
          Preview
        </button>
      </div>

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Compaction</h3>
        <div className="space-y-3 mb-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Auto-compact</span>
            <Toggle checked={compaction.auto} onChange={() => setCompaction({ ...compaction, auto: !compaction.auto })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Prune</span>
            <Toggle checked={compaction.prune} onChange={() => setCompaction({ ...compaction, prune: !compaction.prune })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Preserve system prompt</span>
            <Toggle
              checked={compaction.preserveSystemPrompt}
              onChange={() => setCompaction({ ...compaction, preserveSystemPrompt: !compaction.preserveSystemPrompt })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="opencode-threshold">
                Threshold
              </label>
              <input
                id="opencode-threshold"
                type="number"
                step={0.05}
                value={compaction.threshold}
                onChange={(e) => setCompaction({ ...compaction, threshold: Number(e.target.value) })}
                className={`${inputClass} w-full`}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="opencode-reserved">
                Reserved
              </label>
              <input
                id="opencode-reserved"
                type="number"
                value={compaction.reserved}
                onChange={(e) => setCompaction({ ...compaction, reserved: Number(e.target.value) })}
                className={`${inputClass} w-full`}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="opencode-preserve-recent">
                Preserve recent messages
              </label>
              <input
                id="opencode-preserve-recent"
                type="number"
                value={compaction.preserveRecentMessages}
                onChange={(e) => setCompaction({ ...compaction, preserveRecentMessages: Number(e.target.value) })}
                className={`${inputClass} w-full`}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="opencode-strategy">
                Strategy
              </label>
              <select
                id="opencode-strategy"
                value={compaction.strategy}
                onChange={(e) => setCompaction({ ...compaction, strategy: e.target.value as OpencodeCompaction['strategy'] })}
                className={`${inputClass} w-full`}
              >
                <option value="summarize">summarize</option>
                <option value="truncate">truncate</option>
              </select>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted mb-3">
          Compaction summarizes the conversation history once it approaches the threshold. Reserved is the
          share of the context window kept free for the response and tool results.
        </p>
        <button onClick={previewCompaction} disabled={previewing} className={buttonClass}>
          {previewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
          Preview
        </button>
      </div>

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Skill sources</h3>
        <p className="text-xs text-muted mb-3">
          <code className="font-mono">~/.claude/skills</code> and <code className="font-mono">~/.agents/skills</code>{' '}
          are loaded automatically and do not need to be listed here.
        </p>

        <label className={labelClass}>Skill paths</label>
        <ul className="space-y-1.5 mb-2">
          {skillPaths.map((p, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="flex-1 font-mono text-xs truncate">{p}</span>
              <button
                onClick={() => setSkillPaths(skillPaths.filter((_, idx) => idx !== i))}
                className="px-2 h-7 rounded-lg border border-line text-xs hover:bg-hover transition-colors"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 mb-2">
          <input
            value={newSkillPath}
            onChange={(e) => setNewSkillPath(e.target.value)}
            placeholder="/abs/path/to/skills"
            className={`${inputClass} flex-1`}
          />
          <button
            onClick={() => {
              if (!newSkillPath.trim()) return;
              setSkillPaths([...skillPaths, newSkillPath.trim()]);
              setNewSkillPath('');
            }}
            className={buttonClass}
          >
            Add
          </button>
        </div>
        <button onClick={() => previewSkillPaths(skillPaths)} disabled={previewing} className={`${buttonClass} mb-4`}>
          {previewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
          Preview
        </button>

        <label className={labelClass}>Skill URLs</label>
        <ul className="space-y-1.5 mb-2">
          {skillUrls.map((u, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="flex-1 font-mono text-xs truncate">{u}</span>
              <button
                onClick={() => setSkillUrls(skillUrls.filter((_, idx) => idx !== i))}
                className="px-2 h-7 rounded-lg border border-line text-xs hover:bg-hover transition-colors"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 mb-2">
          <input
            value={newSkillUrl}
            onChange={(e) => setNewSkillUrl(e.target.value)}
            placeholder="https://..."
            className={`${inputClass} flex-1`}
          />
          <button
            onClick={() => {
              if (!newSkillUrl.trim()) return;
              setSkillUrls([...skillUrls, newSkillUrl.trim()]);
              setNewSkillUrl('');
            }}
            className={buttonClass}
          >
            Add
          </button>
        </div>
        <button onClick={() => previewSkillUrls(skillUrls)} disabled={previewing} className={buttonClass}>
          {previewing && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
          Preview
        </button>
      </div>

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Instructions</h3>
        {state.instructions && state.instructions.length > 0 ? (
          <ul className="text-sm space-y-1 mb-2">
            {state.instructions.map((instr, i) => (
              <li key={i} className="font-mono text-xs">{instr}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted mb-2">No instructions configured.</p>
        )}
        {state.agentsFile?.exists && (
          <p className="text-sm text-muted">
            AGENTS.md — <span className="font-mono text-xs">{state.agentsFile.path}</span> ({state.agentsFile.lines}{' '}
            lines)
          </p>
        )}
      </div>

      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Declared models</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-muted uppercase tracking-wide">
                <th className="py-1.5 pr-3">ID</th>
                <th className="py-1.5 pr-3">Name</th>
                <th className="py-1.5 pr-3">Context</th>
                <th className="py-1.5 pr-3">Output</th>
                <th className="py-1.5 pr-3">Served</th>
              </tr>
            </thead>
            <tbody>
              {state.models.map((m) => (
                <tr key={m.id} className="border-t border-line">
                  <td className="py-1.5 pr-3 font-mono text-xs">{m.id}</td>
                  <td className="py-1.5 pr-3">{m.name}</td>
                  <td className="py-1.5 pr-3">{m.context}</td>
                  <td className="py-1.5 pr-3">{m.output}</td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs ${
                        m.servedByOllama
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {m.servedByOllama ? 'served' : 'not served'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
