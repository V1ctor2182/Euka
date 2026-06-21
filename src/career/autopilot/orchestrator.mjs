// Apply orchestrator — the missing piece that turns "autopilot" from a
// Claude-Code /loop into an app-native daemon. Mirrors finder/scheduler.mjs's
// master-tick structure: a single interval that, each tick, picks eligible
// candidates and (m2) drives them through the existing fill machine to the
// submit gate. m1 stops short of filling — selectCandidates() picks, the tick
// logs the picks. m2 wires fillDriver.driveOne into the tick.
//
// 10-autopilot-engine m1.
//
// LOCKED safety decisions (see ../../../META/.../10-autopilot-engine/spec.md):
//   1. NEVER auto-submit — fill machine parks at submit gate (m2).
//   2. Daily cap N (daily_cap) — tick stops once today's count hits it.
//   3. Only the 3 solved ATSs {greenhouse, ashby, lever} — login-wall skipped.
//   4. Candidate must have Stage score >= score_threshold.
//   5. Never re-apply — skip jobs already in the applications store.

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { detectAtsType } from '../finder/atsByUrl.mjs';
import { isPipelineBusy, PIPELINE_FILE } from '../finder/scanRunner.mjs';
import { readApplications } from '../applications/store.mjs';
import {
  readAutopilotState,
  patchAutopilotState,
  withDailyReset,
  dayKey,
} from './autopilotState.mjs';

const DEFAULT_TICK_MS = 60_000;

// The only ATSs the daemon auto-fills (no login wall, 100%-adapted). Workday/
// iCIMS etc. are detected but routed to the human lane (m2) instead.
export const AUTO_ATS = Object.freeze(['greenhouse', 'ashby', 'lever']);

// ── candidate selection (pure, DI-friendly) ──────────────────────────────

// Stage score for a job: prefer Stage B (Sonnet deep) over Stage A (Haiku
// quick); 0 when unevaluated — so a positive threshold naturally excludes
// not-yet-scored jobs. Matches the /pipeline endpoint's score-for-sort.
export function scoreOf(job) {
  const sb = job?.evaluation?.stage_b?.score;
  if (typeof sb === 'number' && Number.isFinite(sb)) return sb;
  const sa = job?.evaluation?.stage_a?.score;
  if (typeof sa === 'number' && Number.isFinite(sa)) return sa;
  return 0;
}

// ATS type for a job, from its apply URL. Bad/empty URL → null (excluded).
export function atsOf(job) {
  const url = job?.url;
  if (typeof url !== 'string' || !url) return null;
  try {
    return detectAtsType(url)?.type ?? null;
  } catch {
    // detectAtsType can throw on an unparseable URL — treat as unknown ATS.
    return null;
  }
}

// 12-hex jobId prefix of an application id (`<12hex>-<YYYYMMDD>`). Used to
// dedup against pipeline job ids. Returns null on non-match so a malformed app
// id can't pollute the applied-set with a full string that silently never
// dedupes (it could only ever weaken rule 5, never strengthen it).
export function jobIdOfApplication(appId) {
  if (typeof appId !== 'string') return null;
  const m = appId.match(/^([a-f0-9]{12})-\d{8}$/);
  return m ? m[1] : null;
}

// Build the Set of jobIds already in the applications store, for dedup (rule 5).
// Shared by the tick and the /status preview so they can't desync.
export function appliedJobIdSet(apps) {
  return new Set((Array.isArray(apps) ? apps : []).map((a) => jobIdOfApplication(a?.id)).filter(Boolean));
}

// Pick up to `limit` eligible candidates from the jobs array, applying the 5
// locked rules. `appliedJobIds` is a Set of jobIds already in the applications
// store. Sorted by Stage score desc (highest-value first). Pure — no I/O.
export function selectCandidates(jobs, { threshold, limit, appliedJobIds }) {
  if (!Array.isArray(jobs) || limit <= 0) return [];
  const applied = appliedJobIds instanceof Set ? appliedJobIds : new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job.id !== 'string') continue; // malformed row
    if (applied.has(job.id)) continue; // rule 5: never re-apply
    const ats = atsOf(job);
    if (!ats || !AUTO_ATS.includes(ats)) continue; // rule 3: solved ATSs only
    const score = scoreOf(job);
    if (score < threshold) continue; // rule 4: score gate
    out.push({ id: job.id, url: job.url, company: job.company, role: job.role, ats, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ── default deps (real I/O) ───────────────────────────────────────────────

export async function readPipelineJobs(file = PIPELINE_FILE) {
  if (!existsSync(file)) return [];
  try {
    const raw = await fs.readFile(file, 'utf-8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch (e) {
    console.warn(`[autopilot] pipeline read failed, treating as empty: ${e.message}`);
    return [];
  }
}

const DEFAULT_DEPS = {
  readState: readAutopilotState,
  patchState: patchAutopilotState,
  readPipeline: readPipelineJobs,
  readApplications,
  isPipelineBusy,
  // m1: no real fill. m2 injects fillDriver.driveOne here.
  fill: async (cand) => {
    console.log(`[autopilot] (m1 no-op) would fill ${cand.id} ${cand.company} — ${cand.role}`);
    return { outcome: 'skipped-m1' };
  },
  now: () => Date.now(),
};

function mergeDeps(opts) {
  return {
    readState: opts._readState ?? DEFAULT_DEPS.readState,
    patchState: opts._patchState ?? DEFAULT_DEPS.patchState,
    readPipeline: opts._readPipeline ?? DEFAULT_DEPS.readPipeline,
    readApplications: opts._readApplications ?? DEFAULT_DEPS.readApplications,
    isPipelineBusy: opts._isPipelineBusy ?? DEFAULT_DEPS.isPipelineBusy,
    fill: opts._fill ?? DEFAULT_DEPS.fill,
    now: opts._now ?? DEFAULT_DEPS.now,
  };
}

// ── the tick ──────────────────────────────────────────────────────────────

// Single-flight guard. The interval tick and the /enable "kick a tick now"
// path can otherwise overlap: both read daily_count from the same snapshot,
// both select the same candidates, both fill, both write count+processed — so
// the cap is exceeded ~2x and the same job is filled twice (violates rules 2 &
// 5). This boolean lets only one tick run at a time; an overlapping caller
// no-ops. Module-level (not per-deps) because there is one real daemon.
let _tickRunning = false;

// Helper to persist patches with a warning (not silent) on failure, so a
// persistently-failing write surfaces instead of last_tick_at freezing while
// the daemon looks alive.
async function persistPatch(deps, patch) {
  try {
    await deps.patchState(patch);
  } catch (e) {
    console.warn('[autopilot] patchState failed:', String(e?.message ?? e).slice(0, 200));
  }
}

// One orchestrator pass. NEVER throws — every fallible step is guarded so a
// bad tick can't crash the interval. Returns a result object for tests/manual
// triggers: { fired, reason?, picked? }.
export async function tickOnce(deps) {
  if (_tickRunning) return { fired: false, reason: 'tick-in-progress' };
  _tickRunning = true;
  try {
    return await runTick(deps);
  } finally {
    _tickRunning = false;
  }
}

async function runTick(deps) {
  let state;
  try {
    state = await deps.readState();
  } catch (e) {
    console.warn('[autopilot] readState failed, skipping tick:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'state-read-failed' };
  }

  const now = deps.now();
  state = withDailyReset(state, now);

  if (!state.enabled) return { fired: false, reason: 'disabled' };

  const remaining = state.daily_cap - state.daily_count;
  if (remaining <= 0) return { fired: false, reason: 'daily-cap-reached' };

  // Don't compete with a scan/enrich for the pipeline file. Re-evaluated next
  // tick (state is unchanged so the same picks resurface).
  if (deps.isPipelineBusy()) return { fired: false, reason: 'pipeline-busy' };

  let jobs;
  try {
    jobs = await deps.readPipeline();
  } catch (e) {
    console.warn('[autopilot] readPipeline failed, skipping tick:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'pipeline-read-failed' };
  }

  let appliedJobIds = new Set();
  try {
    const apps = await deps.readApplications();
    appliedJobIds = appliedJobIdSet(apps);
  } catch (e) {
    // Can't confirm what's already applied → DON'T fill (rule 5 safety: better
    // to skip a tick than risk a duplicate real application).
    console.warn('[autopilot] readApplications failed, skipping tick:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'applications-read-failed' };
  }

  const picked = selectCandidates(jobs, {
    threshold: state.score_threshold,
    limit: remaining,
    appliedJobIds,
  });

  // Persist the day-rollover reset on EVERY tick (not just productive ones):
  // state.daily_count/daily_count_date here are already post-withDailyReset, so
  // writing them keeps the file in sync across midnight even on empty ticks.
  // Otherwise an idle daemon would carry yesterday's count in the file until a
  // productive tick, and /status's remaining_today would drift.
  const today = dayKey(now);
  const nowIso = new Date(now).toISOString();

  // Always stamp last_tick_at so the UI shows the daemon is alive even on an
  // empty tick. daily_count only advances when fills actually happen.
  if (picked.length === 0) {
    await persistPatch(deps, { last_tick_at: nowIso, daily_count: state.daily_count, daily_count_date: today });
    return { fired: false, reason: 'no-candidates' };
  }

  // m1: pick + (no-op) fill. m2 replaces deps.fill with fillDriver.driveOne and
  // each fill writes an application row. NOTE for m2: the applied-set above is
  // read once per tick; the single-flight guard prevents overlapping ticks, but
  // m2 must ensure each fill's application row lands BEFORE the next tick reads
  // the store (read-your-writes), else a slow write could let the next tick
  // re-select the same job. (Not an issue in m1 — fill is a no-op.)
  let processed = 0;
  for (const cand of picked) {
    try {
      await deps.fill(cand);
      processed += 1;
    } catch (e) {
      // One bad candidate must not abort the tick (rule: NEVER throws on tick).
      console.warn(`[autopilot] fill failed for ${cand.id}:`, String(e?.message ?? e).slice(0, 200));
    }
  }

  await persistPatch(deps, {
    last_tick_at: nowIso,
    daily_count: state.daily_count + processed,
    daily_count_date: today,
  });

  return { fired: true, picked, processed };
}

// ── lifecycle (idempotent, unref'd interval) ──────────────────────────────

let _intervalHandle = null;
let _activeTick = null;

// Boots the daemon. Idempotent: a second call while active returns controls
// bound to the ORIGINAL deps (mirrors scheduler.startScheduler). To swap deps,
// stop() first. Returns { tick, stop }.
export function startAutopilot(opts = {}) {
  const tickMs = (() => {
    if (opts.tickMs == null) return DEFAULT_TICK_MS;
    if (typeof opts.tickMs !== 'number' || opts.tickMs <= 0) {
      console.warn(`[autopilot] invalid tickMs ${JSON.stringify(opts.tickMs)}, using ${DEFAULT_TICK_MS}ms`);
      return DEFAULT_TICK_MS;
    }
    return opts.tickMs;
  })();

  if (_intervalHandle) return { tick: _activeTick, stop: stopAutopilot };

  const deps = mergeDeps(opts);
  const tick = async () => tickOnce(deps);
  _activeTick = tick;

  _intervalHandle = setInterval(() => {
    tick().catch((e) => {
      console.warn('[autopilot] tick promise rejected:', String(e?.message ?? e).slice(0, 200));
    });
  }, tickMs);
  if (typeof _intervalHandle.unref === 'function') _intervalHandle.unref();

  return { tick, stop: stopAutopilot };
}

// Idempotent. Safe from SIGTERM whether or not started. Does NOT kill an
// in-flight fill — that drains naturally and parks at the submit gate.
export function stopAutopilot() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  _activeTick = null;
}

// Test helper: true if an interval is currently held.
export function _isAutopilotActiveForTesting() {
  return _intervalHandle !== null;
}
