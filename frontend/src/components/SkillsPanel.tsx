import { useEffect, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import type { PreviewResult, SkillEntry, SkillsListResponse } from '../types';
import EditConfirm from './EditConfirm';

const API_BASE = '/api';

const cardClass = 'bg-surface border border-line rounded-xl p-4';
const buttonClass =
  'px-3 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2';
const inputClass = 'h-9 px-2.5 rounded-lg border border-line bg-base text-sm';
const labelClass = 'block text-xs font-medium text-muted uppercase tracking-wide mb-1.5';
const warnClass =
  'text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5 mt-2';

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

export default function SkillsPanel() {
  const [data, setData] = useState<SkillsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [editingName, setEditingName] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newContent, setNewContent] = useState('');

  const [showImport, setShowImport] = useState(false);
  const [importMode, setImportMode] = useState<'url' | 'file'>('url');
  const [importName, setImportName] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importFileContent, setImportFileContent] = useState('');
  const [importFileName, setImportFileName] = useState('');

  const load = async () => {
    try {
      const res = await fetch(`${API_BASE}/skills`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load skills');
      setData(json);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const runPreview = async (body: Record<string, unknown>, actionKey: string) => {
    setBusyAction(actionKey);
    setPreviewError(null);
    try {
      const res = await fetch(`${API_BASE}/skills/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to preview');
      setPreview(json);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview');
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggle = (skill: SkillEntry) => {
    runPreview({ target: 'toggle', name: skill.name, enabled: !skill.enabled }, `toggle:${skill.name}`);
  };

  const openEdit = async (skill: SkillEntry) => {
    setEditingName(skill.name);
    setEditContent('');
    setEditLoading(true);
    try {
      const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(skill.name)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load skill');
      setEditContent(json.content || '');
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load skill');
      setEditingName(null);
    } finally {
      setEditLoading(false);
    }
  };

  const handlePreviewEdit = () => {
    if (!editingName) return;
    runPreview({ target: 'content', name: editingName, value: editContent }, 'edit');
  };

  const handlePreviewNew = () => {
    runPreview({ target: 'create', name: newName, description: newDescription, value: newContent }, 'new');
  };

  const handlePreviewImport = () => {
    if (importMode === 'url') {
      runPreview({ target: 'import', name: importName, url: importUrl }, 'import');
    } else {
      runPreview({ target: 'import', name: importName, value: importFileContent }, 'import');
    }
  };

  const handleFilePicked = (file: File | null) => {
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setImportFileContent(String(reader.result || ''));
    reader.readAsText(file);
  };

  const afterApplied = () => {
    setEditingName(null);
    setShowNew(false);
    setShowImport(false);
    load();
  };

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center py-16">
        <Loader2 size={20} strokeWidth={2} className="animate-spin text-muted" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
        {loadError || 'Skills not available'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={cardClass}>
        <h3 className="text-sm font-semibold tracking-tight mb-3">Scanned roots</h3>
        <ul className="space-y-1 text-sm">
          {data.roots.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="font-medium">{r.id}</span>
              <span className="font-mono text-xs text-muted">{r.path}</span>
              {!r.exists && <span className="text-xs text-muted">not found</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-2.5">
        <button onClick={() => setShowNew((v) => !v)} className={buttonClass}>
          New skill
        </button>
        <button onClick={() => setShowImport((v) => !v)} className={buttonClass}>
          Import
        </button>
      </div>

      {showNew && (
        <div className={cardClass}>
          <h3 className="text-sm font-semibold tracking-tight mb-3">New skill</h3>
          <label className={labelClass} htmlFor="skill-new-name">
            Name
          </label>
          <input
            id="skill-new-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={`${inputClass} w-full mb-3`}
          />
          <label className={labelClass} htmlFor="skill-new-description">
            Description
          </label>
          <input
            id="skill-new-description"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            className={`${inputClass} w-full mb-3`}
          />
          <label className={labelClass} htmlFor="skill-new-content">
            Content (SKILL.md)
          </label>
          <textarea
            id="skill-new-content"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={10}
            className="w-full rounded-lg border border-line bg-base text-sm font-mono p-3 mb-3"
          />
          <button onClick={handlePreviewNew} disabled={busyAction === 'new'} className={buttonClass}>
            {busyAction === 'new' && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
            Preview
          </button>
        </div>
      )}

      {showImport && (
        <div className={cardClass}>
          <h3 className="text-sm font-semibold tracking-tight mb-3">Import skill</h3>
          <div className="flex gap-1.5 mb-3">
            <button
              onClick={() => setImportMode('url')}
              className={`px-3 h-8 rounded-lg text-xs font-medium border ${
                importMode === 'url' ? 'border-accent text-accent' : 'border-line text-muted'
              }`}
            >
              From URL
            </button>
            <button
              onClick={() => setImportMode('file')}
              className={`px-3 h-8 rounded-lg text-xs font-medium border ${
                importMode === 'file' ? 'border-accent text-accent' : 'border-line text-muted'
              }`}
            >
              From file
            </button>
          </div>
          <label className={labelClass} htmlFor="skill-import-name">
            Name
          </label>
          <input
            id="skill-import-name"
            value={importName}
            onChange={(e) => setImportName(e.target.value)}
            className={`${inputClass} w-full mb-3`}
          />
          {importMode === 'url' ? (
            <>
              <label className={labelClass} htmlFor="skill-import-url">
                URL (https://)
              </label>
              <input
                id="skill-import-url"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                className={`${inputClass} w-full mb-3`}
              />
            </>
          ) : (
            <>
              <label className={labelClass} htmlFor="skill-import-file">
                File
              </label>
              <input
                id="skill-import-file"
                type="file"
                onChange={(e) => handleFilePicked(e.target.files?.[0] ?? null)}
                className="text-sm mb-1.5 block"
              />
              {importFileName && <p className="text-xs text-muted mb-3">{importFileName} read locally.</p>}
            </>
          )}
          <button onClick={handlePreviewImport} disabled={busyAction === 'import'} className={buttonClass}>
            {busyAction === 'import' && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
            Preview
          </button>
        </div>
      )}

      <div className="space-y-3">
        {data.skills.map((skill) => {
          const isSymlink = !!skill.symlink;
          return (
            <div key={`${skill.root}/${skill.name}`} className={cardClass}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold tracking-tight">{skill.name}</span>
                    <span className="px-2 py-0.5 rounded-full text-xs bg-hover text-muted">{skill.root}</span>
                    <span className="text-xs text-muted">{skill.lines} lines</span>
                  </div>
                  <p className="text-sm text-muted mt-1">{skill.description}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Toggle checked={skill.enabled} onChange={() => handleToggle(skill)} disabled={isSymlink} />
                  <button onClick={() => openEdit(skill)} disabled={isSymlink} className={buttonClass}>
                    Edit
                  </button>
                </div>
              </div>

              {skill.duplicateIn.length > 0 && (
                <p className={warnClass}>
                  <TriangleAlert size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
                  Also present in: {skill.duplicateIn.join(', ')}. opencode and Claude Code may not resolve the
                  same copy — editing one will not affect the other.
                </p>
              )}

              {isSymlink && (
                <p className={warnClass}>
                  <TriangleAlert size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
                  Symlink into {skill.symlink} — editing it would modify that plugin.
                </p>
              )}

              {editingName === skill.name && (
                <div className="mt-3 border-t border-line pt-3">
                  {editLoading ? (
                    <Loader2 size={16} strokeWidth={2} className="animate-spin text-muted" />
                  ) : (
                    <>
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={14}
                        className="w-full rounded-lg border border-line bg-base text-sm font-mono p-3 mb-3"
                      />
                      <div className="flex gap-2.5">
                        <button
                          onClick={handlePreviewEdit}
                          disabled={busyAction === 'edit'}
                          className={buttonClass}
                        >
                          {busyAction === 'edit' && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
                          Preview
                        </button>
                        <button onClick={() => setEditingName(null)} className={buttonClass}>
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {previewError && (
        <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
          {previewError}
        </div>
      )}

      {preview && <EditConfirm applyUrl="/api/skills/apply" preview={preview} onClose={() => setPreview(null)} onApplied={afterApplied} />}
    </div>
  );
}
