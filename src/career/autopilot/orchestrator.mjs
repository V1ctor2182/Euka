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
import { readdir } from 'node:fs/promises';
import { detectAtsType } from '../finder/atsByUrl.mjs';
import { isPipelineBusy, PIPELINE_FILE } from '../finder/scanRunner.mjs';
import { readApplications } from '../applications/store.mjs';
import { APPLY_SESSIONS_DIR, JOB_ID_RE as SESSION_JOB_ID_RE } from '../applier/multistep/applySessionsStore.mjs';
import { driveOne, FILL_OUTCOME } from './fillDriver.mjs';
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

// jobIds that already have an apply-session on disk. A parked-for-review or
// in-flight candidate has a session but NO applications-store row yet, so
// without this the tick would re-fill it every 60s (the m1-review H3 gap).
export async function readActiveSessionJobIds(dir = APPLY_SESSIONS_DIR) {
  if (!existsSync(dir)) return [];
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .filter((id) => SESSION_JOB_ID_RE.test(id));
  } catch (e) {
    console.warn(`[autopilot] session-dir read failed, treating as empty: ${e.message}`);
    return [];
  }
}

// Escalation codes that mean "blocked by a login/CAPTCHA wall" — per the
// owner's locked decision these do NOT consume a daily slot (we never got to
// fill a real application). None of the 3 in-scope ATSs surface these today
// (Workday/iCIMS are excluded by rule 3), but this keeps the door open for when
// login-walled ATSs are added without re-counting.
const LOGIN_WALL_CODES = new Set(['login_wall', 'captcha', 'login_required']);

// Whether a driveOne result consumes a daily-cap slot. BUSY = no work happened.
// A NEEDS_HUMAN caused by a login wall is slot-free (locked decision); every
// other outcome engaged the ATS with a real fill attempt and counts.
function isCountedAttempt(outcome, escalationCode) {
  if (outcome === FILL_OUTCOME.BUSY) return false;
  if (outcome === FILL_OUTCOME.NEEDS_HUMAN && LOGIN_WALL_CODES.has(escalationCode)) return false;
  return true;
}

// In-memory cooldown of recently-attempted jobIds. A fill that FAILS before a
// session file is ever written (e.g. getPage throws) would otherwise be
// re-picked every tick and burn the whole daily cap on one broken job. This
// excludes any job attempted within COOLDOWN_MS regardless of outcome. In-memory
// is fine: a process restart re-attempting is acceptable (same posture as the
// scan scheduler's in-memory state).
const ATTEMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const _recentAttempts = new Map(); // jobId → epoch ms of last attempt

function recordAttempt(jobId, nowMs) {
  _recentAttempts.set(jobId, nowMs);
}
function inCooldown(jobId, nowMs) {
  const at = _recentAttempts.get(jobId);
  if (at == null) return false;
  if (nowMs - at >= ATTEMPT_COOLDOWN_MS) {
    _recentAttempts.delete(jobId); // expired — let it be retried
    return false;
  }
  return true;
}
// Test helper.
export function _resetRecentAttemptsForTesting() {
  _recentAttempts.clear();
}

const DEFAULT_DEPS = {
  readState: readAutopilotState,
  patchState: patchAutopilotState,
  readPipeline: readPipelineJobs,
  readApplications,
  readActiveSessions: readActiveSessionJobIds,
  isPipelineBusy,
  fill: (cand) => driveOne(cand),
  // Activity-feed sink. Default no-op so the orchestrator doesn't import feed.mjs
  // (which imports orchestrator helpers → would be a cycle). server.mjs wires the
  // real feed.appendEvent via opts._emit on startAutopilot + tickNow.
  emit: () => {},
  now: () => Date.now(),
};

function mergeDeps(opts) {
  return {
    readState: opts._readState ?? DEFAULT_DEPS.readState,
    patchState: opts._patchState ?? DEFAULT_DEPS.patchState,
    readPipeline: opts._readPipeline ?? DEFAULT_DEPS.readPipeline,
    readApplications: opts._readApplications ?? DEFAULT_DEPS.readApplications,
    readActiveSessions: opts._readActiveSessions ?? DEFAULT_DEPS.readActiveSessions,
    isPipelineBusy: opts._isPipelineBusy ?? DEFAULT_DEPS.isPipelineBusy,
    fill: opts._fill ?? DEFAULT_DEPS.fill,
    emit: opts._emit ?? DEFAULT_DEPS.emit,
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
  } catch (e) {
    // Belt-and-suspenders: runTick guards every fallible step, but an injected
    // dep (e.g. a throwing now()) could still throw. tickOnce must NEVER throw.
    console.warn('[autopilot] tick threw unexpectedly:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'tick-threw' };
  } finally {
    _tickRunning = false;
  }
}

// Run a single tick with REAL (merged-from-opts) deps. This is the entry point
// external callers (the /enable kick) should use — tickOnce expects ALREADY-
// merged deps (the interval binds them once), so calling tickOnce({}) would run
// against undefined deps. tickNow(opts) merges first. opts accepts the same
// _-prefixed DI keys as startAutopilot (e.g. _emit).
export async function tickNow(opts = {}) {
  return tickOnce(mergeDeps(opts));
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

  // Also exclude jobs that already have an apply-session: a parked-for-review or
  // in-flight candidate has a session but no applications-store row yet, so this
  // is what stops the tick re-filling it every 60s. Fail-closed for the same
  // reason as applications: if we can't list sessions, skip the tick.
  try {
    for (const id of await deps.readActiveSessions()) appliedJobIds.add(id);
  } catch (e) {
    console.warn('[autopilot] readActiveSessions failed, skipping tick:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'sessions-read-failed' };
  }

  // And exclude jobs attempted within the cooldown — covers failures that never
  // wrote a session file (so the two checks above wouldn't catch them).
  for (const id of jobs) {
    if (id?.id && inCooldown(id.id, now)) appliedJobIds.add(id.id);
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

  // Drive each picked candidate through the fill machine to the submit gate.
  // fillDriver.driveOne never throws and never submits; it returns an outcome
  // describing what the daemon should do next. Re-fill of a parked candidate is
  // prevented by the session-dedup above (driveOne's startMachine creates a
  // session, so next tick excludes it). Counting policy: login-wall NEEDS_HUMAN
  // doesn't consume a daily slot (owner's locked decision); see COUNTED_OUTCOMES.
  let processed = 0;
  const outcomes = [];
  for (const cand of picked) {
    let result;
    try {
      result = await deps.fill(cand);
    } catch (e) {
      // driveOne is contracted never to throw, but defend anyway (rule: NEVER
      // throws on tick). Treat an unexpected throw as a failed attempt.
      console.warn(`[autopilot] fill threw for ${cand.id}:`, String(e?.message ?? e).slice(0, 200));
      result = { outcome: FILL_OUTCOME.FAILED, jobId: cand.id };
    }
    const outcome = result?.outcome ?? FILL_OUTCOME.FAILED;
    const escalationCode = result?.escalationCode ?? null;
    outcomes.push({ id: cand.id, outcome, escalationCode });
    // Record every non-BUSY attempt in the cooldown so a session-less failure
    // can't be re-picked next tick. BUSY means another driver already owns it.
    if (outcome !== FILL_OUTCOME.BUSY) recordAttempt(cand.id, now);
    if (isCountedAttempt(outcome, escalationCode)) processed += 1;
    // Emit one activity-feed event per candidate (fire-and-forget; the sink is
    // contracted never to throw, but guard anyway — feed must not break a tick).
    try {
      await deps.emit({ type: outcome, jobId: cand.id, company: cand.company, role: cand.role, ats: cand.ats, escalationCode, at: now });
    } catch (e) {
      console.warn('[autopilot] emit failed:', String(e?.message ?? e).slice(0, 200));
    }
  }

  await persistPatch(deps, {
    last_tick_at: nowIso,
    daily_count: state.daily_count + processed,
    daily_count_date: today,
  });

  return { fired: true, picked, processed, outcomes };
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
