#!/usr/bin/env node
// Smoke for the autopilot per-candidate fill driver (10-autopilot-engine m2).
// DI-driven: mocks the multi-step machine (startMachine/getStatus) so no real
// browser/Playwright spins up. Verifies outcome classification, the never-submit
// guarantee, the in-flight guard, and start-error handling.

import assert from 'node:assert/strict';
import { driveOne, FILL_OUTCOME, _inFlightCountForTesting } from '../src/career/autopilot/fillDriver.mjs';

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

const cand = { id: 'aaaaaaaaaaaa', url: 'https://job-boards.greenhouse.io/acme/jobs/1', company: 'Acme', role: 'SWE' };
const noSleep = () => Promise.resolve();

// A mock machine that returns `running` for `runningPolls` polls, then settles
// to a terminal status with the given lastOutcome. Records every call so we can
// assert no submit-like method was ever invoked.
function mockMachine({ lastOutcome = 'completed', runningPolls = 1, pendingAtPoll = null, startError = null, escalationCode = null } = {}) {
  const calls = [];
  let poll = 0;
  return {
    calls,
    startMachine: async (body, deps) => {
      calls.push({ fn: 'startMachine', body, deps });
      if (startError) return startError;
      return { sessionId: body.jobId, started_at: 'now' };
    },
    getStatus: async (jobId) => {
      calls.push({ fn: 'getStatus', jobId });
      poll += 1;
      if (pendingAtPoll && poll >= pendingAtPoll) {
        return { machine: { state: 'running', pending: { stepIdx: 0 } } };
      }
      if (poll <= runningPolls) {
        return { machine: { state: 'running', pending: null } };
      }
      return { machine: { state: 'done', lastOutcome, escalationReason: escalationCode ? { code: escalationCode } : null } };
    },
  };
}

function depsOf(m, extra = {}) {
  return { startMachine: m.startMachine, getStatus: m.getStatus, sleep: noSleep, pollMs: 0, maxPolls: 10, ...extra };
}

// ── outcome classification ────────────────────────────────────────────────

await test('1. COMPLETED → parked', async () => {
  const m = mockMachine({ lastOutcome: 'completed' });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.PARKED);
  assert.equal(r.jobId, cand.id);
});

await test('2. PAUSED → needs_review', async () => {
  const m = mockMachine({ lastOutcome: 'paused' });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.NEEDS_REVIEW);
});

await test('3. ESCALATED (other code) → needs_human + escalationCode', async () => {
  const m = mockMachine({ lastOutcome: 'escalated', escalationCode: 'submit_failed' });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.NEEDS_HUMAN);
  assert.equal(r.escalationCode, 'submit_failed');
});

await test('3b. ESCALATED + ready_for_submit → PARKED (the success path!)', async () => {
  // The IRON-RULE never-auto-submit handoff: form filled, human clicks Submit.
  const m = mockMachine({ lastOutcome: 'escalated', escalationCode: 'ready_for_submit' });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.PARKED);
  assert.equal(r.escalationCode, 'ready_for_submit');
});

await test('3c. ESCALATED + user_cancel → failed', async () => {
  const m = mockMachine({ lastOutcome: 'escalated', escalationCode: 'user_cancel' });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.FAILED);
});

await test('4. ERROR → failed', async () => {
  const m = mockMachine({ lastOutcome: 'error' });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.FAILED);
});

await test('5. pending mid-run → needs_review (waiting on a human)', async () => {
  const m = mockMachine({ pendingAtPoll: 1, runningPolls: 99 });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.NEEDS_REVIEW);
});

await test('6. never settles → timeout', async () => {
  const m = mockMachine({ runningPolls: 999 });
  const r = await driveOne(cand, depsOf(m, { maxPolls: 30 }));
  assert.equal(r.outcome, FILL_OUTCOME.TIMEOUT);
});

await test('6b. session never lands (getStatus 404 forever) → failed, not timeout', async () => {
  // No machine key ever returned — driver bails to FAILED after the missing-
  // machine budget instead of spinning the full poll budget.
  const calls = { n: 0 };
  const deps = {
    startMachine: async (body) => ({ sessionId: body.jobId }),
    getStatus: async () => { calls.n += 1; return { status: 404, error: 'no session' }; },
    sleep: noSleep, pollMs: 0, maxPolls: 80,
  };
  const r = await driveOne(cand, deps);
  assert.equal(r.outcome, FILL_OUTCOME.FAILED);
  assert.ok(calls.n < 80, `bailed early (polled ${calls.n}, not 80)`);
});

// ── start-error handling ────────────────────────────────────────────────

await test('7. start 409 → busy', async () => {
  const m = mockMachine({ startError: { status: 409, error: 'machine already running' } });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.BUSY);
});

await test('8. start other error → failed', async () => {
  const m = mockMachine({ startError: { status: 500, error: 'boom' } });
  const r = await driveOne(cand, depsOf(m));
  assert.equal(r.outcome, FILL_OUTCOME.FAILED);
});

await test('9. startMachine throws → failed (never throws out)', async () => {
  const r = await driveOne(cand, {
    startMachine: async () => { throw new Error('disk gone'); },
    getStatus: async () => ({}),
    sleep: noSleep,
  });
  assert.equal(r.outcome, FILL_OUTCOME.FAILED);
});

await test('10. missing jobId → failed', async () => {
  const r = await driveOne({ url: 'x' }, depsOf(mockMachine()));
  assert.equal(r.outcome, FILL_OUTCOME.FAILED);
});

// ── never-submit guarantee ────────────────────────────────────────────────

await test('11. driver NEVER invokes a submit-like machine method', async () => {
  const m = mockMachine({ lastOutcome: 'completed' });
  await driveOne(cand, depsOf(m));
  const fns = new Set(m.calls.map((c) => c.fn));
  // The only machine surface the driver touches is startMachine + getStatus.
  // There is no submit/approve path — the human submits from Review.
  assert.deepEqual([...fns].sort(), ['getStatus', 'startMachine']);
  assert.ok(![...fns].some((f) => /submit|approve|click/i.test(f)));
});

await test('12. autoApproveWhenSafe:true is passed (only safe fields auto-fill)', async () => {
  const m = mockMachine({ lastOutcome: 'completed' });
  await driveOne(cand, depsOf(m));
  const start = m.calls.find((c) => c.fn === 'startMachine');
  assert.equal(start.body.autoApproveWhenSafe, true);
  assert.equal(start.body.jobId, cand.id);
  assert.equal(start.body.jobUrl, cand.url);
});

// ── in-flight guard ────────────────────────────────────────────────────────

await test('13. concurrent driveOne for same job → second is busy', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const m = {
    startMachine: async (body) => { await gate; return { sessionId: body.jobId }; },
    getStatus: async () => ({ machine: { state: 'done', lastOutcome: 'completed' } }),
  };
  const deps = { startMachine: m.startMachine, getStatus: m.getStatus, sleep: noSleep, pollMs: 0, maxPolls: 3 };
  const first = driveOne(cand, deps); // enters, awaits gate inside startMachine
  await new Promise((res) => setTimeout(res, 10));
  const second = await driveOne(cand, deps); // same jobId still in-flight
  assert.equal(second.outcome, FILL_OUTCOME.BUSY);
  release();
  const firstResult = await first;
  assert.equal(firstResult.outcome, FILL_OUTCOME.PARKED);
  assert.equal(_inFlightCountForTesting(), 0); // cleaned up
});

console.log(`\n${passed} passed`);
