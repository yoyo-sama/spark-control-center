// Skills manager. Skills are a SHARED resource: opencode loads ~/.claude/skills and
// ~/.agents/skills automatically, on top of its own dir — there is no sharing switch to
// implement, and editing the wrong copy of a duplicated skill is the real trap (hence
// `duplicateIn`). The critical boundary here is `import`: it writes a file that TWO AI
// tools will load without asking, so everything about it is validated and shown in full
// in the preview diff.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writePreserving, applyPlan, sha, buildLineDiff } = require('./apps');

const router = express.Router();

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_IMPORT = 256 * 1024;
const TTL = 5 * 60 * 1000;

const RESTART = {
  kind: 'none',
  containerName: null,
  command: null,
  cwd: null,
  cost: 'Skills are loaded at startup: quit and restart opencode or Claude Code for the change to take effect.',
};

// Precedence order: the first root holding a given name is the one the tools resolve.
function roots() {
  return [
    { id: 'claude', path: process.env.SKILLS_CLAUDE_DIR || '/home/sparks/.claude/skills' },
    { id: 'agents', path: process.env.SKILLS_AGENTS_DIR || '/home/sparks/.agents/skills' },
    { id: 'opencode', path: process.env.SKILLS_OPENCODE_DIR || '/home/sparks/.config/opencode/skills' },
  ];
}

function claudeRoot() {
  return roots()[0].path;
}

// Three lines of YAML is all a SKILL.md header is: the block between the two `---`.
function frontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end === -1) return {};
  const out = {};
  for (const l of lines.slice(1, end)) {
    const m = l.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// `wc -l` semantics (count of newlines), so the number matches what the user sees in a shell.
function countLines(content) {
  return content.split('\n').length - 1;
}

// null when the root does not exist / cannot be read — never a 500.
function scanRoot(root) {
  let entries;
  try {
    entries = fs.readdirSync(root.path, { withFileTypes: true });
  } catch {
    return null;
  }
  const out = [];
  for (const d of entries) {
    const dir = path.join(root.path, d.name);
    const file = path.join(dir, 'SKILL.md');
    let content;
    try {
      content = fs.readFileSync(file, 'utf8'); // not a skill directory => skipped
    } catch {
      continue;
    }
    const fm = frontmatter(content);
    let symlink = null;
    if (d.isSymbolicLink()) {
      try {
        symlink = fs.realpathSync(dir);
      } catch {
        symlink = fs.readlinkSync(dir);
      }
    }
    out.push({
      name: fm.name || d.name.replace(/\.disabled$/, ''),
      description: fm.description || '',
      root: root.id,
      dir: d.name,
      path: dir,
      file,
      enabled: !d.name.endsWith('.disabled'),
      symlink,
      duplicateIn: [],
      lines: countLines(content),
    });
  }
  return out;
}

function scanSkills() {
  const rootInfo = [];
  const byName = new Map();
  for (const r of roots()) {
    const found = scanRoot(r);
    rootInfo.push({ id: r.id, path: r.path, exists: found !== null });
    for (const s of found || []) {
      const prev = byName.get(s.name);
      if (prev) prev.duplicateIn.push(r.id);
      else byName.set(s.name, s);
    }
  }
  return { roots: rootInfo, skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function findSkill(name) {
  return scanSkills().skills.find((s) => s.name === name || s.dir === name);
}

function err(message, status) {
  return { error: message, status: status || 400 };
}

function symlinkGuard(s) {
  return s.symlink
    ? err(`${s.name} is a symlink into ${s.symlink}: editing it would modify that plugin.`, 409)
    : null;
}

// Trust boundary: the written path must be a DIRECT child of the claude root, whatever
// the name looks like. NAME_RE already rejects `..` and `/`; this is the belt.
function skillDirFor(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { error: `name must match ${NAME_RE.source}` };
  }
  const root = path.resolve(claudeRoot());
  const dir = path.resolve(path.join(root, name));
  if (path.dirname(dir) !== root) return { error: `${name} does not resolve inside ${root}` };
  return { dir };
}

async function fetchSkill(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: 'url is not a valid URL' };
  }
  if (u.protocol !== 'https:') return { error: `url must use https: (got ${u.protocol})` };
  let r;
  try {
    r = await fetch(u, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
  } catch (e) {
    return { error: `fetch failed: ${e.message}` };
  }
  if (!r.ok) return { error: `fetch failed: HTTP ${r.status}` };
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_IMPORT) return { error: `content exceeds ${MAX_IMPORT} bytes` };
  const text = await r.text();
  if (Buffer.byteLength(text) > MAX_IMPORT) return { error: `content exceeds ${MAX_IMPORT} bytes` };
  return { text };
}

function allAdded(content) {
  return content.split('\n').map((text) => ({ kind: 'added', line: null, text }));
}

// Returns { error, status } or { response, plan }.
async function previewSkill(body) {
  const target = body && body.target;

  if (target === 'toggle') {
    if (typeof body.enabled !== 'boolean') return err('enabled must be a boolean');
    const s = findSkill(body.name);
    if (!s) return err(`Unknown skill: ${body.name}`);
    const guard = symlinkGuard(s);
    if (guard) return guard;
    const base = s.dir.replace(/\.disabled$/, '');
    const to = path.join(path.dirname(s.path), body.enabled ? base : `${base}.disabled`);
    return {
      response: {
        token: crypto.randomUUID(),
        file: s.path,
        summary:
          s.path === to
            ? `${s.name} is already ${body.enabled ? 'enabled' : 'disabled'}, no rename`
            : `Renaming ${path.basename(s.path)} → ${path.basename(to)}`,
        diff: [],
        warnings: [],
        restart: { ...RESTART },
      },
      // 'script' is the existing rename plan shape in apps.js — same primitive, reused.
      plan: { target: 'script', file: s.path, hash: sha(s.path), from: s.path, to },
    };
  }

  if (target === 'content') {
    const s = findSkill(body.name);
    if (!s) return err(`Unknown skill: ${body.name}`);
    const guard = symlinkGuard(s);
    if (guard) return guard;
    if (typeof body.value !== 'string' || !body.value.trim()) return err('value must be a non-empty string');
    const fm = frontmatter(body.value);
    if (!fm.name || !fm.description) return err('value must start with a frontmatter carrying name: and description:');
    const current = fs.readFileSync(s.file, 'utf8');
    return {
      response: {
        token: crypto.randomUUID(),
        file: s.file,
        summary: `${s.file} rewritten (${countLines(current)} → ${countLines(body.value)} lines)`,
        diff: buildLineDiff(current.split('\n'), body.value.split('\n')),
        warnings: [],
        restart: { ...RESTART },
      },
      plan: { target: 'skill-content', file: s.file, hash: sha(current), content: body.value },
    };
  }

  if (target === 'create' || target === 'import') {
    const d = skillDirFor(body.name);
    if (d.error) return err(d.error);
    if (fs.existsSync(d.dir) || findSkill(body.name)) {
      return err(`${body.name} already exists: use target "content" to replace its SKILL.md`, 409);
    }

    const warnings = [];
    let content;
    if (target === 'import' && body.url !== undefined) {
      const got = await fetchSkill(body.url);
      if (got.error) return err(got.error);
      content = got.text;
      warnings.push(
        `Imported from ${body.url}. Review the content below before writing: both opencode and Claude Code load skills automatically.`
      );
    } else {
      if (typeof body.value !== 'string' || !body.value.trim()) return err('value must be a non-empty string');
      if (Buffer.byteLength(body.value) > MAX_IMPORT) return err(`content exceeds ${MAX_IMPORT} bytes`);
      content = body.value;
      // create is the only path that may synthesize the header from the form fields.
      if (target === 'create' && !frontmatter(content).name) {
        content = `---\nname: ${body.name}\ndescription: ${body.description || ''}\n---\n\n${content}`;
      }
    }

    const fm = frontmatter(content);
    if (!fm.name || !fm.description) {
      return err('content must start with a frontmatter carrying name: and description:');
    }

    const st = fs.statSync(claudeRoot());
    const file = path.join(d.dir, 'SKILL.md');
    return {
      response: {
        token: crypto.randomUUID(),
        file,
        summary: `Creating ${file} (${countLines(content)} lines)`,
        diff: allAdded(content), // the whole content: the only chance to read it before it goes live
        warnings,
        restart: { ...RESTART },
      },
      plan: { target: 'skill-create', file, dir: d.dir, content, uid: st.uid, gid: st.gid },
    };
  }

  return err('target must be "toggle", "content", "create" or "import"');
}

function applySkill(plan) {
  if (plan.target !== 'skill-create') return applyPlan(plan); // rename / backup+atomic rewrite
  if (fs.existsSync(plan.file)) return { conflict: true };
  fs.mkdirSync(plan.dir, { recursive: true });
  try {
    fs.chownSync(plan.dir, plan.uid, plan.gid);
  } catch {
    /* not root and already owned: nothing to do */
  }
  writePreserving(plan.file, plan.content, 0o644, plan.uid, plan.gid);
  return { ok: true, backup: null };
}

// ---------- routes ----------

const previews = new Map(); // token -> { plan, restart, createdAt }

router.get('/', (req, res) => {
  res.json(scanSkills());
});

router.get('/:name', (req, res) => {
  const s = findSkill(req.params.name);
  if (!s) return res.status(404).json({ error: 'Unknown skill' });
  res.json({ ...s, content: fs.readFileSync(s.file, 'utf8') });
});

router.post('/preview', async (req, res) => {
  const r = await previewSkill(req.body || {});
  if (r.error) return res.status(r.status).json({ error: r.error });
  previews.set(r.response.token, { plan: r.plan, restart: r.response.restart, createdAt: Date.now() });
  res.json(r.response);
});

router.post('/apply', (req, res) => {
  const entry = previews.get((req.body || {}).token);
  if (!entry || Date.now() - entry.createdAt > TTL) {
    return res.status(400).json({ error: 'Preview expired, run the preview again' });
  }
  previews.delete(req.body.token);
  const r = applySkill(entry.plan);
  if (r.conflict) return res.status(409).json({ error: 'The file changed since the preview, run the preview again' });
  res.json({ ok: true, backup: r.backup, restart: entry.restart });
});

module.exports = { router, scanSkills };
