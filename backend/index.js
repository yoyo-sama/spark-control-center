const express = require('express');
const cors = require('cors');
const compression = require('compression');
const http = require('http');
const { WebSocketServer } = require('ws');
const Docker = require('dockerode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const { getHostMetrics, getDiskMetrics, getGpuMetrics, getGpuMemoryByContainer, getContainerStats } = require('./metrics');
const { getContainerListeningPorts } = require('./hostports');
const gb10Router = require('./gb10');
const { router: appsRouter } = require('./apps');
const { router: insightsRouter } = require('./insights');
const { router: skillsRouter } = require('./skills');
const { router: machineRouter } = require('./machine');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(cors());
app.use(express.json());
app.use(compression());

const deploys = new Map();

const DEPLOYS_DIR = '/tmp/docker-manager';
const DEPLOY_TIMEOUT = 5 * 60 * 1000; // 5 min

function formatPorts(ports) {
  if (!ports || ports.length === 0) return [];
  return [...new Set(ports.map(p => {
    if (p.PublicPort) return `${p.PublicPort}:${p.PrivatePort}/${p.Type}`;
    return `${p.PrivatePort}/${p.Type}`;
  }))];
}

function formatContainer(containerInfo, inspect) {
  const binds = (inspect.Mounts || [])
    .filter((m) => m.Type === 'bind')
    .map((m) => ({ source: m.Source, destination: m.Destination }));

  const seen = new Set();
  const publishedPorts = (containerInfo.Ports || [])
    .filter((p) => p.PublicPort && p.Type === 'tcp')
    .map((p) => ({ hostPort: p.PublicPort, containerPort: p.PrivatePort }))
    .filter((p) => {
      const key = `${p.hostPort}:${p.containerPort}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    id: containerInfo.Id,
    shortId: containerInfo.Id.substring(0, 12),
    name: containerInfo.Names[0].replace('/', ''),
    image: containerInfo.Image,
    status: containerInfo.State,
    running: containerInfo.State === 'running',
    ports: formatPorts(containerInfo.Ports),
    publishedPorts,
    workingDir: inspect.Config.WorkingDir || '',
    binds,
    restartPolicy: inspect.HostConfig.RestartPolicy.Name,
    startedAt: inspect.State.StartedAt,
    created: inspect.Created,
  };
}

async function getContainerPids(container) {
  const top = await container.top();
  const pidIdx = top.Titles.indexOf('PID');
  if (pidIdx === -1) return [];
  return top.Processes
    .map((p) => parseInt(p[pidIdx], 10))
    .filter((n) => Number.isFinite(n));
}

// Get all containers
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const containerData = await Promise.all(containers.map(async (containerInfo) => {
      const container = docker.getContainer(containerInfo.Id);
      const inspect = await container.inspect();
      const formatted = formatContainer(containerInfo, inspect);
      if (inspect.HostConfig.NetworkMode === 'host' && formatted.running) {
        try {
          const pids = await getContainerPids(container);
          const hostPorts = getContainerListeningPorts(containerInfo.Id, pids);
          formatted.publishedPorts = hostPorts.map((port) => ({
            hostPort: port,
            containerPort: port,
            hostNetwork: true,
          }));
        } catch (e) {
          /* keep publishedPorts empty on failure */
        }
      }
      return formatted;
    }));
    res.json(containerData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get container detail
app.get('/api/containers/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    res.json({
      id: inspect.Id,
      shortId: inspect.Id.substring(0, 12),
      name: inspect.Name.replace('/', ''),
      image: inspect.Config.Image,
      status: inspect.State.Status,
      running: inspect.State.Running,
      ports: inspect.NetworkSettings.Ports,
      restartPolicy: inspect.HostConfig.RestartPolicy.Name,
      startedAt: inspect.State.StartedAt,
      created: inspect.Created,
      command: inspect.Config.Cmd,
      env: inspect.Config.Env,
      mounts: inspect.Mounts,
    });
  } catch (error) {
    if (error.statusCode === 404 || error.reason === 'Not found') {
      return res.status(404).json({ error: 'Container not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Get container stats
const containerCpuSamples = new Map(); // containerId -> { cpu, sys }

app.get('/api/containers/:id/stats', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const stats = await container.stats({ stream: false });
    const prevSample = containerCpuSamples.get(req.params.id) || null;
    const base = getContainerStats(stats, prevSample);
    if (containerCpuSamples.size > 1000) containerCpuSamples.clear();
    containerCpuSamples.set(req.params.id, {
      cpu: stats.cpu_stats?.cpu_usage?.total_usage || 0,
      sys: stats.cpu_stats?.system_cpu_usage || 0,
    });
    const gpuMemMap = getGpuMemoryByContainer();
    const vramBytes = gpuMemMap.get(inspect.Id) || gpuMemMap.get(req.params.id) || 0;
    const memTotal = os.totalmem();
    const combinedUsage = base.memory_usage_bytes + vramBytes;
    const combinedPercent = (combinedUsage / memTotal) * 100;
    const vramPercent = (vramBytes / memTotal) * 100;
    res.json({
      ...base,
      vram_usage_bytes: vramBytes,
      vram_percent: vramPercent,
      memory_usage_combined: combinedUsage,
      memory_percent_combined: combinedPercent,
    });
  } catch (error) {
    if (error.statusCode === 404 || error.reason === 'Not found') {
      return res.status(404).json({ error: 'Container not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Get system metrics
app.get('/api/system', async (req, res) => {
  try {
    const host = getHostMetrics();
    const disk = getDiskMetrics();
    const gpus = getGpuMetrics();
    const containers = await docker.listContainers({ all: true });
    const images = await docker.listImages();
    const volumes = await docker.listVolumes();

    const statusCounts = {};
    containers.forEach((c) => {
      statusCounts[c.State] = (statusCounts[c.State] || 0) + 1;
    });

    const gpuMemMap = getGpuMemoryByContainer();
    const memTotal = host.memory_total_bytes || 1;
    const vramByContainer = containers
      .map((c) => {
        const vramBytes = gpuMemMap.get(c.Id) || 0;
        return {
          id: c.Id,
          name: (c.Names[0] || '').replace('/', ''),
          vram_usage_bytes: vramBytes,
          vram_percent: (vramBytes / memTotal) * 100,
        };
      })
      .filter((c) => c.vram_usage_bytes > 0)
      .sort((a, b) => b.vram_usage_bytes - a.vram_usage_bytes);

    res.json({
      ...host,
      ...disk,
      gpus,
      container_count: containers.length,
      container_status: statusCounts,
      image_count: images.length,
      volume_count: volumes.Volumes?.length || 0,
      vram_by_container: vramByContainer,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start a container
app.post('/api/containers/:id/start', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    await container.start();
    res.json({ message: 'Container started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop a container
app.post('/api/containers/:id/stop', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    await container.stop();
    res.json({ message: 'Container stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Restart a container
app.post('/api/containers/:id/restart', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    await container.restart();
    res.json({ message: 'Container restarted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove a container
app.delete('/api/containers/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    await container.remove({ force: true });
    res.json({ message: 'Container removed' });
  } catch (error) {
    if (error.statusCode === 404 || error.reason === 'Not found') {
      return res.status(404).json({ error: 'Container not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Deploy from GitHub
app.post('/api/deploy/github', async (req, res) => {
  const { repo, branch = 'main', name, ports, env } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo URL is required' });

  const deployId = uuidv4();
  const containerName = name || `deploy-${deployId.substring(0, 8)}`;
  const imageName = containerName;
  const workDir = path.join(DEPLOYS_DIR, deployId);

  const state = {
    id: deployId,
    repo,
    branch,
    containerName,
    imageName,
    ports: ports || [],
    env: env || {},
    logs: [],
    status: 'running', // running | success | error
    containerId: null,
    error: null,
    listeners: [],
  };

  deploys.set(deployId, state);

  res.json({ deployId });

  // Async deploy process
  runDeploy(state, workDir).catch(err => {
    state.logs.push({ type: 'error', text: `Fatal: ${err.message}` });
    state.status = 'error';
    state.error = err.message;
    notifyListeners(state);
    cleanup(workDir);
  });
});

// SSE - Deploy logs
app.get('/api/events/deploy/:id', (req, res) => {
  const state = deploys.get(req.params.id);
  if (!state) return res.status(404).json({ error: 'Deploy not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send existing logs
  for (const log of state.logs) {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  }
  // Send current status
  res.write(`data: ${JSON.stringify({ type: 'status', text: state.status })}\n\n`);

  if (state.status !== 'running') {
    return res.end();
  }

  state.listeners.push(res);

  req.on('close', () => {
    state.listeners = state.listeners.filter(l => l !== res);
  });
});

function notifyListeners(state) {
  for (const listener of state.listeners) {
    try {
      listener.write(`data: ${JSON.stringify({ type: 'status', text: state.status })}\n\n`);
      if (state.status !== 'running') listener.end();
    } catch (e) { /* ignore */ }
  }
}

function addLog(state, type, text) {
  const log = { type, text, time: new Date().toISOString() };
  state.logs.push(log);
  for (const listener of state.listeners) {
    try {
      listener.write(`data: ${JSON.stringify(log)}\n\n`);
    } catch (e) { /* ignore */ }
  }
}

async function runDeploy(state, workDir) {
  fs.mkdirSync(workDir, { recursive: true });

  const timeout = setTimeout(() => {
    state.status = 'error';
    state.error = 'Deploy timed out after 5 minutes';
    addLog(state, 'error', 'Deploy timed out after 5 minutes');
    notifyListeners(state);
    cleanup(workDir);
  }, DEPLOY_TIMEOUT);

  try {
    // Clone
    addLog(state, 'info', `Cloning ${state.repo} (branch: ${state.branch})...`);
    await runCmd('git', ['clone', '--depth', '1', '--branch', state.branch, state.repo, workDir], state, workDir);

    // Build
    const tag = state.imageName;
    addLog(state, 'info', `Building Docker image: ${tag}...`);
    await runCmd('docker', ['build', '-t', tag, workDir], state, workDir);

    // Stop & remove existing container with same name
    try {
      const existing = docker.getContainer(state.containerName);
      await existing.remove({ force: true });
    } catch (e) { /* ok if doesn't exist */ }

    // Run
    const runArgs = ['run', '-d', '--name', state.containerName, '--restart', 'unless-stopped'];

    for (const p of state.ports) {
      const hostPort = p.hostPort || p.containerPort;
      const proto = p.protocol || 'tcp';
      runArgs.push('-p', `${hostPort}:${p.containerPort}/${proto}`);
    }

    for (const [key, val] of Object.entries(state.env)) {
      if (val) runArgs.push('-e', `${key}=${val}`);
    }

    runArgs.push(state.imageName);

    addLog(state, 'info', `Starting container: ${state.containerName}...`);
    await runCmd('docker', runArgs, state, workDir);

    // Get container ID
    const deployed = docker.getContainer(state.containerName);
    const deployedInspect = await deployed.inspect();
    state.containerId = deployedInspect.Id;
    state.status = 'success';
    addLog(state, 'success', `Container ${state.containerName} deployed successfully!`);
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    addLog(state, 'error', err.message);
  } finally {
    clearTimeout(timeout);
    notifyListeners(state);
    cleanup(workDir);
  }
}

function runCmd(cmd, args, state, cwd) {
  return new Promise((resolve, reject) => {
    addLog(state, 'cmd', `$ ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) addLog(state, 'output', line);
    });

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) addLog(state, 'output', line);
    });

    proc.on('error', (err) => reject(new Error(`${cmd} failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function cleanup(workDir) {
  fs.rm(workDir, { recursive: true, force: true }, () => {});
}

// Periodic cleanup of stale deploys
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of deploys) {
    if (state.status !== 'running' && now - new Date(state.logs[state.logs.length - 1]?.time || 0).getTime() > 3600000) {
      deploys.delete(id);
    }
  }
}, 3600000);

app.use('/api/gb10', gb10Router);
app.use('/api/apps', appsRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/machine', machineRouter);

// JSON 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve frontend static files (single-container mode)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

async function detectShell(container) {
  for (const shell of ['/bin/bash', '/bin/sh']) {
    try {
      const probe = await container.exec({
        Cmd: [shell, '-c', 'echo ok'],
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
      });
      const stream = await probe.start({ hijack: true, stdin: false, Tty: true });
      const output = await new Promise((resolve) => {
        let buf = '';
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { stream.destroy(); } catch (e) { /* ignore */ }
          resolve(buf);
        };
        const timer = setTimeout(done, 3000);
        stream.on('data', (c) => { buf += c.toString(); });
        stream.on('end', done);
        stream.on('error', done);
        stream.on('close', done);
      });
      if (output.includes('ok')) return shell;
    } catch (e) {
      /* try next candidate */
    }
  }
  return null;
}

server.on('upgrade', async (req, socket, head) => {
  const url = req.url || '';
  const match = url.match(/^\/api\/exec\/([^/?]+)/);
  if (!match) {
    socket.destroy();
    return;
  }

  const containerId = decodeURIComponent(match[1]);
  const container = docker.getContainer(containerId);

  try {
    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nContainer is not running');
      socket.destroy();
      return;
    }
  } catch (e) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\nContainer not found');
    socket.destroy();
    return;
  }

  const shell = await detectShell(container);
  if (!shell) {
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\nNo shell (bash/sh) available in this container');
    socket.destroy();
    return;
  }

  let exec;
  let stream;
  try {
    exec = await container.exec({
      Cmd: [shell],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  } catch (e) {
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n' + e.message);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'resize' && exec) {
          const rows = Math.min(Math.max(Number(msg.rows) || 24, 1), 512);
          const cols = Math.min(Math.max(Number(msg.cols) || 80, 1), 512);
          exec.resize({ h: rows, w: cols }).catch(() => {});
          return;
        }
      } catch (e) {
        /* treat as raw input */
      }
      if (typeof stream.write === 'function') {
        stream.write(data);
      }
    });

    ws.on('close', () => {
      try {
        if (stream && typeof stream.end === 'function') stream.end();
      } catch (e) { /* ignore */ }
    });

    ws.on('error', () => {});

    stream.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });

    stream.on('end', () => {
      if (ws.readyState === ws.OPEN) ws.close();
    });

    stream.on('error', () => {
      if (ws.readyState === ws.OPEN) ws.close();
    });

    stream.on('close', () => {
      if (ws.readyState === ws.OPEN) ws.close();
    });
  });
});

server.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
