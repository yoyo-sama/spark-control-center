// Collects the facts once, runs rules.js against them, sorts by severity.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { APPS } = require('./apps');
const RULES = require('./rules');

const router = express.Router();
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

async function collectFacts() {
  const facts = { gpuClockCapSet: gpuClockCapSet(), vmSwappiness: vmSwappiness() };
  for (const app of APPS) facts[app.id] = await app.facts();
  return facts;
}

router.get('/', async (req, res) => {
  const facts = await collectFacts();
  const insights = RULES.filter((r) => r.detect(facts))
    .map(({ id, severity, target, title, why, action }) => ({ id, severity, target, title, why, action }))
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  res.json({ insights });
});

module.exports = { router, collectFacts };
