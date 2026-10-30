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
} from './AgentCommon';
import type { HermesState } from '../types';

// terminal.backend is where the agent's shell commands run: the one setting that changes
// what a message to Hermes can do to this machine.
const BACKEND_NOTE: Record<string, string> = {
  local: 'Shell commands run directly on this machine, as your user.',
  docker: 'Shell commands run in a Docker container.',
  ssh: 'Shell commands run on a remote host over SSH.',
  singularity: 'Shell commands run in a Singularity container.',
  modal: 'Shell commands run in a Modal cloud sandbox.',
  daytona: 'Shell commands run in a Daytona cloud sandbox.',
};

export default function HermesPanel({ appId }: { appId: string }) {
  return (
    <AgentLoader<HermesState> appId={appId}>
      {(state) => {
        const s = state.standalone;
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Read-only. config.yaml is commented YAML, which this app never re-serializes, and terminal.backend decides
              where the agent runs its shell commands — this app has no authentication.
            </p>

            <RuntimeCard agent="hermes" runtime={state.runtime} configFile={`${state.projectDir}/config.yaml`} />

            {s && s.error && <ErrorBox>{s.error}</ErrorBox>}

            {s && !s.error && s.model && s.terminal && (
              <>
                <div className={cardClass}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">Model</h3>
                  <Row label="Default">
                    {s.model.default ? (
                      <>
                        <span className="truncate">{s.model.default}</span>
                        {s.model.pointsAtOllama && <ServedPill served={s.model.served} />}
                      </>
                    ) : (
                      <span className="text-muted">not set — run hermes model</span>
                    )}
                  </Row>
                  <Row label="Provider">{s.model.provider ?? <span className="text-muted">—</span>}</Row>
                  <Row label="Base URL">
                    <span className="truncate">{s.model.baseUrl ?? '—'}</span>
                  </Row>
                  {s.model.pointsAtOllama && !state.ollama.reachable && (
                    <p className="text-xs text-muted mt-2">Ollama is unreachable: whether the model is served is unknown.</p>
                  )}
                </div>

                <div className={cardClass}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">Execution</h3>
                  <Row label="Terminal backend">
                    {s.terminal.backend}
                    {s.terminal.backendIsDefault && <span className="text-muted font-sans text-xs">default</span>}
                    {s.terminal.backend === 'local' && <Pill tone="warn">host</Pill>}
                  </Row>
                  <p className="text-xs text-muted mb-1">{BACKEND_NOTE[s.terminal.backend] ?? 'Unknown backend.'}</p>
                  {s.compression && (
                    <Row label="Compression">
                      {s.compression.enabled === null ? '—' : s.compression.enabled ? 'on' : 'off'}
                      {s.compression.threshold !== null && ` · ${s.compression.threshold}`}
                    </Row>
                  )}
                  <Row label="Toolsets">
                    <span className="truncate">{s.toolsets ? s.toolsets.join(', ') : 'default'}</span>
                  </Row>
                </div>

                <div className={cardClass}>
                  <h3 className="text-sm font-semibold tracking-tight mb-2">Identity and memory</h3>
                  {s.identity && <MdFiles files={s.identity} />}
                  {s.profiles && s.profiles.length > 0 && (
                    <Row label="Profiles">
                      <span className="truncate">{s.profiles.join(', ')}</span>
                    </Row>
                  )}
                  <Row label=".env">
                    <span className="truncate">
                      {s.envKeys === null || s.envKeys === undefined
                        ? 'absent'
                        : s.envKeys.length === 0
                          ? 'empty'
                          : s.envKeys.join(', ')}
                    </span>
                  </Row>
                  <p className="text-xs text-muted mt-1">Variable names only: their values, auth.json and state.db are never read.</p>
                </div>

                {s.skills && <SkillRoots roots={s.skills} />}
              </>
            )}

            {state.runtime.standalone && (
              <Commands
                title="Change it on the host"
                note="hermes config set writes secrets to .env and everything else to config.yaml."
                lines={['hermes config set model.default <model>', 'hermes config set terminal.backend docker', 'hermes config check']}
              />
            )}
            <NemoclawCommands agent="hermes" runtime={state.runtime} />

            {s && !s.error && s.config && <RawConfig file={s.configFile} config={s.config} />}
          </div>
        );
      }}
    </AgentLoader>
  );
}
