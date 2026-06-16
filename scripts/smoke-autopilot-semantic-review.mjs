#!/usr/bin/env node
// Smoke for Autopilot detector #2 (LLM semantic review). Deterministic — uses
// a mock client; no real LLM call. Tests the parser, the review→flags path,
// and that flags feed diagnoseRun into logic_bug / knowledge_gap.

import assert from 'node:assert/strict';
import { reviewFilledAnswers, parseFlags } from '../src/career/autopilot/semanticReview.mjs';
import { diagnoseRun, ROOT_CAUSE, LANE } from '../src/career/autopilot/diagnose.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.error('FAIL:', name); console.error('  ', e?.message ?? e); failed++; }
}

// ── parseFlags ────────────────────────────────────────────────────────────
await test('parseFlags: bare JSON array', () => {
  const f = parseFlags('[{"refId":"e1","wrong":true,"kind":"logic","reason":"x"}]', ['e1']);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'logic');
});
await test('parseFlags: tolerates ```json fences + prose', () => {
  const f = parseFlags('Here:\n```json\n[{"refId":"e2","wrong":true,"kind":"knowledge"}]\n```\n', ['e2']);
  assert.equal(f[0].refId, 'e2');
  assert.equal(f[0].kind, 'knowledge');
});
await test('parseFlags: drops unknown refIds + wrong!=true + bad json', () => {
  assert.equal(parseFlags('[{"refId":"ghost","wrong":true}]', ['e1']).length, 0);
  assert.equal(parseFlags('[{"refId":"e1","wrong":false}]', ['e1']).length, 0);
  assert.equal(parseFlags('not json', ['e1']).length, 0);
  assert.equal(parseFlags('[]', ['e1']).length, 0);
});
await test('parseFlags: defaults kind to logic when missing/odd', () => {
  assert.equal(parseFlags('[{"refId":"e1","wrong":true}]', ['e1'])[0].kind, 'logic');
});

// ── reviewFilledAnswers with a mock client ────────────────────────────────
const session = {
  per_step_draft: { 0: { step_idx: 0, fields: [
    { refId: 'spon', label: 'now or future sponsorship?', class: 'legal', suggested_value: 'No', required: true, verify_status: 'verified' },
    { refId: 'proj', label: 'personal project link', class: 'open', suggested_value: "I'd be happy to draft this later, but I…", required: true, verify_status: 'verified' },
    { refId: 'name', label: 'First Name', class: 'hard', suggested_value: 'Chenyang', required: true, verify_status: 'verified' },
    { refId: 'edu', label: 'End date year', class: 'unknown', suggested_value: null, required: true, verify_status: 'not_seen' },
  ] } },
};

function mockClient(replyText) {
  return { messages: { async create() { return { content: [{ type: 'text', text: replyText }] }; } } };
}

await test('reviewFilledAnswers: only reviews filled answer-bearing fields (skips not_seen/empty)', async () => {
  let seenPrompt = '';
  const client = { messages: { async create(p) { seenPrompt = p.messages[0].content; return { content: [{ type: 'text', text: '[]' }] }; } } };
  await reviewFilledAnswers(session, { client, profile: { name: 'Chenyang' } });
  assert.match(seenPrompt, /personal project/);   // open answer reviewed
  assert.ok(!/End date year/.test(seenPrompt));    // not_seen/empty NOT sent
});

await test('reviewFilledAnswers: flags the placeholder + the wrong sponsorship', async () => {
  const reply = '[{"refId":"spon","wrong":true,"kind":"logic","reason":"profile needs future sponsorship → should be Yes"},{"refId":"proj","wrong":true,"kind":"knowledge","reason":"placeholder non-answer"}]';
  const flags = await reviewFilledAnswers(session, { client: mockClient(reply), profile: {} });
  assert.equal(flags.length, 2);
  const byRef = Object.fromEntries(flags.map((f) => [f.refId, f]));
  assert.equal(byRef.spon.kind, 'logic');
  assert.equal(byRef.proj.kind, 'knowledge');
});

await test('flags feed diagnoseRun → logic_bug (code) + knowledge_gap (data)', async () => {
  const flags = await reviewFilledAnswers(session, {
    client: mockClient('[{"refId":"spon","wrong":true,"kind":"logic","reason":"should be Yes"},{"refId":"proj","wrong":true,"kind":"knowledge","reason":"placeholder"}]'),
    profile: {},
  });
  const report = diagnoseRun(session, { semanticFlags: flags });
  const byRef = Object.fromEntries(report.gaps.map((g) => [g.refId, g]));
  assert.equal(byRef.spon.root_cause, ROOT_CAUSE.LOGIC_BUG);
  assert.equal(byRef.spon.lane, LANE.CODE);
  assert.equal(byRef.proj.root_cause, ROOT_CAUSE.KNOWLEDGE_GAP);
  assert.equal(byRef.proj.lane, LANE.DATA);
});

await Promise.resolve();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
