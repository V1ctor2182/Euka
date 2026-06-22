#!/usr/bin/env node
// Smoke for 11-autopilot-ui-reframe m3: the Jobs page "让机器投" enqueue contract.
//   POST /api/career/autopilot/enqueue {jobId} → appends to the manual queue
//   GET  /api/career/autopilot/queue          → { queue: [...] }
// The forced-pass selection (queued jobs bypass the score threshold) is covered
// by smoke-autopilot-orchestrator.mjs (tick-9h/9i); this locks the HTTP surface
// the JobCard button + machine-state map consume.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PORT = 4588;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.error('FAIL:', name); console.error(e); await cleanup(); process.exit(1); }
}

const QUEUE = path.resolve('data', 'career', 'autopilot-queue.json');
const SUF = `.smoke-backup.${process.pid}`;
await fs.mkdir(path.dirname(QUEUE), { recursive: true });
async function backup(f) { try { await fs.copyFile(f, f + SUF); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function restore(f, had) { if (had) await fs.rename(f + SUF, f).catch(() => {}); else await fs.unlink(f).catch(() => {}); }
const qBack = await backup(QUEUE);
await fs.unlink(QUEUE).catch(() => {}); // start clean

const proc = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), DISABLE_SCAN_SCHEDULER: '1', DISABLE_AUTOPILOT_ENGINE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = false;
proc.stdout.on('data', (b) => { if (b.toString().includes(`API server on :${PORT}`)) ready = true; });
proc.stderr.on('data', () => {});
const t0 = Date.now();
while (!ready) { if (Date.now() - t0 > 15_000) { proc.kill(); throw new Error('server not ready'); } await new Promise((r) => setTimeout(r, 100)); }

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(QUEUE, qBack);
}

const J1 = 'aaaaaaaaaaaa';
const J2 = 'bbbbbbbbbbbb';

try {
  await test('queue starts empty', async () => {
    const j = await (await fetch(`${BASE}/api/career/autopilot/queue`)).json();
    assert.deepEqual(j.queue, []);
  });

  await test('POST /enqueue appends jobId (202) + GET /queue reflects it', async () => {
    const r = await fetch(`${BASE}/api/career/autopilot/enqueue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: J1 }),
    });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.equal(body.queued, true);
    assert.ok(body.queue.includes(J1));
    const j = await (await fetch(`${BASE}/api/career/autopilot/queue`)).json();
    assert.deepEqual(j.queue, [J1]);
  });

  await test('enqueue is idempotent (no dup) + supports multiple jobs', async () => {
    await fetch(`${BASE}/api/career/autopilot/enqueue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: J1 }) });
    await fetch(`${BASE}/api/career/autopilot/enqueue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: J2 }) });
    const j = await (await fetch(`${BASE}/api/career/autopilot/queue`)).json();
    assert.deepEqual(j.queue.sort(), [J1, J2].sort());
  });

  await test('enqueue rejects a non-12-hex jobId → 400', async () => {
    const r = await fetch(`${BASE}/api/career/autopilot/enqueue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'nope' }),
    });
    assert.equal(r.status, 400);
  });

  console.log(`\n${passed} passed`);
} finally {
  await cleanup();
}
