// Collects the facts once, runs rules.js against them, sorts by severity.
const express = require('express');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const { APPS } = require('./apps');
const RULES = require('./rules');
const { readSummary } = require('./updates');

const router = express.Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const STATE_FILE = path.join(process.env.GB10_STATE_DIR || '/etc/gb10-tuning', 'state.json');

const ORDER = { high: 0, medium: 1, low: 2 };

function gpuClockCapSet() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return state.gpuClockLimitMhz !== undefined && state.gpuClockLimitMhz !== null;
  } catch {
    return false;
  }
}

function vmSwappiness() {
  try {
    return parseInt(fs.readFileSync('/proc/sys/vm/swappiness', 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function updatesFacts() {
  const summary = readSummary();
  return summary ? { total: summary.total, security: summary.security } : null;
}

// Pure: takes the normalized list built by portConflictsFacts() below, never touches
// Docker, so it's unit-testable with plain arrays. A conflict only exists when a
// STOPPED container wants a host port a DIFFERENT RUNNING container currently holds —
// two running containers can't conflict (Docker would have refused the second one to
// start), and two stopped containers wanting the same port is latent, not broken.
function findPortConflicts(containers) {
  const heldBy = new Map(); // host port -> name of the running container holding it
  for (const c of containers) {
    if (!c.running) continue;
    for (const port of c.hostPorts) {
      if (!heldBy.has(port)) heldBy.set(port, c.name);
    }
  }

  const conflicts = [];
  for (const c of containers) {
    if (c.running) continue;
    for (const port of c.hostPorts) {
      const owner = heldBy.get(port);
      if (owner && owner !== c.name) conflicts.push({ name: c.name, port, heldBy: owner, restartPolicy: c.restartPolicy });
    }
  }
  return conflicts;
}

// listContainers({ all: true }) leaves Ports empty for anything not running — the
// configured bindings only live in inspect().HostConfig.PortBindings — so, like
// /api/containers in index.js, every container has to be inspected individually.
async function portConflictsFacts() {
  try {
    const containers = await docker.listContainers({ all: true });
    const normalized = await Promise.all(containers.map(async (info) => {
      const inspect = await docker.getContainer(info.Id).inspect();
      const bindings = inspect.HostConfig.PortBindings || {};
      const hostPorts = [...new Set(Object.values(bindings).flat().filter(Boolean).map((b) => b.HostPort))];
      return {
        name: info.Names[0].replace('/', ''),
        running: inspect.State.Running,
        restartPolicy: inspect.HostConfig.RestartPolicy.Name,
        hostPorts,
      };
    }));
    return findPortConflicts(normalized);
  } catch {
    return []; // Docker socket unavailable: no facts, not a 500
  }
}

async function collectFacts() {
  const facts = {
    gpuClockCapSet: gpuClockCapSet(),
    vmSwappiness: vmSwappiness(),
    updates: updatesFacts(),
    portConflicts: await portConflictsFacts(),
  };
  for (const app of APPS) facts[app.id] = await app.facts();
  return facts;
}

router.get('/', async (req, res) => {
  const facts = await collectFacts();
  const insights = RULES.filter((r) => r.detect(facts))
    .map(({ id, severity, target, title, why, action }) => {
      const app = APPS.find((a) => a.id === target);
      const resolvedSeverity = typeof severity === 'function' ? severity(facts) : severity;
      const resolvedWhy = typeof why === 'function' ? why(facts) : why;
      return { id, severity: resolvedSeverity, target, title, why: resolvedWhy, action: !app || app.hidden ? null : action };
    })
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  res.json({ insights });
});

module.exports = { router, collectFacts, findPortConflicts, portConflictsFacts };
