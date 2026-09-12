export interface Container {
  id: string;
  shortId: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  ports: string[];
  publishedPorts: Array<{ hostPort: number; containerPort: number; hostNetwork?: boolean }>;
  workingDir: string;
  binds: Array<{ source: string; destination: string }>;
  restartPolicy: string;
  startedAt: string;
  created: string;
}

export interface SystemMetrics {
  cpu_percent: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  memory_percent: number;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_percent: number;
  uptime_seconds: number;
  gpus: GpuMetric[];
  container_count: number;
  container_status: Record<string, number>;
  image_count: number;
  volume_count: number;
}

export interface GpuMetric {
  index: number;
  name: string;
  utilization_percent: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  temperature_celsius: number | null;
  power_draw_watts: number | null;
}

export interface ContainerStats {
  cpu_percent: number;
  memory_usage_bytes: number;
  memory_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
  vram_usage_bytes: number;
  vram_percent: number;
  memory_usage_combined: number;
  memory_percent_combined: number;
}

export interface ContainerDetail {
  id: string;
  shortId: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null;
  restartPolicy: string;
  startedAt: string;
  created: string;
  command: string[];
  env: string[];
  mounts: Array<{ type: string; source: string; destination: string }>;
}

export interface HistoryPoint {
  time: string;
  cpu: number;
  memory: number;
  disk: number;
  gpu: number;
  [key: string]: number | string;
}

export interface ContainerHistoryPoint {
  time: string;
  cpu_percent: number;
  memory_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  [key: string]: number | string;
}

export type View = 'gb10' | 'dashboard' | 'container-detail' | 'dgx' | 'apps';

export type Gb10SettingKey =
  | 'gpuClockLimitMhz'
  | 'gpuPersistenceMode'
  | 'swapDisabled'
  | 'vmSwappiness'
  | 'thermalMonitor';

export type Gb10SettingState = 'ok' | 'pending' | 'failed' | 'skipped' | 'diverged' | 'unverified' | 'unset';

export interface Gb10Status {
  state: Gb10SettingState;
  message: string;
}

export interface Gb10Desired {
  version: number;
  updatedAt: string;
  gpuClockLimitMhz: number | null;
  gpuPersistenceMode: boolean;
  swapDisabled: boolean;
  vmSwappiness: number;
  thermalMonitor: boolean;
}

export interface Gb10Actual {
  gpuPersistenceMode: boolean | null;
  gpuClockCurrentMhz: number | null;
  gpuClockApplicationsMhz: number | null;
  gpuClockMaxMhz: number | null;
  gpuTemperatureCelsius: number | null;
  gpuPowerDrawWatts: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  vmSwappiness: number | null;
  thermalMonitor: boolean | null;
}

export interface Gb10State {
  desired: Gb10Desired;
  actual: Gb10Actual;
  status: Record<Gb10SettingKey, Gb10Status>;
  lastApply: unknown;
  pipelineInstalled: boolean;
}

export interface AppSummary {
  id: string;
  label: string;
  detected: boolean;
  reason: string;
  containerName: string;
  containerRunning: boolean;
  projectDir: string;
}

export interface AppCmdlineKnownFlag {
  flag: string;
  label: string;
  why: string;
  danger: string | null;
}

export interface AppState {
  id: string;
  label: string;
  detected: boolean;
  containerName: string;
  containerRunning: boolean;
  projectDir: string;
  composeFile: string;
  cmdline: {
    raw: string;
    flags: string[];
    known: AppCmdlineKnownFlag[];
  };
  env: Record<string, string>;
  scripts: Array<{ name: string; enabled: boolean; note: string | null }>;
}

export interface DiffLine {
  kind: 'context' | 'removed' | 'added';
  line: number | null;
  text: string;
}

export interface RestartInfo {
  kind: 'restart' | 'recreate' | 'none';
  containerName?: string;
  command?: string;
  cwd?: string;
  cost?: string;
}

export interface PreviewResult {
  token: string;
  file: string;
  summary: string;
  diff: DiffLine[];
  warnings: string[];
  restart: RestartInfo;
}

export interface Insight {
  id: string;
  severity: 'high' | 'medium' | 'low';
  target: string;
  title: string;
  why: string;
  action: null | { kind: 'app'; appId: string };
}

export interface OpencodeModel {
  id: string;
  name: string;
  context: number;
  output: number;
  servedByOllama: boolean;
}

export interface OpencodeOllamaInfo {
  reachable: boolean;
  contextLength: number | null;
  installed: string[];
}

export interface OpencodeCompaction {
  auto: boolean;
  prune: boolean;
  threshold: number;
  reserved: number;
  strategy: 'summarize' | 'truncate';
  preserveRecentMessages: number;
  preserveSystemPrompt: boolean;
}

export interface OpencodeSkillSources {
  paths: string[];
  urls: string[];
}

export interface OpencodeAgentsFile {
  path: string;
  exists: boolean;
  lines: number;
}

export interface OpencodeState {
  id: string;
  label: string;
  detected: boolean;
  reason: string;
  containerName: string | null;
  containerRunning: boolean;
  projectDir: string;
  configFile: string;
  model: string;
  models: OpencodeModel[];
  ollama: OpencodeOllamaInfo;
  compaction: OpencodeCompaction;
  skills: OpencodeSkillSources;
  instructions: string[];
  agentsFile: OpencodeAgentsFile;
}

export interface SkillRoot {
  id: string;
  path: string;
  exists: boolean;
}

export interface SkillEntry {
  name: string;
  description: string;
  root: string;
  path: string;
  file: string;
  enabled: boolean;
  symlink: string | null;
  duplicateIn: string[];
  lines: number;
}

export interface SkillDetail extends SkillEntry {
  content: string;
}

export interface SkillsListResponse {
  roots: SkillRoot[];
  skills: SkillEntry[];
}

export interface ClaudeCodeSettingsFile {
  name: string;
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
}

export interface ClaudeCodePluginInstalled {
  id: string;
  scope: string;
  version: string;
  installedAt: string;
  installPath: string;
}

export interface ClaudeCodePlugins {
  installed: ClaudeCodePluginInstalled[];
  marketplaces: string[];
  enabled: Record<string, boolean>;
}

export interface ClaudeCodeMcp {
  configured: unknown[];
  note?: string;
  pendingAuth?: string[];
}

export interface ClaudeCodeHooks {
  present: boolean;
  files: string[];
}

export interface MachineGpu {
  index: number;
  name: string;
  uuid: string | null;
  serial: string | null;
  vbios: string | null;
  memoryTotalMb: number | null;
}

export interface MachineNetworkInterface {
  name: string;
  mac: string | null;
  state: string;
  addresses: string[];
  isDefault: boolean;
}

export interface MachineInfo {
  vendor: string | null;
  model: string | null;
  boardVendor: string | null;
  chassisVendor: string | null;
  bios: { vendor: string | null; version: string | null } | null;
  serials: { product: string | null; board: string | null; dgx: string | null };
  platform: {
    name: string | null;
    prettyName: string | null;
    swBuild: string | null;
    otaVersion: string | null;
    otaDate: string | null;
    commit: string | null;
    platform: string | null;
  } | null;
  chip: { name: string; gpus: MachineGpu[] } | null;
  os: { arch: string | null; kernel: string | null; distro: string | null } | null;
  network: { defaultInterface: string | null; interfaces: MachineNetworkInterface[] } | null;
  sources: { dmi: boolean; dgxRelease: boolean; hostSys: boolean; gpu: boolean };
}

export interface UpdatesSummary {
  total: number;
  security: number;
  esmEnabled: boolean;
  source: string;
  checkedAt: string;
}

export interface UpdatePackage {
  name: string;
  current: string;
  candidate: string;
  origin: string;
  arch: string;
}

export interface UpdatesState {
  summary: UpdatesSummary | null;
  packages: UpdatePackage[];
  packagesGeneratedAt: string | null;
  pipelineInstalled: boolean;
  note: string | null;
}

export interface ClaudeCodeState {
  id: string;
  label: string;
  detected: boolean;
  reason: string;
  containerName: string | null;
  containerRunning: boolean;
  projectDir: string;
  skillsCount: number;
  skillsRoots: SkillRoot[];
  settingsFiles?: ClaudeCodeSettingsFile[];
  editableKeys?: string[];
  plugins?: ClaudeCodePlugins;
  mcp?: ClaudeCodeMcp;
  hooks?: ClaudeCodeHooks;
}
