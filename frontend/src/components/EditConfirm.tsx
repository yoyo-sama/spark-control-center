import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import type { PreviewResult } from '../types';

const API_BASE = '/api';

interface Props {
  appId: string;
  preview: PreviewResult;
  onClose: () => void;
  onApplied: () => void;
}

const diffLineClass = {
  context: 'text-muted',
  removed: 'text-red-600 dark:text-red-400 bg-red-500/10',
  added: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
} as const;

const diffPrefix = { context: ' ', removed: '-', added: '+' } as const;

export default function EditConfirm({ appId, preview, onClose, onApplied }: Props) {
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [result, setResult] = useState<{ backup: string } | null>(null);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartDone, setRestartDone] = useState(false);

  const handleApply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch(`${API_BASE}/apps/${appId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: preview.token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to apply');
      setResult({ backup: data.backup });
      onApplied();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Failed to apply');
    } finally {
      setApplying(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      const res = await fetch(`${API_BASE}/containers/${preview.restart.containerName}/restart`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to restart');
      setRestartDone(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to restart');
    } finally {
      setRestarting(false);
      setShowRestartConfirm(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="bg-elevated border border-line rounded-xl shadow-2xl w-full max-w-2xl mx-4 p-6 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold tracking-tight mb-1">Confirm change</h2>
        <p className="text-sm text-muted mb-4">{preview.summary}</p>

        <div className="rounded-lg border border-line font-mono text-xs overflow-x-auto mb-4">
          {preview.diff.map((d, i) => (
            <div key={i} className={`px-3 py-0.5 whitespace-pre ${diffLineClass[d.kind]}`}>
              <span className="inline-block w-6 text-muted select-none">{d.line ?? ''}</span>
              {diffPrefix[d.kind]} {d.text}
            </div>
          ))}
        </div>

        {preview.warnings.length > 0 && (
          <div className="mb-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm">
            {preview.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        )}

        {applyError && (
          <div className="mb-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            {applyError}
          </div>
        )}

        {result ? (
          <div className="space-y-3">
            <p className="text-sm">
              File written. Backup: <code className="font-mono text-xs">{result.backup}</code>
            </p>

            {preview.restart.kind === 'restart' && (
              <div>
                {restartDone ? (
                  <p className="text-sm text-emerald-600 dark:text-emerald-400">Container restarted.</p>
                ) : (
                  <button
                    onClick={() => setShowRestartConfirm(true)}
                    className="px-4 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-colors"
                  >
                    Restart container
                  </button>
                )}
              </div>
            )}

            {preview.restart.kind === 'none' && (
              <p className="text-sm text-muted">{preview.restart.cost}</p>
            )}

            {preview.restart.kind === 'recreate' && (
              <div>
                <p className="text-sm text-muted mb-2">
                  A plain restart does not re-read <code className="font-mono text-xs">compose.yaml</code>:
                  the container must be recreated.
                </p>
                <code className="block font-mono text-xs bg-hover rounded-lg p-3 select-all">
                  cd {preview.restart.cwd} && {preview.restart.command}
                </code>
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2.5">
            <button
              onClick={onClose}
              disabled={applying}
              className="px-4 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={applying}
              className="px-4 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-colors inline-flex items-center gap-2 disabled:opacity-50"
            >
              {applying && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
              Write file
            </button>
          </div>
        )}
      </div>

      {showRestartConfirm && (
        <ConfirmModal
          title="Restart the container?"
          message={preview.restart.cost || 'The container is about to restart.'}
          confirmLabel="Restart"
          onConfirm={handleRestart}
          onCancel={() => setShowRestartConfirm(false)}
        />
      )}
      {restarting && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30">
          <Loader2 size={24} strokeWidth={2} className="animate-spin text-white" />
        </div>
      )}
    </div>
  );
}
