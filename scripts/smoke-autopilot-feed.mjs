#!/usr/bin/env node
// Smoke for the autopilot activity feed + funnel aggregation (10-autopilot-engine m3).
// DI-driven for computeFunnel; real temp-file I/O for the append-only feed.

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import {
  appendEvent,
  readRecentFeed,
  compactFeed,
  computeFunnel,
} from '../src/career/autopilot/feed.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

async function withTempFile(fn) {
  const tmp = path.join(os.tmpdir(), `autopilot-feed-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.jsonl`);
  try {
    await fn(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// ── feed append / read ────────────────────────────────────────────────────

await test('feed-1. append then read newest-first + limit', async () => {
  await withTempFile(async (f) => {
    await appendEvent('parked', { jobId: 'a', company: 'A', at: 1000 }, f);
    await appendEvent('needs_review', { jobId: 'b', company: 'B', at: 2000 }, f);
    await appendEvent('failed', { jobId: 'c', company: 'C', at: 3000 }, f);
    const all = await readRecentFeed(50, f);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((e) => e.jobId), ['c', 'b', 'a']); // newest first
    assert.equal(all[0].type, 'failed');
    // limit
    const top2 = await readRecentFeed(2, f);
    assert.deepEqual(top2.map((e) => e.jobId), ['c', 'b']);
  });
});

await test('feed-2. ts derived from at when not provided; type recorded', async () => {
  await withTempFile(async (f) => {
    await appendEvent('parked', { jobId: 'a', at: 0 }, f);
    const [e] = await readRecentFeed(1, f);
    assert.equal(e.type, 'parked');
    assert.equal(typeof e.ts, 'string');
    assert.ok(e.ts.startsWith('1970-01-01')); // at=0 → epoch
    assert.equal(e.at, undefined); // `at` stripped, replaced by ts
  });
});

await test('feed-3. missing file → []', async () => {
  await withTempFile(async (f) => {
    await fs.unlink(f).catch(() => {});
    assert.deepEqual(await readRecentFeed(10, f), []);
  });
});

await test('feed-4. corrupt line skipped, valid tail preserved', async () => {
  await withTempFile(async (f) => {
    await fs.writeFile(f, '{bad json\n' + JSON.stringify({ ts: 't', type: 'parked', jobId: 'a' }) + '\n');
    const out = await readRecentFeed(10, f);
    assert.equal(out.length, 1);
    assert.equal(out[0].jobId, 'a');
  });
});

await test('feed-5. compact keeps newest cap', async () => {
  await withTempFile(async (f) => {
    for (let i = 0; i < 10; i++) await appendEvent('parked', { jobId: `j${i}`, at: i }, f);
    await compactFeed(f, 3);
    const out = await readRecentFeed(50, f);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((e) => e.jobId), ['j9', 'j8', 'j7']); // newest 3
  });
});

await test('feed-6. appendEvent never throws on a bad dir', async () => {
  // Path under a file (not a dir) — append should warn + swallow, not throw.
  await withTempFile(async (f) => {
    await fs.writeFile(f, 'x');
    const bad = path.join(f, 'nope.jsonl'); // f is a file, can't be a dir
    await appendEvent('parked', { jobId: 'a' }, bad); // must not throw
  });
});

// ── funnel ──────────────────────────────────────────────────────────────

const ghJob = (id, score) => ({
  id,
  url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  evaluation: score != null ? { stage_a: { score } } : undefined,
});

await test('funnel-1. counts candidates / filling / parked / submitted', async () => {
  const deps = {
    readState: async () => ({ score_threshold: 0, daily_cap: 5, daily_count: 0 }),
    readPipeline: async () => [ghJob('aaaaaaaaaaaa', 5), ghJob('bbbbbbbbbbbb', 9), ghJob('cccccccccccc', 3)],
    readApplications: async () => [
      { id: 'dddddddddddd-20260101', status: 'Applied' },
      { id: 'eeeeeeeeeeee-20260101', status: 'Interview' },
      { id: 'ffffffffffff-20260101', status: 'Rejected' }, // not "submitted" active
    ],
    readActiveSessions: async () => ['111111111111', '222222222222'],
    readSession: async (id) => (id === '111111111111' ? { status: 'active' } : { status: 'paused' }),
  };
  const f = await computeFunnel(deps);
  // 3 pipeline jobs, none applied/in-session → all 3 eligible candidates
  assert.equal(f.candidates, 3);
  assert.equal(f.filling, 1); // session 111 active
  assert.equal(f.parked, 1); // session 222 paused
  assert.equal(f.submitted, 2); // Applied + Interview (Rejected excluded)
});

await test('funnel-2. applied + in-session jobs are excluded from candidates', async () => {
  const deps = {
    readState: async () => ({ score_threshold: 0 }),
    readPipeline: async () => [ghJob('aaaaaaaaaaaa', 5), ghJob('bbbbbbbbbbbb', 9)],
    readApplications: async () => [{ id: 'aaaaaaaaaaaa-20260101', status: 'Applied' }],
    readActiveSessions: async () => ['bbbbbbbbbbbb'],
    readSession: async () => ({ status: 'active' }),
  };
  const f = await computeFunnel(deps);
  assert.equal(f.candidates, 0); // aaaa applied, bbbb in-session
  assert.equal(f.filling, 1);
});

await test('funnel-3. all reads degrade to 0, never throws', async () => {
  const deps = {
    readState: async () => { throw new Error('x'); },
    readPipeline: async () => { throw new Error('x'); },
    readApplications: async () => { throw new Error('x'); },
    readActiveSessions: async () => { throw new Error('x'); },
    readSession: async () => { throw new Error('x'); },
  };
  const f = await computeFunnel(deps);
  assert.deepEqual(f, { candidates: 0, filling: 0, parked: 0, submitted: 0 });
});

console.log(`\n${passed} passed`);
