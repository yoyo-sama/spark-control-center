import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import type { AgentRuntime, AgentSkillRoot, MdFileInfo } from '../types';

const API_BASE = '/api';

export const cardClass = 'bg-surface border border-line rounded-xl p-4';
const thClass = 'py-1.5 pr-3';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const TONES: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  bad: 'bg-red-500/10 text-red-600 dark:text-red-400',
  muted: 'bg-hover text-muted',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

// null = cannot be known (not an Ollama model, or Ollama unreachable): say nothing rather than guess.
export function ServedPill({ served }: { served: boolean | null }) {
  if (served === null) return null;
  return served ? <Pill tone="ok">served by Ollama</Pill> : <Pill tone="bad">not served by Ollama</Pill>;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-muted">{label}</span>
      <span className="flex items-center gap-2 text-sm font-mono text-right min-w-0">{children}</span>
    </div>
  );
}

// Same loading / error shell as the other panels, around a render function.
export function AgentLoader<T>({ appId, children }: { appId: string; children: (state: T) => ReactNode }) {
  const [state, setState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/apps/${appId}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load the app');
        setState(data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load the app'));
  }, [appId]);

  if (error) {
    return (
      <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
        {error}
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center py-16">
        <Loader2 size={20} strokeWidth={2} className="animate-spin text-muted" />
      </div>
    );
  }
  return <>{children(state)}</>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
      {children}
    </div>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
      <TriangleAlert size={13} strokeWidth={2} className="shrink-0 mt-0.5" />
      <span>{children}</span>
    </p>
  );
}

// Read-only on purpose: the way to change things is a command the user runs, shown verbatim.
export function Commands({ title, note, lines }: { title: string; note?: ReactNode; lines: string[] }) {
  return (
    <div className={cardClass}>
      <h3 className="text-sm font-semibold tracking-tight mb-1">{title}</h3>
      {note && <p className="text-xs text-muted mb-3">{note}</p>}
      <div className="space-y-1">
        {lines.map((l) => (
          <code key={l} className="block font-mono text-xs bg-base border border-line rounded-lg px-2.5 py-1.5 select-all break-all">
            {l}
          </code>
        ))}
      </div>
    </div>
  );
}

export function MdFiles({ files }: { files: MdFileInfo[] }) {
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.path} className="flex items-center justify-between gap-3">
          <span className="text-xs font-mono text-muted truncate">{f.path}</span>
          {f.exists ? <span className="text-xs text-muted whitespace-nowrap">{f.lines} lines</span> : <Pill tone="muted">absent</Pill>}
        </li>
      ))}
    </ul>
  );
}

export function SkillRoots({ roots }: { roots: AgentSkillRoot[] }) {
  return (
    <div className={cardClass}>
      <h3 className="text-sm font-semibold tracking-tight mb-1">Skills</h3>
      <p className="text-xs text-muted mb-3">
        Same SKILL.md format as Claude Code and opencode, but this agent does not load their roots: a skill present on
        both sides is two copies that will drift apart.
      </p>
      <div className="space-y-3">
        {roots.map((root) => (
          <div key={root.id}>
            <p className="text-xs font-mono text-muted mb-1">{root.path}</p>
            {!root.exists ? (
              <p className="text-sm text-muted">Directory not found.</p>
            ) : root.skills.length === 0 ? (
              <p className="text-sm text-muted">No skill.</p>
            ) : (
              <ul className="space-y-1">
                {root.skills.map((s) => (
                  <li key={s.path} className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="text-sm font-mono">{s.category ? `${s.category}/` : ''}{s.name}</span>
                      {s.description && <span className="text-xs text-muted ml-2 truncate">{s.description}</span>}
                    </span>
                    {s.sharedWith.length > 0 && <Pill tone="warn">also in {s.sharedWith.join(', ')}</Pill>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RawConfig({ file, config }: { file: string; config: Record<string, unknown> }) {
  return (
    <details className={cardClass}>
      <summary className="text-sm font-semibold tracking-tight cursor-pointer">Raw configuration (masked)</summary>
      <p className="text-xs text-muted font-mono mt-2 mb-2">{file}</p>
      <pre className="text-xs font-mono bg-base border border-line rounded-lg p-3 overflow-x-auto">
        {JSON.stringify(config, null, 2)}
      </pre>
    </details>
  );
}

const AGENT_LABEL: Record<string, string> = { openclaw: 'OpenClaw', hermes: 'Hermes' };

// The "with or without NemoClaw" question, answered from what is actually on this machine:
// a config on the host, sandboxes in the NemoClaw registry, and processes seen in /proc.
export function RuntimeCard({ agent, runtime, configFile }: { agent: 'openclaw' | 'hermes'; runtime: AgentRuntime; configFile: string }) {
  const label = AGENT_LABEL[agent];
  const { nemoclaw, sandboxes, processes } = runtime;
  const onHost = processes.filter((p) => p.containerized === false);
  const inContainer = processes.filter((p) => p.containerized === true);

  return (
    <div className={cardClass}>
      <h3 className="text-sm font-semibold tracking-tight mb-3">Deployment</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-sm font-medium">Standalone</span>
            {runtime.standalone ? <Pill tone="ok">config found</Pill> : <Pill tone="muted">no config</Pill>}
          </div>
          <p className="text-xs text-muted">
            Installed on the host, runs as your user: whatever its tools may do, they do it on this machine.{' '}
            <span className="font-mono">{configFile}</span>
          </p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-sm font-medium">NemoClaw sandbox</span>
            {sandboxes.length > 0 ? (
              <Pill tone="ok">{sandboxes.length} sandbox{sandboxes.length > 1 ? 'es' : ''}</Pill>
            ) : nemoclaw.visible ? (
              <Pill tone="muted">none for {label}</Pill>
            ) : (
              <Pill tone="muted">registry not visible</Pill>
            )}
          </div>
          <p className="text-xs text-muted">
            Runs inside an OpenShell sandbox (Landlock, egress policy). Its config lives in the sandbox and belongs to the
            agent: it cannot be read from the host.
          </p>
        </div>
      </div>

      {sandboxes.length > 0 && (
        <div className="overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-muted uppercase tracking-wide">
                <th className={thClass}>Sandbox</th>
                <th className={thClass}>Model</th>
                <th className={thClass}>Provider</th>
                <th className={thClass}>GPU</th>
                <th className={thClass}>Dashboard</th>
                <th className={thClass}>Policies</th>
              </tr>
            </thead>
            <tbody>
              {sandboxes.map((s) => (
                <tr key={`${s.gateway}/${s.name}`} className="border-t border-line">
                  <td className="py-1.5 pr-3 font-mono text-xs">
                    {s.name}
                    {s.isDefault && <span className="ml-2"><Pill tone="muted">default</Pill></span>}
                    {s.gateway !== 'default' && <span className="ml-2 text-muted">gateway {s.gateway}</span>}
                    {s.agentInferred && (
                      <span className="block text-[11px] text-muted font-sans">no agent field — assumed OpenClaw</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{s.model ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-xs">{s.provider ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-xs">{s.gpu === null ? '—' : s.gpu ? 'yes' : 'no'}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{s.dashboardPort ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-xs">{s.policies ? s.policies.join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {runtime.otherSandboxes > 0 && (
        <p className="text-xs text-muted mb-2">
          {runtime.otherSandboxes} other sandbox{runtime.otherSandboxes > 1 ? 'es' : ''} in the NemoClaw registry run
          another agent.
        </p>
      )}

      {nemoclaw.registries.filter((r) => r.error).map((r) => (
        <p key={r.file} className="text-xs text-red-600 dark:text-red-400 mb-2 font-mono">
          {r.file}: {r.error}
        </p>
      ))}

      {nemoclaw.gatewayContainers.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">OpenShell gateway</p>
          <ul className="space-y-0.5">
            {nemoclaw.gatewayContainers.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-3 text-xs">
                <span className="font-mono truncate">{c.name} <span className="text-muted">({c.image})</span></span>
                <Pill tone={c.state === 'running' ? 'ok' : 'muted'}>{c.status}</Pill>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Processes</p>
      {processes.length === 0 ? (
        <p className="text-sm text-muted mb-1">No {label} process running.</p>
      ) : (
        <ul className="space-y-0.5 mb-1">
          {processes.map((p) => (
            <li key={p.pid} className="flex items-center justify-between gap-3 text-xs">
              <span className="font-mono truncate">
                <span className="text-muted">{p.pid}</span> {p.argv.join(' ')}
              </span>
              {p.containerized === null ? (
                <Pill tone="muted">unknown</Pill>
              ) : p.containerized ? (
                <Pill tone="muted">in a container</Pill>
              ) : (
                <Pill tone="warn">on the host</Pill>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5 mt-2">
        {inContainer.length > 0 && !nemoclaw.visible && (
          <Warning>
            {label} runs in a container, most likely a NemoClaw sandbox, but ~/.nemoclaw is not mounted: enable
            compose/nemoclaw.yml to read the sandbox registry.
          </Warning>
        )}
        {runtime.standalone && sandboxes.length > 0 && (
          <Warning>
            {label} is set up both on the host and in NemoClaw. Two gateways connected to the same bot (one Telegram
            token, say) compete for its messages{agent === 'openclaw' ? ', and the sandbox dashboard moves to 18790–18799 when 18789 is taken' : ''}.
          </Warning>
        )}
        {onHost.length > 0 && !runtime.standalone && (
          <Warning>
            A {label} process runs on the host but its config directory is not visible: enable compose/{agent}.yml.
          </Warning>
        )}
        {nemoclaw.legacyCredentials && (
          <Warning>
            {nemoclaw.dir}/credentials.json is still on disk: a legacy plaintext file current NemoClaw releases no longer
            use. Never read by this app.
          </Warning>
        )}
      </div>
    </div>
  );
}

// Only when a sandbox exists: the commands come from the NemoClaw docs, check --help on your version.
export function NemoclawCommands({ agent, runtime }: { agent: 'openclaw' | 'hermes'; runtime: AgentRuntime }) {
  if (runtime.sandboxes.length === 0) return null;
  const name = runtime.sandboxes.find((s) => s.isDefault)?.name ?? runtime.sandboxes[0].name;
  return (
    <Commands
      title="Change it under NemoClaw"
      note="The config is inside the sandbox: change it from there, or through NemoClaw. From the NemoClaw docs — check --help on your version."
      lines={[
        'nemoclaw list',
        `nemoclaw ${name} status`,
        `nemoclaw ${name} logs --follow`,
        `nemoclaw ${name} connect`,
        agent === 'openclaw'
          ? 'openclaw config set <key> <value>   # inside the sandbox, after connect'
          : 'nemohermes inference set   # switch the sandbox model',
      ]}
    />
  );
}
