// semanticReview.mjs — Autopilot detector #2 (the semantic channel).
//
// DOM read-back (detector #1) only proves "filled == intended". It is BLIND to
// "confidently wrong" — G1: filled "No" == intended "No" → verify_status
// 'verified', yet the answer was wrong. This module is the missing check: it
// reads {applicant profile + the filled answers} through the LLM and flags
// answers that are factually wrong, inconsistent, or placeholder non-answers.
//
// Output feeds diagnoseRun(session, { semanticFlags }) → logic_bug / knowledge_gap.
// Runs on the local `claude -p` backend (getClient) — no API key needed.

import { getClient } from '../lib/anthropicClient.mjs';
import { aggregateFields } from '../apply/triage.mjs';
import { loadIdentity } from '../applier/classifier/identityLookup.mjs';
import { loadLegal } from '../applier/classifier/legalLookup.mjs';

/** Field classes whose VALUES carry a semantic answer worth reviewing. */
const ANSWER_CLASSES = new Set(['hard', 'legal', 'open']);

/** Compact applicant profile for the review prompt (identity + work auth). */
async function loadProfileSummary() {
  const [id, legal] = await Promise.all([
    loadIdentity().catch(() => ({})),
    loadLegal().catch(() => ({})),
  ]);
  return {
    name: id?.name ?? null,
    email: id?.email ?? null,
    location: id?.location ?? null,
    education: id?.education ?? null,
    work_authorization: legal?.work_authorization ?? null,
    eeo: legal?.eeo ?? null,
  };
}

function buildPrompt(profile, answers) {
  return [
    'You are auditing a job application that was AUTO-FILLED for this applicant.',
    'Your job: catch answers that are WRONG, inconsistent with the profile, or',
    'placeholder/incomplete non-answers — the kind a careless auto-filler produces.',
    '',
    'APPLICANT PROFILE (ground truth):',
    JSON.stringify(profile, null, 2),
    '',
    'FILLED ANSWERS to audit:',
    JSON.stringify(answers, null, 2),
    '',
    'For EACH problematic answer return an object:',
    '  { "refId": <id>, "wrong": true, "kind": "logic"|"knowledge", "reason": <short> }',
    '  - "logic": factually inconsistent with the profile (e.g. work-auth answer',
    '    contradicts the profile; wrong name/location).',
    '  - "knowledge": a placeholder / "I\'ll draft this later" / empty / generic',
    '    non-answer, or an open question needing info the profile lacks.',
    'Answers that are fine: OMIT them. If ALL are fine, return [].',
    '',
    'Return ONLY a JSON array, nothing else.',
  ].join('\n');
}

/** Extract a JSON array from the model text (tolerates ```json fences / prose). */
export function parseFlags(text, validRefIds) {
  if (typeof text !== 'string') return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const valid = validRefIds ? new Set(validRefIds) : null;
  return arr
    .filter((o) => o && typeof o.refId === 'string' && o.wrong === true)
    .filter((o) => !valid || valid.has(o.refId))
    .map((o) => ({
      refId: o.refId,
      wrong: true,
      kind: o.kind === 'knowledge' ? 'knowledge' : 'logic',
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : null,
    }));
}

/**
 * Review a session's filled answers → semanticFlags for diagnoseRun.
 * @param {object} session — ApplySession shape
 * @param {{ client?: object, profile?: object }} [opts]
 * @returns {Promise<Array<{refId,wrong,kind,reason}>>}
 */
export async function reviewFilledAnswers(session, opts = {}) {
  const fields = aggregateFields(session);
  const answers = fields
    .filter((f) => f.suggested_value && ANSWER_CLASSES.has(f.class))
    .map((f) => ({ refId: f.refId, question: f.label, answer: String(f.suggested_value).slice(0, 1500) }));
  if (!answers.length) return [];

  const profile = opts.profile || (await loadProfileSummary());
  const client = opts.client || getClient();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPrompt(profile, answers) }],
  });
  const text = res?.content?.map((b) => (b?.type === 'text' ? b.text : '')).join('') ?? '';
  return parseFlags(text, answers.map((a) => a.refId));
}
