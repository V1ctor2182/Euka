#!/usr/bin/env node
// Autopilot harness — run the DIAGNOSE engine against a REAL apply session and
// print the run-report scorecard. This is M1 of AUTOPILOT-DESIGN.md: turn
// "run a P0 by hand" into "read the number + the routed gap list."
//
// Usage:
//   node scripts/autopilot.mjs              # list available sessions
//   node scripts/autopilot.mjs <jobId>      # diagnose one session
//   node scripts/autopilot.mjs --json <jobId>   # machine-readable report
//
// Read-only. Does not drive the browser or fix anything yet — it's the
// scorecard the rest of the loop (LLM review, fix agent) plugs into.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APPLY_SESSIONS_DIR } from '../src/career/applier/multistep/applySessionsStore.mjs';
import { diagnoseRun, summarizeRun, LANE } from '../src/career/autopilot/diagnose.mjs';
import { reviewFilledAnswers } from '../src/career/autopilot/semanticReview.mjs';

const JOB_RE = /^[a-f0-9]{12}$/;

function listSessions() {
  if (!existsSync(APPLY_SESSIONS_DIR)) return [];
  return readdirSync(APPLY_SESSIONS_DIR)
    .filter((f) => f.endsWith('.json') && JOB_RE.test(f.replace(/\.json$/, '')))
    .map((f) => f.replace(/\.json$/, ''));
}

// Read the session straight off disk (the harness is read-only + defensive;
// diagnose tolerates partial shapes, so we skip strict schema parsing).
function loadSession(jobId) {
  const file = path.join(APPLY_SESSIONS_DIR, `${jobId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

// The last submit attempt's outcome → detector #3 input.
function submitOutcomeOf(session) {
  const last = (session.submit_attempts || []).slice(-1)[0];
  return last?.outcome ?? null;
}

const LANE_HINT = {
  [LANE.DATA]: 'flywheel: write a YAML/rule (light approve)',
  [LANE.CODE]: 'AI fix agent: claude -p drafts code + test',
  [LANE.HUMAN]: 'irreducible: you do it (file upload / CAPTCHA / submit)',
};

function bar(rate) {
  if (rate == null) return '—';
  const n = Math.round(rate * 20);
  return `[${'█'.repeat(n)}${'░'.repeat(20 - n)}] ${Math.round(rate * 100)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const withReview = args.includes('--review'); // detector #2 (real claude -p call)
  const jobId = args.find((a) => JOB_RE.test(a));

  if (!jobId) {
    const sessions = listSessions();
    console.log('Apply sessions:');
    if (!sessions.length) {
      console.log('  (none — run an apply first)');
    } else {
      for (const id of sessions) {
        const s = loadSession(id);
        const r = diagnoseRun(s, { submitOutcome: submitOutcomeOf(s) });
        console.log(`  ${id}  ${s.site_adapter || '?'}  ${summarizeRun(r)}`);
      }
    }
    console.log('\n→ node scripts/autopilot.mjs <jobId>   for the full report');
    return;
  }

  const session = loadSession(jobId);
  if (!session) {
    console.error(`No session ${jobId} in ${APPLY_SESSIONS_DIR}`);
    process.exit(1);
  }
  // Detector #2 (semantic) — opt-in, makes a real claude -p call. Without it
  // the report uses DOM read-back + submit only (mechanical detectors).
  let semanticFlags = [];
  if (withReview) {
    try {
      semanticFlags = await reviewFilledAnswers(session);
    } catch (e) {
      console.error(`(semantic review skipped: ${e?.message ?? e})`);
    }
  }
  const report = diagnoseRun(session, { submitOutcome: submitOutcomeOf(session), semanticFlags });

  if (asJson) {
    console.log(JSON.stringify({ jobId, site: session.site_adapter, ...report }, null, 2));
    return;
  }

  // ── human-readable scorecard ──────────────────────────────────────────
  console.log(`\n  Autopilot run-report — ${jobId}`);
  console.log(`  ATS: ${session.site_adapter || '?'}   ·   ${session.job_url || ''}`);
  console.log(`  ${'─'.repeat(64)}`);
  console.log(`  Autonomy  ${bar(report.autonomy.rate)}   (${report.autonomy.correct}/${report.autonomy.required} required fields auto-correct)`);
  const sub = report.submit.outcome == null ? 'not attempted' : (report.submit.gap ? `FAILED — ${report.submit.outcome}` : 'confirmed ✅');
  console.log(`  Submit    ${sub}`);
  console.log(`  Gaps      ${report.gaps.length + (report.submit.gap ? 1 : 0)}  →  data ${report.byLane.data} · code ${report.byLane.code} · human ${report.byLane.human}`);
  console.log(`  ${'─'.repeat(64)}`);

  const lanes = [LANE.CODE, LANE.DATA, LANE.HUMAN];
  for (const lane of lanes) {
    const inLane = report.gaps.filter((g) => g.lane === lane);
    const submitInLane = report.submit.gap && report.submit.gap.lane === lane ? [report.submit.gap] : [];
    const all = [...inLane, ...submitInLane];
    if (!all.length) continue;
    console.log(`\n  ${lane.toUpperCase()}  — ${LANE_HINT[lane]}`);
    for (const g of all) {
      const where = g.label ? `${g.label}` : (g.symptom || 'submit');
      console.log(`    • ${g.root_cause.padEnd(20)} ${where}${g.detail ? `  — ${g.detail}` : ''}`);
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
