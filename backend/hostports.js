const fs = require('fs');

const CACHE_TTL = 10000;
const PURGE_AGE = 60000;
const LISTEN_STATE = '0A';

const cache = new Map(); // containerId -> { ports: number[], time: number }

function purgeExpired(now) {
  for (const [id, entry] of cache) {
    if (now - entry.time > PURGE_AGE) cache.delete(id);
  }
}

function parseListenSockets(filePath, isV6) {
  const sockets = [];
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return sockets;
  }
  for (const line of content.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    if (parts[3] !== LISTEN_STATE) continue;
    const [addrHex, portHex] = parts[1].split(':');
    if (!addrHex || !portHex) continue;
    const wildcard = isV6 ? /^0{32}$/.test(addrHex) : addrHex === '00000000';
    if (!wildcard) continue;
    sockets.push({ inode: parts[9], port: parseInt(portHex, 16) });
  }
  return sockets;
}

function getProcessSocketInodes(pid) {
  const inodes = new Set();
  let fds;
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch (e) {
    return inodes;
  }
  for (const fd of fds) {
    try {
      const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m) inodes.add(m[1]);
    } catch (e) {
      /* fd disappeared */
    }
  }
  return inodes;
}

function getContainerListeningPorts(containerId, pids) {
  const cached = cache.get(containerId);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.ports;

  purgeExpired(Date.now());

  const inodes = new Set();
  for (const pid of pids) {
    for (const inode of getProcessSocketInodes(pid)) inodes.add(inode);
  }

  const ports = new Set();
  if (inodes.size > 0) {
    for (const pid of pids) {
      let found = false;
      for (const socket of parseListenSockets(`/proc/${pid}/net/tcp`, false)) {
        if (inodes.has(socket.inode)) {
          ports.add(socket.port);
          found = true;
        }
      }
      for (const socket of parseListenSockets(`/proc/${pid}/net/tcp6`, true)) {
        if (inodes.has(socket.inode)) {
          ports.add(socket.port);
          found = true;
        }
      }
      if (found) break;
    }
  }

  const result = [...ports].sort((a, b) => a - b);
  cache.set(containerId, { ports: result, time: Date.now() });
  return result;
}

// Published TCP ports of a bridge-network container, as listContainers reports them.
function publishedTcpPorts(containerInfo) {
  const seen = new Set();
  return (containerInfo.Ports || [])
    .filter((p) => p.PublicPort && p.Type === 'tcp')
    .map((p) => ({ hostPort: p.PublicPort, containerPort: p.PrivatePort }))
    .filter((p) => {
      const key = `${p.hostPort}:${p.containerPort}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function getContainerPids(container) {
  const top = await container.top();
  const pidIdx = top.Titles.indexOf('PID');
  if (pidIdx === -1) return [];
  return top.Processes
    .map((p) => parseInt(p[pidIdx], 10))
    .filter((n) => Number.isFinite(n));
}

// Host-reachable TCP ports of a container. A `network_mode: host` container publishes
// nothing, so its listening sockets are read from /proc instead. Shared by
// /api/containers and the benchmark target discovery.
async function resolveContainerPorts(container, containerInfo, inspect) {
  if (inspect.HostConfig.NetworkMode === 'host' && containerInfo.State === 'running') {
    try {
      const pids = await getContainerPids(container);
      return getContainerListeningPorts(containerInfo.Id, pids).map((port) => ({
        hostPort: port,
        containerPort: port,
        hostNetwork: true,
      }));
    } catch (e) {
      return [];
    }
  }
  return publishedTcpPorts(containerInfo);
}

module.exports = { getContainerListeningPorts, resolveContainerPorts };
