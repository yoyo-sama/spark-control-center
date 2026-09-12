// The whole rule catalogue. Plain objects with a detect(facts) predicate —
// no rule language, no interpreter. A rule only exists here if it flags a REAL
// problem on this machine; settings that are already correct (CUDA_CACHE_MAXSIZE,
// NCCL_P2P_DISABLE) get no rule, so the page counts problems, not catalogue size.
module.exports = [
  {
    id: 'gpu-clock-cap-unset',
    severity: 'high',
    target: 'host',
    title: 'GPU clock cap not configured',
    why:
        'gpuClockLimitMhz is not set in /etc/gb10-tuning/state.json: the GPU clocks up freely, ' +
        'hits thermal throttling under long load, and generation times become erratic. ' +
        'Setting a cap stabilizes throughput. Configurable in the GB10 tab.',
    action: null,
    detect: (f) => !f.gpuClockCapSet,
  },
  {
    id: 'vm-swappiness-high',
    severity: 'medium',
    target: 'host',
    title: 'vm.swappiness is high',
    why:
        'On unified memory, the kernel and the GPU share the same RAM: a high swappiness pushes model ' +
        'pages out to disk and drags down generation performance. A value ≤ 10 is recommended ' +
        'on GB10. Configurable in the GB10 tab.',
    action: null,
    detect: (f) => f.vmSwappiness !== null && f.vmSwappiness > 10,
  },
  {
    id: 'comfy-attention-pytorch',
    severity: 'medium',
    target: 'comfyui',
    title: 'ComfyUI is using PyTorch attention',
    why:
        '--use-pytorch-cross-attention is active and --use-sage-attention is absent. SageAttention is significantly ' +
        'faster on Blackwell, but it cannot be enabled as is: scripts 20-SageAttention2.sh and ' +
        '21-SageAttention3-BlackwellOnly.sh are disabled (their nvcc command hardcodes -std=c++17 and fails to ' +
        'compile), so SageAttention is not installed in the image. These scripts must be unblocked first.',
    action: { kind: 'app', appId: 'comfyui' },
    detect: (f) =>
      f.comfyui &&
      f.comfyui.flags.includes('--use-pytorch-cross-attention') &&
      !f.comfyui.flags.includes('--use-sage-attention'),
  },
  {
    id: 'opencode-context-mismatch',
    severity: 'high',
    target: 'opencode',
    title: 'opencode advertises a context Ollama does not serve',
    why:
        'At least one model in opencode.json declares a limit.context different from OLLAMA_CONTEXT_LENGTH ' +
        'on the ollama-api container: opencode would advertise a context window it will not actually get, ' +
        'and long conversations would be silently truncated instead of triggering compaction in time. ' +
        'Align limit.context on every model with OLLAMA_CONTEXT_LENGTH. Configurable in the opencode tab.',
    action: { kind: 'app', appId: 'opencode' },
    detect: (f) =>
      !!f.opencode &&
      f.opencode.ollamaContextLength !== null &&
      f.opencode.declaredContexts.some((c) => c !== f.opencode.ollamaContextLength),
  },
  {
    id: 'opencode-model-drift',
    severity: 'medium',
    target: 'opencode',
    title: 'opencode and Ollama disagree on which models exist',
    why:
        'Either opencode.json declares a model Ollama does not serve (opencode would offer a model that fails ' +
        'at call time), or Ollama serves a model opencode does not expose (installed but unreachable from ' +
        'opencode). Configurable in the opencode tab.',
    action: { kind: 'app', appId: 'opencode' },
    detect: (f) =>
      !!f.opencode &&
      (f.opencode.declared.some((d) => !f.opencode.installed.includes(d)) ||
        f.opencode.installed.some((i) => !f.opencode.declared.includes(i))),
  },
];
