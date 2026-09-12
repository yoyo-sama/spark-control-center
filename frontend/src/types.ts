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

export type View = 'gb10' | 'dashboard' | 'container-detail' | 'dgx';

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

export interface Gb10EnvAdviceItem {
  name: string;
  expected?: string;
  containers: string[];
}

export interface Gb10EnvAdvice {
  recommended: Gb10EnvAdviceItem[];
  banned: Gb10EnvAdviceItem[];
}

export interface Gb10State {
  desired: Gb10Desired;
  actual: Gb10Actual;
  status: Record<Gb10SettingKey, Gb10Status>;
  lastApply: unknown;
  pipelineInstalled: boolean;
  envAdvice: Gb10EnvAdvice;
}
