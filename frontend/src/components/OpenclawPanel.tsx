import {
  AgentLoader,
  cardClass,
  Commands,
  ErrorBox,
  MdFiles,
  NemoclawCommands,
  Pill,
  RawConfig,
  Row,
  RuntimeCard,
  ServedPill,
  SkillRoots,
  Warning,
} from './AgentCommon';
import type { OpenclawState } from '../types';

const thClass = 'py-1.5 pr-3';

// dmPolicy decides who can reach an agent that acts on this machine: "open" is the one to see.
function DmPolicy({ policy, open }: { policy: string | null; open: boolean }) {
  if (open) return <Pill tone="bad">{policy ?? 'allowFrom *'} — anyone</Pill>;
  if (policy === null) return <span className="text-muted">default</span>;
  return <Pill tone="muted">{policy}</Pill>;
}

export default function OpenclawPanel({ appId }: { appId: string }) {
  return (
    <AgentLoader<OpenclawState> appId={appId}>
      {(state) => {
        const s = state.standalone;
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Read-only. openclaw.json is JSON5 that the gateway hot-reloads and refuses to start on if one key is wrong,
              and it decides who may message an agent able to act on this machine — this app has no authentication.
            </p>

            <RuntimeCard agent="openclaw" runtime={state.runtime} configFile={`${state.projectDir}/openclaw.json`} />

            {s && s.error && <ErrorBox>{s.error}</ErrorBox>}

            {s && !s.error && s.model && s.gateway && (
              <>
                <div className={cardClass}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">Model</h3>
                  <Row label="Primary">
                    {s.model.primary ? (
                      <>
                        <span className="truncate">{s.model.primary.ref}</span>
                        <ServedPill served={s.model.primary.served} />
                      </>
                    ) : (
                      <span className="text-muted">not set</span>
                    )}
                  </Row>
                  {s.model.fallbacks.map((f, i) => (
                    <Row key={f.ref} label={`Fallback ${i + 1}`}>
                      <span className="truncate">{f.ref}</span>
                      <ServedPill served={f.served} />
                    </Row>
                  ))}
                  {s.agents && s.agents.length > 0 && (
                    <Row label="Agents">
                      <span className="truncate">
                        {s.agents.map((a) => (a.model ? `${a.id} (${a.model})` : a.id)).join(', ')}
                      </span>
                    </Row>
                  )}
                  {!state.ollama.reachable && (
                    <p className="text-xs text-muted mt-2">Ollama is unreachable: whether a model is served is unknown.</p>
                  )}
                </div>

                <div className={cardClass}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">Gateway</h3>
                  <Row label="Port">
                    {s.gateway.port}
                    {s.gateway.portIsDefault && <span className="text-muted font-sans text-xs">default</span>}
                  </Row>
                  <Row label="Bind">{s.gateway.bind ?? <span className="text-muted">default</span>}</Row>
                  <Row label="Auth">{s.gateway.authConfigured ? 'configured' : <Pill tone="warn">none</Pill>}</Row>
                  <Row label="Tool sandbox">
                    {s.toolSandbox ?? <span className="text-muted font-sans text-xs">not set — tools run on the host</span>}
                  </Row>
                </div>

                <div className={cardClass}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">Channels</h3>
                  {!s.channels || s.channels.length === 0 ? (
                    <p className="text-sm text-muted">No channel configured.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs font-medium text-muted uppercase tracking-wide">
                            <th className={thClass}>Channel</th>
                            <th className={thClass}>Direct messages</th>
                            <th className={thClass}>Allowed senders</th>
                            <th className={thClass}>Groups</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.channels.map((c) => (
                            <tr key={c.name} className={`border-t border-line ${c.enabled ? '' : 'opacity-50'}`}>
                              <td className="py-1.5 pr-3 font-mono text-xs">
                                {c.name}
                                {!c.enabled && <span className="ml-2 text-muted font-sans">disabled</span>}
                              </td>
                              <td className="py-1.5 pr-3 text-xs">
                                <DmPolicy policy={c.dmPolicy} open={c.openToAnyone} />
                              </td>
                              <td className="py-1.5 pr-3 text-xs">{c.allowFromCount ?? '—'}</td>
                              <td className="py-1.5 pr-3 text-xs">{c.groupPolicy ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="text-xs text-muted mt-2">Allowed senders are phone numbers and user ids: only their count is shown.</p>
                </div>

                {s.providers && s.providers.length > 0 && (
                  <div className={cardClass}>
                    <h3 className="text-sm font-semibold tracking-tight mb-2">Providers</h3>
                    <div className="space-y-3">
                      {s.providers.map((p) => (
                        <div key={p.id}>
                          <Row label={p.id}>
                            <span className="truncate">{p.baseUrl ?? '—'}</span>
                            {p.api && <Pill tone="muted">{p.api}</Pill>}
                          </Row>
                          {p.models.map((m) => (
                            <p key={m.id} className="text-xs font-mono text-muted pl-3">
                              {m.id} · context {m.contextWindow ?? '—'} · max output {m.maxTokens ?? '—'}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {s.workspace && (
                  <div className={cardClass}>
                    <h3 className="text-sm font-semibold tracking-tight mb-1">Workspace</h3>
                    <p className="text-xs text-muted font-mono mb-2">{s.workspace.path}</p>
                    {!s.workspace.visible ? (
                      <Warning>Outside the mounted ~/.openclaw: not visible from the container.</Warning>
                    ) : s.workspace.files.length === 0 ? (
                      <p className="text-sm text-muted">No bootstrap file.</p>
                    ) : (
                      <MdFiles files={s.workspace.files} />
                    )}
                  </div>
                )}

                {s.skills && <SkillRoots roots={s.skills} />}
              </>
            )}

            {state.runtime.standalone && (
              <Commands
                title="Change it on the host"
                note="The gateway hot-reloads openclaw.json and validates it strictly: prefer the CLI to hand edits."
                lines={[
                  'openclaw config set agents.defaults.model.primary ollama/<model>',
                  'openclaw config set channels.<channel>.dmPolicy pairing',
                ]}
              />
            )}
            <NemoclawCommands agent="openclaw" runtime={state.runtime} />

            {s && !s.error && s.config && <RawConfig file={s.configFile} config={s.config} />}
          </div>
        );
      }}
    </AgentLoader>
  );
}
