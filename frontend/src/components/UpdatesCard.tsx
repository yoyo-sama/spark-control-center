import { useEffect, useState } from 'react';
import type { UpdatesState } from '../types';

const API_BASE = '/api';

function fmtCheckedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function UpdatesCard() {
  const [state, setState] = useState<UpdatesState | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/updates`);
        if (!res.ok) throw new Error('failed to load updates');
        setState(await res.json());
      } catch {
        setFailed(true);
      }
    };
    load();
  }, []);

  // No error banner on failure per spec: the card just doesn't render, rest of page unaffected.
  if (failed || !state || !state.summary) return null;

  const { summary, packages, pipelineInstalled, note } = state;

  if (summary.total === 0) {
    return (
      <div className="bg-surface border border-line rounded-xl p-4 mb-6">
        <p className="text-sm text-muted">System is up to date</p>
      </div>
    );
  }

  const shown = showAll ? packages : packages.slice(0, 10);
  const countsDiffer = packages.length > 0 && packages.length !== summary.total;

  return (
    <div className="bg-surface border border-line rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold tracking-tight">
          System updates <span className="tabular-nums">({summary.total})</span>
        </h2>
        {summary.security > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-500/10 text-red-600 dark:text-red-400">
            {summary.security} security
          </span>
        )}
      </div>

      <p className="text-xs text-muted mb-3">
        Last checked {fmtCheckedAt(summary.checkedAt)}
        {summary.esmEnabled ? ' · ESM updates included' : ''}
      </p>

      {!pipelineInstalled ? (
        note && (
          <div className="p-3 rounded-lg border border-line bg-hover text-sm text-muted mb-3">{note}</div>
        )
      ) : (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-medium text-muted uppercase tracking-wide">Packages</p>
            <span className="text-xs text-muted">{packages.length} listed</span>
          </div>
          {countsDiffer && (
            <p className="text-xs text-muted mb-1.5">
              Total ({summary.total}) differs from the list below — it also counts ESM and staged updates.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-muted uppercase tracking-wide">
                  <th className="py-1.5 pr-3">Package</th>
                  <th className="py-1.5 pr-3">Current → candidate</th>
                  <th className="py-1.5 pr-3">Origin</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.name} className="border-t border-line">
                    <td className="py-1.5 pr-3 font-mono text-xs">{p.name}</td>
                    <td className="py-1.5 pr-3 text-xs tabular-nums">
                      {p.current} → {p.candidate}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-muted">{p.origin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {packages.length > 10 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="mt-1.5 text-xs font-medium text-accent hover:underline"
            >
              {showAll ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      )}

      <p className="text-xs text-muted border-t border-line pt-3">
        Install from the DGX Dashboard or with apt; this console only reports.
      </p>
    </div>
  );
}
