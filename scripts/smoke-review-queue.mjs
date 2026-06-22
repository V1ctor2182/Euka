#!/usr/bin/env node
// Smoke for 11-autopilot-ui-reframe m2: the Review page consumer contract over
//   GET  /api/career/autopilot/review   (grouped buckets the page renders)
//   POST /api/career/autopilot/bank-answer    (the answer-banking flywheel)
//
// Seeds real apply-session files (paused / abandoned / active) and a pipeline
// row, then asserts bucketing + the qa-bank append.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PORT = 4587;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.error('FAIL:', name); console.error(e); await cleanup(); process.exit(1); }
}

const CAREER = path.resolve('data', 'career');
const SESS_DIR = path.join(CAREER, 'apply-sessions');
const PIPELINE = path.join(CAREER, 'pipeline.json');
const QA_HIST = path.join(CAREER, 'qa-bank', 'history.jsonl');
const SUF = `.smoke-backup.${process.pid}`;
await fs.mkdir(SESS_DIR, { recursive: true });
await fs.mkdir(path.dirname(QA_HIST), { recursive: true });

async function backup(f) { try { await fs.copyFile(f, f + SUF); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function restore(f, had) { if (had) await fs.rename(f + SUF, f).catch(() => {}); else await fs.unlink(f).catch(() => {}); }
const pipeBack = await backup(PIPELINE);
const qaBack = await backup(QA_HIST);

// Seeded session jobIds (12-hex). Track to clean up.
const SEED = {
  paused: 'aaaaaaaaaaaa',     // paused, ready_for_submit → submit bucket
  abandoned: 'bbbbbbbbbbbb',  // abandoned → failed bucket
  active: 'cccccccccccc',     // active → filling bucket
  errored: 'dddddddddddd',    // paused but terminal_outcome=error → failed (restart-safe)
};

function session(jobId, status, extra = {}) {
  const now = new Date().toISOString();
  return {
    jobId,
    site_adapter: 'generic', // greenhouse/ashby/lever all fill via the generic adapter
    job_url: `https://job-boards.greenhouse.io/acme/jobs/${jobId}`,
    current_step: 1,
    total_steps: 2,
    per_step_draft: {},
    per_step_status: { '0': 'approved', '1': 'filled' },
    field_memory: {},
    started_at: now,
    last_activity_at: now,
    status,
    submit_attempts: [],
    user_hints: [],
    ...extra,
  };
}

async function seed() {
  await fs.writeFile(path.join(SESS_DIR, `${SEED.paused}.json`), JSON.stringify(session(SEED.paused, 'paused', { terminal_outcome: 'escalated', escalation_code: 'ready_for_submit' }), null, 2));
  await fs.writeFile(path.join(SESS_DIR, `${SEED.abandoned}.json`), JSON.stringify(session(SEED.abandoned, 'abandoned'), null, 2));
  await fs.writeFile(path.join(SESS_DIR, `${SEED.active}.json`), JSON.stringify(session(SEED.active, 'active'), null, 2));
  await fs.writeFile(path.join(SESS_DIR, `${SEED.errored}.json`), JSON.stringify(session(SEED.errored, 'paused', { terminal_outcome: 'error', escalation_code: null }), null, 2));
  await fs.writeFile(PIPELINE, JSON.stringify({
    last_scan_at: new Date().toISOString(),
    jobs: [{ id: SEED.paused, company: 'Acme', role: 'SWE', url: `https://job-boards.greenhouse.io/acme/jobs/${SEED.paused}` }],
    scan_summary: {}, totals: {},
  }, null, 2));
}

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
  for (const id of Object.values(SEED)) await fs.unlink(path.join(SESS_DIR, `${id}.json`)).catch(() => {});
  await restore(PIPELINE, pipeBack);
  await restore(QA_HIST, qaBack);
}

try {
  await seed();

  await test('GET /review buckets paused→submit, abandoned→failed, active→filling', async () => {
    const r = await fetch(`${BASE}/api/career/autopilot/review`);
    assert.equal(r.status, 200);
    const j = await r.json();
    const ids = (g) => j.groups[g].map((x) => x.jobId);
    assert.ok(ids('submit').includes(SEED.paused), 'paused+ready_for_submit → submit');
    assert.ok(ids('failed').includes(SEED.abandoned), 'abandoned → failed');
    assert.ok(ids('filling').includes(SEED.active), 'active → filling');
    assert.ok(ids('failed').includes(SEED.errored), 'paused+terminal_outcome=error → failed (restart-safe)');
    assert.ok(!ids('submit').includes(SEED.errored), 'errored NOT in submit');
    assert.equal(j.counts.submit, j.groups.submit.length);
  });

  await test('GET /review joins pipeline for company/role + filledCount', async () => {
    const j = await (await fetch(`${BASE}/api/career/autopilot/review`)).json();
    const item = j.groups.submit.find((x) => x.jobId === SEED.paused);
    assert.equal(item.company, 'Acme');
    assert.equal(item.role, 'SWE');
    assert.equal(item.filledCount, 2); // both steps approved/filled
    assert.equal(item.ats, 'generic'); // site_adapter that drove the fill
  });

  await test('POST /qa-bank/history appends one line (flywheel)', async () => {
    const before = await fs.readFile(QA_HIST, 'utf-8').catch(() => '');
    const r = await fetch(`${BASE}/api/career/autopilot/bank-answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Why this company?', final_answer: 'Because mission.', jobId: SEED.paused }),
    });
    assert.equal(r.status, 201);
    const after = await fs.readFile(QA_HIST, 'utf-8');
    assert.equal(after.split('\n').filter(Boolean).length, before.split('\n').filter(Boolean).length + 1);
    const last = JSON.parse(after.trim().split('\n').pop());
    assert.equal(last.label, 'Why this company?');
    assert.equal(last.final_answer, 'Because mission.');
    assert.equal(last.class, 'open'); // default
  });

  await test('POST /qa-bank/history rejects empty answer → 400', async () => {
    const r = await fetch(`${BASE}/api/career/autopilot/bank-answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x', final_answer: '' }),
    });
    assert.equal(r.status, 400);
  });

  console.log(`\n${passed} passed`);
} finally {
  await cleanup();
}
