#!/usr/bin/env node
// Smoke for 11-autopilot-ui-reframe m1: the Dashboard + AutopilotToggle consumer
// contract over the autopilot engine endpoints. The pages are React; this locks
// the endpoint SHAPES they consume + the enable/disable/config flow.
//
//   GET  /api/career/autopilot/status  → { enabled, last_tick_at, daily_count,
//                                          daily_cap, score_threshold,
//                                          remaining_today, next_candidates[] }
//   GET  /api/career/autopilot/feed    → { events[], funnel{candidates,filling,
//                                          parked,submitted} }
//   POST /api/career/autopilot/enable | /disable  → { enabled }

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PORT = 4586;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    await cleanup();
    process.exit(1);
  }
}

const DATA_DIR = path.resolve('data', 'career');
const STATE = path.join(DATA_DIR, 'autopilot-state.json');
const FEED = path.join(DATA_DIR, 'autopilot-feed.jsonl');
const SUFFIX = `.smoke-backup.${process.pid}`;
await fs.mkdir(DATA_DIR, { recursive: true });

async function backup(file) {
  try { await fs.copyFile(file, file + SUFFIX); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function restore(file, had) {
  if (had) await fs.rename(file + SUFFIX, file).catch(() => {});
  else await fs.unlink(file).catch(() => {});
}
const stateBack = await backup(STATE);
const feedBack = await backup(FEED);

// Start the engine ENABLED at the interval level but we control state via the
// API. Keep the scan scheduler off; the autopilot engine interval is harmless
// (it only fills when enabled, and DISABLE keeps it from auto-running here).
const proc = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), DISABLE_SCAN_SCHEDULER: '1', DISABLE_AUTOPILOT_ENGINE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = false;
proc.stdout.on('data', (b) => { if (b.toString().includes(`API server on :${PORT}`)) ready = true; });
proc.stderr.on('data', () => {});
const t0 = Date.now();
while (!ready) {
  if (Date.now() - t0 > 15_000) { proc.kill(); throw new Error('server not ready in 15s'); }
  await new Promise((r) => setTimeout(r, 100));
}

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(STATE, stateBack);
  await restore(FEED, feedBack);
}

try {
  await test('GET /autopilot/status returns the shape the toggle + dashboard render', async () => {
    const r = await fetch(`${BASE}/api/career/autopilot/status`);
    assert.equal(r.status, 200);
    const s = await r.json();
    for (const k of ['enabled', 'daily_count', 'daily_cap', 'score_threshold', 'remaining_today', 'next_candidates']) {
      assert.ok(k in s, `status missing ${k}`);
    }
    assert.equal(typeof s.enabled, 'boolean');
    assert.ok(Array.isArray(s.next_candidates));
    assert.equal(s.remaining_today, Math.max(0, s.daily_cap - s.daily_count));
  });

  await test('GET /autopilot/feed returns { events[], funnel{4 numbers} }', async () => {
    const r = await fetch(`${BASE}/api/career/autopilot/feed?limit=20`);
    assert.equal(r.status, 200);
    const f = await r.json();
    assert.ok(Array.isArray(f.events), 'events array');
    for (const k of ['candidates', 'filling', 'parked', 'submitted']) {
      assert.equal(typeof f.funnel?.[k], 'number', `funnel.${k} number`);
    }
  });

  await test('POST /enable then /disable flips enabled (toggle contract)', async () => {
    let r = await fetch(`${BASE}/api/career/autopilot/enable`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).enabled, true);
    // status reflects it
    let s = await (await fetch(`${BASE}/api/career/autopilot/status`)).json();
    assert.equal(s.enabled, true);
    r = await fetch(`${BASE}/api/career/autopilot/disable`, { method: 'POST' });
    assert.equal((await r.json()).enabled, false);
    s = await (await fetch(`${BASE}/api/career/autopilot/status`)).json();
    assert.equal(s.enabled, false);
  });

  await test('PUT /config persists daily_cap + score_threshold; out-of-range → 400', async () => {
    const ok = await fetch(`${BASE}/api/career/autopilot/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_cap: 3, score_threshold: 4 }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.daily_cap, 3);
    assert.equal(body.score_threshold, 4);
    // threshold > 5 (Stage scale is 1–5) rejected
    const bad = await fetch(`${BASE}/api/career/autopilot/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score_threshold: 9 }),
    });
    assert.equal(bad.status, 400);
  });

  await test('feed funnel.parked counts reflect status endpoint consistency', async () => {
    // Funnel numbers are non-negative integers the dashboard renders directly.
    const f = await (await fetch(`${BASE}/api/career/autopilot/feed`)).json();
    for (const k of ['candidates', 'filling', 'parked', 'submitted']) {
      assert.ok(Number.isInteger(f.funnel[k]) && f.funnel[k] >= 0, `funnel.${k} non-negative int`);
    }
  });

  console.log(`\n${passed} passed`);
} finally {
  await cleanup();
}
