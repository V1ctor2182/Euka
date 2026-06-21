#!/usr/bin/env node
// Smoke for the autopilot apply orchestrator (10-autopilot-engine m1).
// DI-driven: no real interval, no real server, no real I/O against
// data/career/. Verifies state persistence, daily-cap throttle, day rollover,
// and the 5 locked candidate-selection rules.

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import {
  readAutopilotState,
  writeAutopilotState,
  patchAutopilotState,
  withDailyReset,
  dayKey,
  DEFAULT_STATE,
} from '../src/career/autopilot/autopilotState.mjs';
import {
  selectCandidates,
  scoreOf,
  atsOf,
  tickOnce as _tick,
  AUTO_ATS,
} from '../src/career/autopilot/orchestrator.mjs';

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
  const tmp = path.join(os.tmpdir(), `autopilot-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.json`);
  try {
    await fn(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// Helper: build a job with a real ATS url + optional Stage score.
function job(id, { ats = 'greenhouse', score = null, url } = {}) {
  const urls = {
    greenhouse: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    ashby: `https://jobs.ashbyhq.com/acme/${id}`,
    lever: `https://jobs.lever.co/acme/${id}`,
    workday: `https://acme.wd1.myworkdayjobs.com/careers/job/${id}`,
    unknown: `https://acme.com/careers/${id}`,
  };
  const j = { id, url: url ?? urls[ats] ?? urls.unknown, company: 'Acme', role: 'SWE' };
  if (score != null) j.evaluation = { stage_a: { score } };
  return j;
}

// ── state I/O ─────────────────────────────────────────────────────────────

await test('state-1. missing file → defaults', async () => {
  await withTempFile(async (f) => {
    const s = await readAutopilotState(f);
    assert.deepEqual(s, DEFAULT_STATE);
    assert.equal(s.enabled, false);
    assert.equal(s.daily_cap, 5);
    assert.equal(s.score_threshold, 0);
  });
});

await test('state-2. write→read round-trip + clamps junk/out-of-range', async () => {
  await withTempFile(async (f) => {
    // daily_cap 10 within ceiling; score_threshold 7 > max(5) → clamped to 5;
    // daily_count -3 < 0 → floored to 0; unknown field dropped.
    await writeAutopilotState({ enabled: true, daily_cap: 10, score_threshold: 7, junk: 'x', daily_count: -3 }, f);
    const s = await readAutopilotState(f);
    assert.equal(s.enabled, true);
    assert.equal(s.daily_cap, 10);
    assert.equal(s.score_threshold, 5); // clamped to MAX_SCORE_THRESHOLD
    assert.equal(s.junk, undefined);
    assert.equal(s.daily_count, 0); // floored
  });
});

await test('state-2b. daily_cap clamped to hard ceiling; threshold floored', async () => {
  await withTempFile(async (f) => {
    await writeAutopilotState({ daily_cap: 100000, score_threshold: -4 }, f);
    const s = await readAutopilotState(f);
    assert.equal(s.daily_cap, 50); // HARD_DAILY_CAP
    assert.equal(s.score_threshold, 0); // floored to 0
  });
});

await test('state-3. corrupt JSON → defaults (never throws)', async () => {
  await withTempFile(async (f) => {
    await fs.writeFile(f, '{not json');
    const s = await readAutopilotState(f);
    assert.deepEqual(s, DEFAULT_STATE);
  });
});

await test('state-4. patch is read-modify-write, preserves other fields', async () => {
  await withTempFile(async (f) => {
    await writeAutopilotState({ enabled: true, daily_cap: 8, daily_count: 2 }, f);
    const s = await patchAutopilotState({ score_threshold: 4 }, f);
    assert.equal(s.score_threshold, 4);
    assert.equal(s.enabled, true); // preserved
    assert.equal(s.daily_cap, 8); // preserved
    assert.equal(s.daily_count, 2); // preserved
  });
});

await test('state-5. withDailyReset zeroes count on a new day', async () => {
  const yesterday = Date.now() - 24 * 60 * 60 * 1000;
  const s = { ...DEFAULT_STATE, daily_count: 4, daily_count_date: dayKey(yesterday) };
  const reset = withDailyReset(s, Date.now());
  assert.equal(reset.daily_count, 0);
  assert.equal(reset.daily_count_date, dayKey(Date.now()));
  // Same-day = unchanged (no reset).
  const sameDay = { ...DEFAULT_STATE, daily_count: 4, daily_count_date: dayKey(Date.now()) };
  assert.equal(withDailyReset(sameDay, Date.now()).daily_count, 4);
});

// ── pure helpers ────────────────────────────────────────────────────────

await test('helper-1. scoreOf prefers stage_b, falls back to stage_a, else 0', () => {
  assert.equal(scoreOf({ evaluation: { stage_a: { score: 3 }, stage_b: { score: 9 } } }), 9);
  assert.equal(scoreOf({ evaluation: { stage_a: { score: 3 } } }), 3);
  assert.equal(scoreOf({}), 0);
  assert.equal(scoreOf(null), 0);
});

await test('helper-2. atsOf detects the 3 solved ATSs + workday + null', () => {
  // ashby/lever require a >=8-hex path segment, so use realistic 12-hex ids.
  assert.equal(atsOf(job('aaaaaaaaaaaa', { ats: 'greenhouse' })), 'greenhouse');
  assert.equal(atsOf(job('bbbbbbbbbbbb', { ats: 'ashby' })), 'ashby');
  assert.equal(atsOf(job('cccccccccccc', { ats: 'lever' })), 'lever');
  assert.equal(atsOf(job('dddddddddddd', { ats: 'workday' })), 'workday');
  assert.equal(atsOf({ url: '' }), null);
  assert.equal(atsOf({ url: 'not a url' }), null);
});

// ── selectCandidates: the 5 locked rules ──────────────────────────────────

await test('select-1. rule 3: only greenhouse/ashby/lever (workday/unknown excluded)', () => {
  const jobs = [
    job('aaaaaaaaaaaa', { ats: 'greenhouse', score: 5 }),
    job('bbbbbbbbbbbb', { ats: 'workday', score: 9 }),
    job('cccccccccccc', { ats: 'unknown', score: 9 }),
    job('dddddddddddd', { ats: 'lever', score: 5 }),
  ];
  const picked = selectCandidates(jobs, { threshold: 0, limit: 10, appliedJobIds: new Set() });
  const ids = picked.map((p) => p.id);
  assert.deepEqual(ids.sort(), ['aaaaaaaaaaaa', 'dddddddddddd']);
  for (const p of picked) assert.ok(AUTO_ATS.includes(p.ats));
});

await test('select-2. rule 4: score >= threshold', () => {
  const jobs = [
    job('aaaaaaaaaaaa', { ats: 'greenhouse', score: 3 }),
    job('bbbbbbbbbbbb', { ats: 'greenhouse', score: 8 }),
    job('cccccccccccc', { ats: 'greenhouse' }), // unscored → 0
  ];
  const picked = selectCandidates(jobs, { threshold: 5, limit: 10, appliedJobIds: new Set() });
  assert.deepEqual(picked.map((p) => p.id), ['bbbbbbbbbbbb']);
});

await test('select-3. rule 5: skip already-applied jobIds', () => {
  const jobs = [
    job('aaaaaaaaaaaa', { ats: 'greenhouse', score: 5 }),
    job('bbbbbbbbbbbb', { ats: 'greenhouse', score: 5 }),
  ];
  const picked = selectCandidates(jobs, { threshold: 0, limit: 10, appliedJobIds: new Set(['aaaaaaaaaaaa']) });
  assert.deepEqual(picked.map((p) => p.id), ['bbbbbbbbbbbb']);
});

await test('select-4. sorted by score desc + top-N limit', () => {
  const jobs = [
    job('aaaaaaaaaaaa', { ats: 'greenhouse', score: 2 }),
    job('bbbbbbbbbbbb', { ats: 'greenhouse', score: 9 }),
    job('cccccccccccc', { ats: 'greenhouse', score: 5 }),
  ];
  const picked = selectCandidates(jobs, { threshold: 0, limit: 2, appliedJobIds: new Set() });
  assert.deepEqual(picked.map((p) => p.id), ['bbbbbbbbbbbb', 'cccccccccccc']);
});

await test('select-5. empty / malformed inputs → []', () => {
  assert.deepEqual(selectCandidates([], { threshold: 0, limit: 10, appliedJobIds: new Set() }), []);
  assert.deepEqual(selectCandidates(null, { threshold: 0, limit: 10 }), []);
  assert.deepEqual(selectCandidates([{ no: 'id' }, null], { threshold: 0, limit: 10, appliedJobIds: new Set() }), []);
  // limit 0 → []
  assert.deepEqual(selectCandidates([job('aaaaaaaaaaaa', { score: 5 })], { threshold: 0, limit: 0, appliedJobIds: new Set() }), []);
});

// ── tickOnce: lifecycle gating via DI ─────────────────────────────────────

function tickDeps(overrides = {}) {
  const filled = [];
  let state = { ...DEFAULT_STATE, enabled: true, daily_cap: 5, daily_count: 0, daily_count_date: dayKey() };
  const deps = {
    _readState: async () => ({ ...state }),
    _patchState: async (patch) => { state = { ...state, ...patch }; return state; },
    _readPipeline: async () => overrides.jobs ?? [],
    _readApplications: async () => overrides.apps ?? [],
    _isPipelineBusy: () => overrides.busy ?? false,
    _fill: async (cand) => { filled.push(cand); if (overrides.fillThrows) throw new Error('boom'); },
    _now: () => overrides.now ?? Date.now(),
  };
  return { deps, filled, getState: () => state };
}

// tickOnce takes a merged-deps object; build it the way startAutopilot would.
function mergedFrom(t) {
  // Re-map the _-prefixed DI keys to the internal dep names tickOnce expects.
  return {
    readState: t.deps._readState,
    patchState: t.deps._patchState,
    readPipeline: t.deps._readPipeline,
    readApplications: t.deps._readApplications,
    isPipelineBusy: t.deps._isPipelineBusy,
    fill: t.deps._fill,
    now: t.deps._now,
  };
}

await test('tick-1. disabled → no fill', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 })] });
  const merged = mergedFrom(t);
  merged.readState = async () => ({ ...DEFAULT_STATE, enabled: false });
  const r = await _tick(merged);
  assert.equal(r.reason, 'disabled');
  assert.equal(t.filled.length, 0);
});

await test('tick-2. daily cap reached → no fill', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 })] });
  const merged = mergedFrom(t);
  merged.readState = async () => ({ ...DEFAULT_STATE, enabled: true, daily_cap: 3, daily_count: 3, daily_count_date: dayKey() });
  const r = await _tick(merged);
  assert.equal(r.reason, 'daily-cap-reached');
  assert.equal(t.filled.length, 0);
});

await test('tick-3. pipeline busy → skip', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 })], busy: true });
  const r = await _tick(mergedFrom(t));
  assert.equal(r.reason, 'pipeline-busy');
  assert.equal(t.filled.length, 0);
});

await test('tick-4. applications-read fails → skip (never risks duplicate)', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 })] });
  const merged = mergedFrom(t);
  merged.readApplications = async () => { throw new Error('disk gone'); };
  const r = await _tick(merged);
  assert.equal(r.reason, 'applications-read-failed');
  assert.equal(t.filled.length, 0);
});

await test('tick-5. happy path fills picks + advances daily_count', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 }), job('bbbbbbbbbbbb', { score: 9 })] });
  const r = await _tick(mergedFrom(t));
  assert.equal(r.fired, true);
  assert.equal(r.processed, 2);
  assert.equal(t.filled.length, 2);
  assert.equal(t.filled[0].id, 'bbbbbbbbbbbb'); // highest score first
  assert.equal(t.getState().daily_count, 2);
  assert.ok(typeof t.getState().last_tick_at === 'string');
});

await test('tick-6. cap limits how many get filled per tick', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 }), job('bbbbbbbbbbbb', { score: 9 }), job('cccccccccccc', { score: 7 })] });
  const merged = mergedFrom(t);
  merged.readState = async () => ({ ...DEFAULT_STATE, enabled: true, daily_cap: 2, daily_count: 1, daily_count_date: dayKey() });
  const r = await _tick(merged);
  assert.equal(r.processed, 1); // remaining = cap(2) - count(1) = 1
  assert.equal(t.filled.length, 1);
  assert.equal(t.filled[0].id, 'bbbbbbbbbbbb');
});

await test('tick-7. fill throwing on one candidate does not abort the tick', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 })], fillThrows: true });
  const r = await _tick(mergedFrom(t));
  assert.equal(r.fired, true);
  assert.equal(r.processed, 0); // fill threw → not counted, but tick survived
});

await test('tick-8. no candidates → stamps last_tick_at, no fill', async () => {
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { ats: 'workday', score: 9 })] }); // workday excluded
  const r = await _tick(mergedFrom(t));
  assert.equal(r.reason, 'no-candidates');
  assert.equal(t.filled.length, 0);
  assert.ok(typeof t.getState().last_tick_at === 'string');
});

await test('tick-9. day rollover persists reset date + count on empty tick (H1)', async () => {
  const t = tickDeps({ jobs: [] }); // no jobs → no-candidates path
  const merged = mergedFrom(t);
  const yesterday = dayKey(Date.now() - 24 * 60 * 60 * 1000);
  merged.readState = async () => ({ ...DEFAULT_STATE, enabled: true, daily_cap: 5, daily_count: 4, daily_count_date: yesterday });
  const r = await _tick(merged);
  assert.equal(r.reason, 'no-candidates');
  // The empty tick must have persisted today's date with a zeroed count, so the
  // file no longer carries yesterday's 4.
  assert.equal(t.getState().daily_count, 0);
  assert.equal(t.getState().daily_count_date, dayKey());
});

await test('tick-10. single-flight guard: overlapping tick no-ops (C1/C2)', async () => {
  // A slow fill keeps the first tick in-flight while we fire a second tick.
  let release;
  const gate = new Promise((res) => { release = res; });
  const t = tickDeps({ jobs: [job('aaaaaaaaaaaa', { score: 5 })] });
  const merged = mergedFrom(t);
  merged.fill = async (cand) => { t.filled.push(cand); await gate; };
  const first = _tick(merged); // starts, awaits gate inside fill
  // Give the first tick a microtask to enter the critical section.
  await new Promise((res) => setTimeout(res, 10));
  const second = await _tick(merged); // should bail immediately
  assert.equal(second.reason, 'tick-in-progress');
  release();
  const firstResult = await first;
  assert.equal(firstResult.fired, true);
  assert.equal(t.filled.length, 1); // only the first tick filled
});

console.log(`\n${passed} passed`);
