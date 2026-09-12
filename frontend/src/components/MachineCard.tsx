import type { MachineInfo } from '../types';

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

export default function MachineCard({ machine }: { machine: MachineInfo | null }) {
  if (!machine) return null;

  const chipLabel = machine.chip?.name ?? machine.platform?.name ?? null;
  const title = [machine.vendor, chipLabel].filter(Boolean).join(' ') || 'Machine';

  const serial = machine.serials.board ?? machine.serials.product ?? machine.serials.dgx ?? null;

  const platformBuild = machine.platform
    ? machine.platform.otaVersion && machine.platform.otaVersion !== machine.platform.swBuild
      ? [machine.platform.swBuild, machine.platform.otaVersion ? `OTA ${machine.platform.otaVersion}` : null]
          .filter(Boolean)
          .join(' · ')
      : machine.platform.swBuild
    : null;

  const gpus = machine.chip?.gpus ?? [];
  const interfaces = machine.network?.interfaces ?? [];

  const pairs: Array<{ label: string; value: string } | null> = [
    machine.model ? { label: 'Model', value: machine.model } : null,
    { label: 'Serial', value: serial ?? '__missing__' },
    machine.bios?.version ? { label: 'BIOS', value: machine.bios.version } : null,
    platformBuild ? { label: 'Platform build', value: platformBuild } : null,
    machine.os?.distro ? { label: 'OS', value: machine.os.distro } : null,
    machine.os?.arch ? { label: 'Architecture', value: machine.os.arch } : null,
    gpus.length === 1 && gpus[0].memoryTotalMb != null
      ? { label: 'GPU memory', value: `${(gpus[0].memoryTotalMb / 1024).toFixed(0)} GiB` }
      : null,
  ];

  return (
    <div className="bg-surface border border-line rounded-xl p-4 mb-6">
      <div className="mb-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {machine.platform?.prettyName && (
          <p className="text-xs text-muted">{machine.platform.prettyName}</p>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
        {pairs.map((p, i) =>
          p === null ? null : p.value === '__missing__' ? (
            <div key={p.label}>
              <p className="text-[11px] text-muted">{p.label}</p>
              <p className="text-sm text-muted">Not exposed by firmware</p>
            </div>
          ) : (
            <Pair key={p.label + i} label={p.label} value={p.value} />
          ),
        )}
      </div>

      {gpus.length > 1 && (
        <div className="border-t border-line pt-3 mb-3 space-y-1">
          {gpus.map((g) => (
            <div key={g.index} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted">GPU {g.index}</span>
              <span className="font-medium">
                {g.name}
                {g.memoryTotalMb != null ? ` · ${(g.memoryTotalMb / 1024).toFixed(0)} GiB` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted mb-1.5">Network</p>
        {interfaces.length === 0 ? (
          <p className="text-sm text-muted">No physical interface detected</p>
        ) : (
          <div className="space-y-1">
            {interfaces.map((iface) => (
              <div key={iface.name} className="flex items-center gap-2 text-sm flex-wrap">
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                    iface.state === 'up' ? 'bg-emerald-500' : 'bg-hover'
                  }`}
                />
                <span className="font-medium">{iface.name}</span>
                {iface.mac && <span className="text-muted font-mono text-xs">{iface.mac}</span>}
                {iface.addresses.length > 0 && (
                  <span className="text-muted text-xs">{iface.addresses.join(', ')}</span>
                )}
                {iface.isDefault && (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-hover text-muted">default</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
