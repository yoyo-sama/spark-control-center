// System updates: reads what the host already maintains, runs nothing itself.
// - counts come from updates.json (apt-check's machine-readable "total;security"),
//   written by the host's dgx-updates.timer (see host/dgx-updates/). Without them,
//   they are parsed from update-notifier's own file, whose sentences follow the
//   system locale: only the English ones are understood, anything else reads 0.
// - packages comes from updates.json too. Either source can be missing; neither
//   absence is a 500.
const express = require('express');
const fs = require('fs');

const router = express.Router();

const NOTIFIER_FILE = () => process.env.UPDATE_NOTIFIER_FILE || '/var/lib/update-notifier/updates-available';
const STAMP_FILE = () => process.env.APT_STAMP_FILE || '/var/lib/apt/periodic/update-success-stamp';
const PACKAGES_FILE = () => process.env.UPDATES_JSON || '/var/lib/spark-control-center/updates.json';

function readUpdatesJson() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGES_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

function readSummary(data = readUpdatesJson()) {
  const file = NOTIFIER_FILE();
  let content = null;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    /* notifier file missing: counts can still come from updates.json */
  }
  const counted = data && Number.isInteger(data.total) && Number.isInteger(data.security);
  if (content === null && !counted) return null;
  let total = 0;
  let security = 0;
  if (counted) {
    total = data.total;
    security = data.security;
  } else {
    const t = content.match(/(\d+)\s+updates? can be applied immediately/);
    const s = content.match(/(\d+)\s+of these updates (?:is a|are) standard security updates?/);
    total = t ? parseInt(t[1], 10) : 0;
    security = s ? parseInt(s[1], 10) : 0;
  }
  let checkedAt = null;
  try {
    checkedAt = fs.statSync(STAMP_FILE()).mtime.toISOString();
  } catch {
    /* stamp missing: leave checkedAt null */
  }
  return {
    total,
    security,
    // English, or French ("maintenance de sécurité étendue") on a French system.
    esmEnabled: content !== null && /Expanded Security Maintenance|maintenance de s[ée]curit[ée] [ée]tendue/i.test(content),
    source: counted ? PACKAGES_FILE() : file,
    checkedAt,
  };
}

function readPackages(data) {
  if (data) {
    return {
      packages: data.packages || [],
      packagesGeneratedAt: data.generatedAt || null,
      pipelineInstalled: true,
      note: null,
    };
  }
  return {
    packages: [],
    packagesGeneratedAt: null,
    pipelineInstalled: false,
    note: 'Package list not available: install the dgx-updates timer (see README).',
  };
}

router.get('/', (req, res) => {
  const data = readUpdatesJson();
  const { packages, packagesGeneratedAt, pipelineInstalled, note } = readPackages(data);
  res.json({ summary: readSummary(data), packages, packagesGeneratedAt, pipelineInstalled, note });
});

module.exports = { router, readSummary, readPackages };
