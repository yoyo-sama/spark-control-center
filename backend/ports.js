// Editing the published host port of a container. Changing it in Docker alone is
// pointless here: 47 of the 50 containers on this machine come from compose, and the
// next `docker compose up` would put the old port back. The durable edit is the
// `ports:` line of the compose file the container itself points at, through its
// `com.docker.compose.project.config_files` label.
//
// Like apps.js, no YAML serializer: the line is located textually and only the host
// port inside it is replaced, so comments, quoting and indentation survive. And like
// previewOpencode() refusing a JSONC file, anything that cannot be edited safely —
// an interpolated `${VAR}`, the long `target:`/`published:` syntax — is REFUSED with
// the fix to apply instead, never guessed at.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Docker = require('dockerode');
const { sha, applyPlan, buildLineDiff } = require('./apps');
const { collectContainerPorts } = require('./insights');

const router = express.Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const TTL = 5 * 60 * 1000;

const CONFIG_FILES = 'com.docker.compose.project.config_files';
const SERVICE = 'com.docker.compose.service';
const WORKING_DIR = 'com.docker.compose.project.working_dir';

// `- {target: 80, published: 8080}` or a `- target: 80` block: a mapping, not a string,
// so there is no single host-port token to swap.
const LONG_SYNTAX = /^\{|^(?:target|published|protocol|mode|host_ip|name)\s*:/;

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

function skippable(line) {
  return !line.trim() || /^\s*#/.test(line);
}

// Splits `"3000:3000"  # comment` into its quoting, its mapping and its comment.
function splitEntry(raw) {
  const quoted = raw.match(/^(["'])(.*?)\1(\s*#.*)?$/);
  if (quoted) return { quote: quoted[1], value: quoted[2], comment: quoted[3] || '' };
  const bare = raw.match(/^(.*?)(\s+#.*)?$/);
  return { quote: '', value: bare[1], comment: bare[2] || '' };
}

// Short syntax: `container`, `host:container`, `ip:host:container`, each port possibly
// carrying a `/protocol` suffix. Returns the index of the host-port element in `parts`.
function mapping(value) {
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  return {
    parts,
    hostIndex: parts.length - 2,
    host: parts[parts.length - 2].trim(),
    container: parts[parts.length - 1].trim().split('/')[0],
  };
}

// A path the app cannot see may simply not be mounted; only outside a container does
// "not found" actually mean "gone".
function inContainer() {
  return fs.existsSync('/.dockerenv');
}

/**
 * Pure: plain strings in, plain strings out. No Docker, no filesystem.
 * Returns { index, line, prefix, suffix } — the new line is `prefix + newHostPort + suffix`,
 * which preserves the original indentation, quoting and trailing comment — or { error }.
 * `projectDir` only makes the `${VAR}` refusal name a real .env path; it is optional.
 */
function findPortLine(composeText, serviceName, hostPort, containerPort, projectDir) {
  const lines = composeText.split('\n');
  const envFile = projectDir ? path.join(projectDir, '.env') : 'the .env file of the project directory';

  const servicesIdx = lines.findIndex((l) => /^\s*services:\s*(?:#.*)?$/.test(l));
  if (servicesIdx === -1) return { error: 'no `services:` block found.' };
  const servicesIndent = indentOf(lines[servicesIdx]);

  // The first key under `services:` sets the indent every service name sits at — a
  // compose file has several services and each may carry its own `ports:`, so the
  // block has to be narrowed to this service before anything else is looked at.
  let serviceIndent = null;
  let serviceIdx = -1;
  for (let i = servicesIdx + 1; i < lines.length; i++) {
    if (skippable(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind <= servicesIndent) break;
    if (serviceIndent === null) serviceIndent = ind;
    if (ind !== serviceIndent) continue;
    const m = lines[i].match(/^\s*([^\s:#]+):\s*(?:#.*)?$/);
    if (m && m[1] === serviceName) {
      serviceIdx = i;
      break;
    }
  }
  if (serviceIdx === -1) return { error: `service "${serviceName}" not found under \`services:\`.` };

  let portsIdx = -1;
  for (let i = serviceIdx + 1; i < lines.length; i++) {
    if (skippable(lines[i])) continue;
    if (indentOf(lines[i]) <= serviceIndent) break; // next service: this one is over
    if (/^\s*ports:\s*(?:#.*)?$/.test(lines[i])) {
      portsIdx = i;
      break;
    }
  }
  if (portsIdx === -1) {
    return { error: `service "${serviceName}" has no \`ports:\` block, so the published port is not declared there.` };
  }
  const portsIndent = indentOf(lines[portsIdx]);

  // A list item may be indented deeper than its key (`      - "3000:3000"` under
  // `    ports:`) or sit at the SAME indent (`    - ${FRONTEND_PORT:-3000}:80` under
  // `    ports:`). Both are valid YAML and both occur on this machine, so the scan
  // accepts indent >= the key's and stops at the first line that is not a list item.
  const entries = [];
  for (let i = portsIdx + 1; i < lines.length; i++) {
    if (skippable(lines[i])) continue;
    const item = lines[i].match(/^(\s*-\s+)(.*)$/);
    if (!item || indentOf(lines[i]) < portsIndent) break;
    entries.push({ index: i, prefix: item[1], ...splitEntry(item[2]) });
  }

  for (const e of entries) {
    if (e.value.includes('${') || LONG_SYNTAX.test(e.value)) continue;
    const m = mapping(e.value);
    if (!m || m.host !== String(hostPort) || m.container !== String(containerPort)) continue;
    const before = m.parts.slice(0, m.hostIndex).join(':');
    const after = m.parts.slice(m.hostIndex + 1).join(':');
    return {
      index: e.index,
      line: lines[e.index],
      prefix: e.prefix + e.quote + (before ? `${before}:` : ''),
      suffix: `:${after}${e.quote}${e.comment}`,
    };
  }

  // Nothing editable matched: say which shape got in the way rather than guessing.
  const interpolated = entries.find((e) => {
    if (!e.value.includes('${')) return false;
    const m = mapping(e.value.replace(/\$\{[^}]*\}/g, 'VAR'));
    return !m || m.container === String(containerPort);
  });
  if (interpolated) {
    const name = (interpolated.value.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)/) || [])[1] || 'the variable';
    return {
      error:
        `the \`ports:\` entry of service "${serviceName}" is \`${interpolated.value}\`: its host port comes from ` +
        `${name}. Set ${name} in ${envFile} instead — hard-coding it here would override every environment ` +
        'that compose file is used in.',
    };
  }

  const long = entries.find((e) => LONG_SYNTAX.test(e.value));
  if (long) {
    return {
      error:
        `service "${serviceName}" declares its ports with the long syntax (\`${long.value}\`): edit the ` +
        '`published:` value by hand, this pipeline only rewrites the short `host:container` form.',
    };
  }

  return {
    error:
      `service "${serviceName}" has a \`ports:\` block but no entry publishing ${hostPort}:${containerPort}` +
      `${entries.length ? ` (found: ${entries.map((e) => e.value).join(', ')})` : ' (the block is empty)'}.`,
  };
}

// The configured bindings, which is what `docker compose up` will re-publish — unlike
// NetworkSettings.Ports, which is empty for a stopped container, i.e. for exactly the
// containers worth repointing.
function portBindings(inspect) {
  const out = [];
  for (const [key, list] of Object.entries((inspect.HostConfig && inspect.HostConfig.PortBindings) || {})) {
    const [containerPort, protocol = 'tcp'] = key.split('/');
    for (const b of list || []) out.push({ hostPort: b.HostPort, containerPort, protocol });
  }
  return out;
}

function err(message, status) {
  return { error: message, status: status || 400 };
}

// Returns { error, status } or { response, plan }.
async function previewPort(id, body) {
  let inspect;
  try {
    inspect = await docker.getContainer(id).inspect();
  } catch (e) {
    if (e.statusCode === 404) return err(`No container named ${id}`, 404);
    return err(`Docker: ${e.message}`, 500);
  }

  const newHostPort = body.newHostPort;
  if (!Number.isInteger(newHostPort) || newHostPort < 1 || newHostPort > 65535) {
    return err('newHostPort must be an integer in [1, 65535]');
  }

  const name = inspect.Name.replace('/', '');
  const binding = portBindings(inspect).find(
    (b) => String(b.hostPort) === String(body.hostPort) && String(b.containerPort) === String(body.containerPort)
  );
  if (!binding) return err(`${body.hostPort}:${body.containerPort} is not one of ${name}'s published ports.`);
  if (String(binding.hostPort) === String(newHostPort)) return err(`${name} already publishes host port ${newHostPort}.`);

  const labels = inspect.Config.Labels || {};
  if (!labels[CONFIG_FILES]) {
    return err(
      `${name} was not created by docker compose (no ${CONFIG_FILES} label): there is no file to edit. Its port ` +
        'only exists in the container, so the durable fix is to recreate it with the port you want ' +
        '(`docker run -p <new>:<container> ...`), or to move it into a compose file.'
    );
  }
  const candidates = labels[CONFIG_FILES].split(',').map((s) => s.trim()).filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    // Inside a container, "not found" has two very different causes and saying the wrong
    // one sends the user hunting for a project that is sitting right there on the host.
    // Only the host path being unmounted is indistinguishable from deletion from in here.
    return err(
      inContainer()
        ? `${name} points at ${candidates.join(', ')}, which is not visible from this container. If the project ` +
            'still exists on the host, its directory has to be mounted into Spark Control Center (see the volumes ' +
            'section of docker-compose.yml) before its port can be edited.'
        : `${name} points at ${candidates.join(', ')}, which does not exist (moved or deleted project). Nothing can ` +
            'be edited: recreate the container from a compose file that exists, or remove it.'
    );
  }
  const service = labels[SERVICE];
  if (!service) return err(`${name} carries no ${SERVICE} label: cannot tell which service of ${file} to edit.`);

  const content = fs.readFileSync(file, 'utf8');
  const found = findPortLine(content, service, binding.hostPort, binding.containerPort, path.dirname(file));
  if (found.error) return err(`${file}: ${found.error}`);

  const lines = content.split('\n');
  const newLines = lines.slice();
  newLines[found.index] = found.prefix + newHostPort + found.suffix;

  const warnings = [];
  try {
    const other = (await collectContainerPorts()).find(
      (c) => c.name !== name && c.hostPorts.includes(String(newHostPort))
    );
    if (other) {
      // A stopped holder binds nothing today: that is latent, not broken — the same
      // distinction findPortConflicts() makes in insights.js.
      warnings.push(
        other.running
          ? `Host port ${newHostPort} is already published by ${other.name}, which is running: ${name} would hit the same wall it is stuck behind today.`
          : `Host port ${newHostPort} is also published by ${other.name}, which is stopped: nothing is bound today, but whichever of the two starts second will fail.`
      );
    }
  } catch {
    /* Docker socket unavailable: one warning missing, not a failed preview */
  }
  if (inspect.State.Running) {
    warnings.push(
      `${name} is running and keeps publishing ${binding.hostPort}->${binding.containerPort} until it is recreated.`
    );
  }

  return {
    response: {
      token: crypto.randomUUID(),
      file,
      summary: `Line ${found.index + 1} of ${path.basename(file)}: host port ${binding.hostPort} → ${newHostPort} for service "${service}"`,
      diff: buildLineDiff(lines, newLines),
      warnings,
      restart: {
        kind: 'recreate',
        containerName: name,
        command: 'docker compose up -d',
        cwd: labels[WORKING_DIR] || path.dirname(file),
        cost: 'Container recreation: compose re-reads the ports: line and republishes the container on the new host port.',
      },
    },
    plan: { target: 'ports', file, hash: sha(content), content: newLines.join('\n') },
  };
}

// ---------- routes ----------

const previews = new Map(); // token -> { plan, restart, createdAt }

router.post('/:id/preview', async (req, res) => {
  const r = await previewPort(req.params.id, req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  // A preview that is never applied would otherwise stay in the Map forever.
  for (const [t, e] of previews) if (Date.now() - e.createdAt > TTL) previews.delete(t);
  previews.set(r.response.token, { plan: r.plan, restart: r.response.restart, createdAt: Date.now() });
  res.json(r.response);
});

router.post('/:id/apply', (req, res) => {
  const entry = previews.get((req.body || {}).token);
  if (!entry || Date.now() - entry.createdAt > TTL) {
    return res.status(400).json({ error: 'Preview expired, run the preview again' });
  }
  previews.delete(req.body.token);
  const r = applyPlan(entry.plan);
  if (r.conflict) return res.status(409).json({ error: 'The file changed since the preview, run the preview again' });
  res.json({ ok: true, backup: r.backup, restart: entry.restart });
});

module.exports = { router, findPortLine, portBindings };
