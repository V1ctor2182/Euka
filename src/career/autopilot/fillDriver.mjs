// Per-candidate fill driver — the server-side engine that drives ONE candidate
// through the existing multi-step apply machine to the submit gate, then stops.
// This is what the orchestrator tick (orchestrator.mjs) calls per picked
// candidate in m2, replacing m1's no-op fill.
//
// 10-autopilot-engine m2.
//
// Safety posture (derived from the locked rules):
//   - autoApproveWhenSafe:true → the machine auto-fills only HIGH-confidence,
//     non-manual fields. Anything uncertain (low-confidence field, a new
//     question, CAPTCHA) makes the machine PAUSE/ESCALATE — the driver does
//     NOT force-approve it. Those route to the human Review queue (m2 of the
//     UI room). We never submit, and never push uncertain data into a form.
//   - NEVER calls submit. The machine parks at the submit gate (COMPLETED) and
//     the human clicks Submit in Review.

import {
  startMachine as _startMachine,
  getStatus as _getStatus,
  OUTCOME,
} from '../applier/multistep/endpoint.mjs';

// Outcomes the driver reports back to the orchestrator. Distinct from the
// machine's OUTCOME enum — these describe what the DAEMON should do next.
export const FILL_OUTCOME = Object.freeze({
  PARKED: 'parked', // filled to submit gate; awaiting human Submit in Review
  NEEDS_REVIEW: 'needs_review', // paused at an uncertain field / new question
  NEEDS_HUMAN: 'needs_human', // login wall / CAPTCHA / submit-loop escalation
  FAILED: 'failed', // machine errored
  TIMEOUT: 'timeout', // didn't settle within the poll budget
  BUSY: 'busy', // a machine was already running for this job
});

const DEFAULT_POLL_MS = 6_000;
const DEFAULT_MAX_POLLS = 80; // ~8 min at 6s — same budget as the old CLI driver
// The session file is written asynchronously after startMachine returns, so the
// first few getStatus polls can legitimately 404 / lack a machine. Tolerate a
// short run of those, then conclude the machine died before settling.
const MAX_MISSING_MACHINE_POLLS = 6;

// Escalation codes that mean "form is filled, parked at the submit gate — the
// human reviews and clicks Submit". This is the IRON-RULE never-auto-submit
// handoff (machine.mjs), i.e. the SUCCESS path — not a failure.
const READY_CODES = new Set(['ready_for_submit']);
// Escalation code for an operator-cancelled run.
const CANCEL_CODES = new Set(['user_cancel']);

// Module-level in-flight guard: never run two fills for the SAME jobId at once
// (the orchestrator awaits sequentially so cross-job concurrency is already 1,
// but this defends against a manual enqueue racing the tick).
const _inFlight = new Set();

function classifyTerminal(machine) {
  const code = machine?.escalationReason?.code ?? null;
  switch (machine?.lastOutcome) {
    case OUTCOME.COMPLETED:
      return FILL_OUTCOME.PARKED;
    case OUTCOME.PAUSED:
      return FILL_OUTCOME.NEEDS_REVIEW;
    case OUTCOME.ESCALATED:
      // ready_for_submit IS the happy path: filled to the gate, human submits.
      if (READY_CODES.has(code)) return FILL_OUTCOME.PARKED;
      if (CANCEL_CODES.has(code)) return FILL_OUTCOME.FAILED;
      // Any other escalation (submit_failed, wait_loop_stuck, hard_cap, …) means
      // the form was engaged but the flow needs a human to take over in-browser.
      return FILL_OUTCOME.NEEDS_HUMAN;
    case OUTCOME.ERROR:
    default:
      return FILL_OUTCOME.FAILED;
  }
}

// Drive one candidate to the submit gate. cand = { id, url, company, role, ats }.
// Returns { outcome, jobId, escalationCode?, error? }. Never throws.
export async function driveOne(cand, deps = {}) {
  const startMachine = deps.startMachine ?? _startMachine;
  const getStatus = deps.getStatus ?? _getStatus;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;

  const jobId = cand?.id;
  if (typeof jobId !== 'string' || !jobId) {
    return { outcome: FILL_OUTCOME.FAILED, jobId: null, error: 'missing jobId' };
  }
  if (_inFlight.has(jobId)) {
    return { outcome: FILL_OUTCOME.BUSY, jobId };
  }
  _inFlight.add(jobId);
  try {
    let started;
    try {
      started = await startMachine(
        { jobId, jobUrl: cand.url, autoApproveWhenSafe: true },
        { freshStart: true },
      );
    } catch (e) {
      return { outcome: FILL_OUTCOME.FAILED, jobId, error: String(e?.message ?? e).slice(0, 200) };
    }
    if (started?.error) {
      // 409 = a machine was already running for this job (a prior parked
      // session lingering) → treat as busy so the orchestrator skips it.
      const outcome = started.status === 409 ? FILL_OUTCOME.BUSY : FILL_OUTCOME.FAILED;
      return { outcome, jobId, error: started.error };
    }

    let missingMachine = 0;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      let st;
      try {
        st = await getStatus(jobId);
      } catch (e) {
        // A thrown read failure shouldn't abort the drive — count it toward the
        // missing-machine budget so a persistently broken read bails to FAILED
        // instead of spinning the full poll budget.
        console.warn(`[autopilot] driveOne getStatus threw (${jobId}):`, String(e?.message ?? e).slice(0, 200));
        if (++missingMachine >= MAX_MISSING_MACHINE_POLLS) return { outcome: FILL_OUTCOME.FAILED, jobId };
        continue;
      }
      const machine = st?.machine;
      // No machine yet: either the session file hasn't landed (startup window)
      // or getStatus returned an error object (404/500). Tolerate a short run,
      // then conclude the machine is dead rather than spinning to TIMEOUT.
      if (!machine) {
        if (++missingMachine >= MAX_MISSING_MACHINE_POLLS) return { outcome: FILL_OUTCOME.FAILED, jobId };
        continue;
      }
      missingMachine = 0;
      // The machine settles at state 'done' with lastOutcome set. A pending
      // approval also means it's waiting on a human (paused) — surface it as
      // needs_review even if state hasn't flipped to 'done' yet.
      if (machine.state === 'done') {
        return {
          outcome: classifyTerminal(machine),
          jobId,
          escalationCode: machine.escalationReason?.code ?? null,
        };
      }
      if (machine.pending) {
        return { outcome: FILL_OUTCOME.NEEDS_REVIEW, jobId, escalationCode: machine.escalationReason?.code ?? null };
      }
    }
    return { outcome: FILL_OUTCOME.TIMEOUT, jobId };
  } finally {
    _inFlight.delete(jobId);
  }
}

// Test helper.
export function _inFlightCountForTesting() {
  return _inFlight.size;
}
