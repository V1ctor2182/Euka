#!/usr/bin/env node
// Smoke for the Autopilot DIAGNOSE module (the self-fix engine's "knows there's
// a problem + finds the root cause" stage). Pure-Node, no I/O.
//
// Mirrors the real P0 run (Perpay/Greenhouse): G1 (confidently wrong), G2
// (education not_seen), G3 (submit timeout), plus the other taxonomy rows.

import assert from 'node:assert/strict';
import {
  diagnoseRun,
  diagnoseField,
  ROOT_CAUSE,
  LANE,
  summarizeRun,
} from '../src/career/autopilot/diagnose.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error('  ', e?.message ?? e);
    failed++;
  }
}

// Build a session in the per_step_draft shape aggregateFields expects.
function session(fields) {
  return { per_step_draft: { 0: { step_idx: 0, fields } } };
}
const F = (over) => ({ refId: 'e' + Math.random().toString(36).slice(2, 7), label: 'X', class: 'hard', required: true, ...over });

// ── Detector #1 (read-back) symptoms → root cause + lane ──────────────────

test('verified field → no gap', () => {
  const g = diagnoseField(F({ verify_status: 'verified' }));
  assert.equal(g, null);
});

test('not_seen → perception_gap → code (G2 education block)', () => {
  const g = diagnoseField(F({ verify_status: 'not_seen', label: 'End date year' }));
  assert.equal(g.root_cause, ROOT_CAUSE.PERCEPTION_GAP);
  assert.equal(g.lane, LANE.CODE);
});

test('mismatch / fill_error → fill_mechanics → code', () => {
  assert.equal(diagnoseField(F({ verify_status: 'mismatch' })).root_cause, ROOT_CAUSE.FILL_MECHANICS);
  assert.equal(diagnoseField(F({ verify_status: 'fill_error' })).lane, LANE.CODE);
});

test('unverifiable → capability_gap → code', () => {
  const g = diagnoseField(F({ verify_status: 'unverifiable' }));
  assert.equal(g.root_cause, ROOT_CAUSE.CAPABILITY_GAP);
});

test('file / manual class → human_step → human', () => {
  assert.equal(diagnoseField(F({ class: 'file', verify_status: null })).lane, LANE.HUMAN);
  assert.equal(diagnoseField(F({ class: 'manual', verify_status: 'manual' })).root_cause, ROOT_CAUSE.HUMAN_STEP);
});

test('unknown class (seen, not verified) → classification_gap → data', () => {
  const g = diagnoseField(F({ class: 'unknown', verify_status: 'mismatch' }));
  // mismatch takes precedence (it WAS attempted + failed mechanically)
  assert.equal(g.root_cause, ROOT_CAUSE.FILL_MECHANICS);
  const g2 = diagnoseField(F({ class: 'unknown', verify_status: 'someother' }));
  assert.equal(g2.root_cause, ROOT_CAUSE.CLASSIFICATION_GAP);
  assert.equal(g2.lane, LANE.DATA);
});

test('not-yet-attempted (verify_status null, fillable class) → no gap', () => {
  assert.equal(diagnoseField(F({ verify_status: null, class: 'hard' })), null);
});

// ── Detector #2 (semantic) — the G1 "confidently wrong" case ──────────────

test('G1: verified BUT semantically wrong → logic_bug → code', () => {
  // read-back says verified (filled "No" == intended "No"), but semantic
  // review flags it wrong → must surface as a logic_bug, not "fine".
  const f = F({ refId: 'spon', verify_status: 'verified', class: 'legal', label: 'now or future sponsorship?' });
  const sem = { refId: 'spon', wrong: true, kind: 'logic', reason: 'F-1 OPT → should be Yes' };
  const g = diagnoseField(f, sem);
  assert.equal(g.root_cause, ROOT_CAUSE.LOGIC_BUG);
  assert.equal(g.lane, LANE.CODE);
  assert.match(g.detail, /F-1 OPT/);
});

test('semantic flag kind=knowledge → knowledge_gap → data', () => {
  const g = diagnoseField(F({ verify_status: 'verified' }), { wrong: true, kind: 'knowledge', reason: 'no answer on file' });
  assert.equal(g.root_cause, ROOT_CAUSE.KNOWLEDGE_GAP);
  assert.equal(g.lane, LANE.DATA);
});

// ── Whole-run report (mirrors the Perpay run shape) ───────────────────────

test('diagnoseRun: autonomy rate + lane tally + submit gap', () => {
  const s = session([
    F({ refId: 'name', verify_status: 'verified', class: 'hard' }),
    F({ refId: 'email', verify_status: 'verified', class: 'hard' }),
    F({ refId: 'spon', verify_status: 'verified', class: 'legal' }), // G1, flagged below
    F({ refId: 'edu1', verify_status: 'not_seen', class: 'unknown' }), // G2
    F({ refId: 'edu2', verify_status: 'not_seen', class: 'unknown' }), // G2
    F({ refId: 'resume', class: 'file', verify_status: null }),        // human
  ]);
  const report = diagnoseRun(s, {
    submitOutcome: 'timeout', // G3
    semanticFlags: [{ refId: 'spon', wrong: true, kind: 'logic', reason: 'should be Yes' }],
  });
  // required=6; correct = name+email (spon flagged wrong, edu not_seen, resume not verified) = 2
  assert.equal(report.autonomy.required, 6);
  assert.equal(report.autonomy.correct, 2);
  assert.equal(Math.round(report.autonomy.rate * 100), 33);
  // gaps: spon(logic) + edu1 + edu2 (perception) + resume(human) = 4 field gaps
  assert.equal(report.gaps.length, 4);
  assert.equal(report.byLane.human, 1);                 // resume
  assert.equal(report.byLane.data, 0);
  // code: edu1 + edu2 (perception) + spon (logic) + submit timeout = 4
  assert.equal(report.byLane.code, 4);
  assert.ok(report.submit.gap, 'submit timeout is a gap');
  assert.equal(report.submit.gap.root_cause, ROOT_CAUSE.DETECTION_GAP);
});

test('summarizeRun: one-line summary', () => {
  const s = session([F({ verify_status: 'verified' }), F({ verify_status: 'not_seen', class: 'unknown' })]);
  const line = summarizeRun(diagnoseRun(s, { submitOutcome: null }));
  assert.match(line, /autonomy 50% \(1\/2\)/);
  assert.match(line, /submit not-attempted/);
});

test('empty / malformed session → safe zero report', () => {
  const r = diagnoseRun({}, {});
  assert.equal(r.autonomy.required, 0);
  assert.equal(r.autonomy.rate, null);
  assert.equal(r.gaps.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
