// System updates: reads what the host already maintains, runs nothing itself.
// - summary comes from update-notifier's own file (kept fresh by apt-daily.timer).
// - packages comes from updates.json, written by the host's dgx-updates.timer
//   (see host/dgx-updates/). Either source can be missing; neither absence is a 500.
const express = require('express');
const fs = require('fs');

const router = express.Router();

const NOTIFIER_FILE = () => process.env.UPDATE_NOTIFIER_FILE || '/var/lib/update-notifier/updates-available';
const STAMP_FILE = () => process.env.APT_STAMP_FILE || '/var/lib/apt/periodic/update-success-stamp';
const PACKAGES_FILE = () => process.env.UPDATES_JSON || '/var/lib/spark-control-center/updates.json';

function readSummary() {
  const file = NOTIFIER_FILE();
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const total = content.match(/(\d+)\s+updates? can be applied immediately/);
  const security = content.match(/(\d+)\s+of these updates are standard security updates/);
  let checkedAt = null;
  try {
    checkedAt = fs.statSync(STAMP_FILE()).mtime.toISOString();
  } catch {
    /* stamp missing: leave checkedAt null */
  }
  return {
    total: total ? parseInt(total[1], 10) : 0,
    security: security ? parseInt(security[1], 10) : 0,
    esmEnabled: /Expanded Security Maintenance/.test(content),
    source: file,
    checkedAt,
  };
}

function readPackages() {
  try {
    const data = JSON.parse(fs.readFileSync(PACKAGES_FILE(), 'utf8'));
    return {
      packages: data.packages || [],
      packagesGeneratedAt: data.generatedAt || null,
      pipelineInstalled: true,
      note: null,
    };
  } catch {
    return {
      packages: [],
      packagesGeneratedAt: null,
      pipelineInstalled: false,
      note: 'Package list not available: install the dgx-updates timer (see README).',
    };
  }
}

router.get('/', (req, res) => {
  const { packages, packagesGeneratedAt, pipelineInstalled, note } = readPackages();
  res.json({ summary: readSummary(), packages, packagesGeneratedAt, pipelineInstalled, note });
});

module.exports = { router, readSummary };
