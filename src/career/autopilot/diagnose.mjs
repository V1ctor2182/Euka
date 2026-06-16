// diagnose.mjs — Autopilot self-fix engine, stage ②③ (DIAGNOSE + ROUTE).
//
// See META/.../AUTOPILOT-DESIGN.md §9. Pure, no I/O, no LLM, no browser — it
// takes a finished/partial apply session (+ optional submit outcome + optional
// semantic-review flags) and returns a structured run-report:
//
//   { autonomy:{required,correct,rate}, gaps:[…], byLane:{…}, submit:{…} }
//
// "How it knows there's a problem" (§9, 3 detectors):
//   1. DOM read-back   → field.verify_status (mechanical: filled==intended?)
//   2. LLM draft review → opts.semanticFlags  (semantic: intended==correct?)
//   3. submit vision    → opts.submitOutcome  (did submit land?)
// Detector 2's flags are passed IN — read-back is BLIND to "confidently wrong"
// (G1: filled "No" == intended "No" → verify_status='verified', yet wrong).
//
// Each gap is routed to a fixer lane: 'data' (YAML/rule) | 'code' (AI fix
// agent) | 'human' (irreducible: file upload / CAPTCHA / the Submit click).

import { aggregateFields } from '../apply/triage.mjs';

/** Root-cause classes — the diagnosis output, not the raw symptom. */
export const ROOT_CAUSE = Object.freeze({
  PERCEPTION_GAP: 'perception_gap',         // field on page, snapshot never saw it (not_seen)
  LOGIC_BUG: 'logic_bug',                   // filled what it intended, but the value is wrong
  KNOWLEDGE_GAP: 'knowledge_gap',           // no value/answer available for it
  CLASSIFICATION_GAP: 'classification_gap', // wrong/absent class on a real input
  FILL_MECHANICS: 'fill_mechanics',         // value didn't land / fill threw (mismatch, fill_error)
  CAPABILITY_GAP: 'capability_gap',         // couldn't read it back (unverifiable) — control unsupported
  DETECTION_GAP: 'detection_gap',           // submit clicked, success/errors not detected
  HUMAN_STEP: 'human_step',                 // file upload / CAPTCHA / submit — irreducible
});

/** Fixer lanes. */
export const LANE = Object.freeze({ DATA: 'data', CODE: 'code', HUMAN: 'human' });

/** root cause → lane. */
const LANE_OF = Object.freeze({
  [ROOT_CAUSE.PERCEPTION_GAP]: LANE.CODE,
  [ROOT_CAUSE.LOGIC_BUG]: LANE.CODE,
  [ROOT_CAUSE.KNOWLEDGE_GAP]: LANE.DATA,
  [ROOT_CAUSE.CLASSIFICATION_GAP]: LANE.DATA,
  [ROOT_CAUSE.FILL_MECHANICS]: LANE.CODE,
  [ROOT_CAUSE.CAPABILITY_GAP]: LANE.CODE,
  [ROOT_CAUSE.DETECTION_GAP]: LANE.CODE,
  [ROOT_CAUSE.HUMAN_STEP]: LANE.HUMAN,
});

/** Classes that are intrinsically a human step regardless of verify_status. */
const HUMAN_CLASSES = new Set(['file', 'manual']);
/** verify_status values that mean "the operator handles it directly". */
const HUMAN_STATUSES = new Set(['manual', 'skipped_by_user']);

/**
 * Diagnose one aggregated field → a gap, or null if it's fine / not yet
 * attempted. `sem` is the optional semantic-review verdict for this field
 * ({ wrong:true, kind:'logic'|'knowledge', reason }) from detector #2.
 */
export function diagnoseField(f, sem) {
  if (!f) return null;
  const base = { refId: f.refId, label: f.label, stepIdx: f.stepIdx, class: f.class };

  // Detector #2 (semantic) — overrides a mechanically-"verified" field. This
  // is the ONLY way "confidently wrong" (G1) is caught; read-back can't.
  if (sem && sem.wrong) {
    const rc = sem.kind === 'knowledge' ? ROOT_CAUSE.KNOWLEDGE_GAP : ROOT_CAUSE.LOGIC_BUG;
    return { ...base, symptom: 'value_semantically_wrong', root_cause: rc, lane: LANE_OF[rc], detail: sem.reason || null };
  }

  // Irreducible human steps first — file/CAPTCHA can't be auto-filled.
  if (HUMAN_CLASSES.has(f.class) || HUMAN_STATUSES.has(f.verify_status)) {
    return { ...base, symptom: 'human_step', root_cause: ROOT_CAUSE.HUMAN_STEP, lane: LANE.HUMAN, detail: f.verify_detail || null };
  }

  const vs = f.verify_status;
  if (vs === 'verified') return null;            // detector #1 says fine, detector #2 didn't flag → ok
  if (vs == null) return null;                   // not attempted yet — not a gap

  if (vs === 'not_seen') {
    return { ...base, symptom: 'not_seen', root_cause: ROOT_CAUSE.PERCEPTION_GAP, lane: LANE.CODE, detail: f.verify_detail || null };
  }
  if (vs === 'mismatch' || vs === 'fill_error') {
    return { ...base, symptom: vs, root_cause: ROOT_CAUSE.FILL_MECHANICS, lane: LANE.CODE, detail: f.verify_detail || null };
  }
  if (vs === 'unverifiable') {
    return { ...base, symptom: 'unverifiable', root_cause: ROOT_CAUSE.CAPABILITY_GAP, lane: LANE.CODE, detail: f.verify_detail || null };
  }
  // Real input that never got a confident class.
  if (f.class === 'unknown') {
    return { ...base, symptom: 'unclassified', root_cause: ROOT_CAUSE.CLASSIFICATION_GAP, lane: LANE.DATA, detail: null };
  }
  return null;
}

/**
 * Diagnose a whole run.
 * @param {object} session — ApplySession (per_step_draft) shape
 * @param {{ submitOutcome?: string|null, semanticFlags?: Array<{refId:string, wrong:boolean, kind?:string, reason?:string}> }} [opts]
 * @returns {{ autonomy:{required:number,correct:number,rate:number|null}, gaps:Array, byLane:{data:number,code:number,human:number}, submit:{outcome:string|null, gap:object|null} }}
 */
export function diagnoseRun(session, opts = {}) {
  const fields = aggregateFields(session);
  const semByRef = new Map((opts.semanticFlags || []).map((s) => [s.refId, s]));

  const gaps = [];
  let required = 0;
  let correct = 0;

  for (const f of fields) {
    const sem = semByRef.get(f.refId);
    if (f.required) {
      required++;
      // "correct" = mechanically verified AND not semantically flagged wrong.
      if (f.verify_status === 'verified' && !(sem && sem.wrong)) correct++;
    }
    const gap = diagnoseField(f, sem);
    if (gap) gaps.push(gap);
  }

  const byLane = { data: 0, code: 0, human: 0 };
  for (const g of gaps) byLane[g.lane] = (byLane[g.lane] || 0) + 1;

  // Submit detector (#3). Anything other than a confirmed submit is a gap.
  const submitOutcome = opts.submitOutcome ?? null;
  let submitGap = null;
  if (submitOutcome != null && submitOutcome !== 'submitted' && submitOutcome !== 'confirmed') {
    // timeout / has_errors / next_step → the system couldn't confirm a send.
    const rc = submitOutcome === 'timeout' ? ROOT_CAUSE.DETECTION_GAP : ROOT_CAUSE.DETECTION_GAP;
    submitGap = { symptom: `submit_${submitOutcome}`, root_cause: rc, lane: LANE.CODE, detail: 'submit not confirmed' };
    byLane.code++;
  }

  const rate = required > 0 ? correct / required : null;
  return {
    autonomy: { required, correct, rate },
    gaps,
    byLane,
    submit: { outcome: submitOutcome, gap: submitGap },
  };
}

/** Human-readable one-line summary for logs / the harness. */
export function summarizeRun(report) {
  const a = report.autonomy;
  const pct = a.rate == null ? 'n/a' : `${Math.round(a.rate * 100)}%`;
  const lanes = report.byLane;
  const sub = report.submit.outcome == null ? 'not-attempted' : (report.submit.gap ? `FAILED(${report.submit.outcome})` : 'confirmed');
  return `autonomy ${pct} (${a.correct}/${a.required}) · gaps ${report.gaps.length} [data ${lanes.data} / code ${lanes.code} / human ${lanes.human}] · submit ${sub}`;
}
