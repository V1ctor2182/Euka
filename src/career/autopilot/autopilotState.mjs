// Autopilot engine state — persists the daemon's on/off + daily throttle so
// the apply orchestrator (orchestrator.mjs) survives server restarts.
//
// 10-autopilot-engine m1. Mirrors finder/cadenceState.mjs's I/O conventions
// (atomic-rename write, never-throw read) so the two daemons read/write state
// the same way.
//
// State shape (data/career/autopilot-state.json):
//   {
//     enabled:          boolean   // is the daemon allowed to fill?
//     last_tick_at:     string|null  // ISO of the last orchestrator tick
//     daily_count:      number    // candidates processed today
//     daily_count_date: string|null  // YYYY-MM-DD the count belongs to
//     daily_cap:        number    // max candidates/day (locked decision #2)
//     score_threshold:  number    // min Stage score to auto-apply (decision #4)
//   }

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const AUTOPILOT_STATE_FILE = path.join(CAREER_DIR, 'autopilot-state.json');

// Hard safety ceiling on the daily cap. coerce() clamps to this regardless of
// write path (config endpoint, hand-edited file, future callers) so rule 2
// (daily throttle) can never be defeated by a bad write. The config endpoint
// also validates, but the floor/ceiling here is the last line of defense.
export const HARD_DAILY_CAP = 50;
// Stage scores are scaled 1–5 (see evaluator/stageAPrompt.clampScore). A
// threshold of 0 means "don't gate on score"; >5 would exclude everything.
export const MAX_SCORE_THRESHOLD = 5;

// Conservative defaults: OFF, cap 5/day, threshold 0. threshold=0 means "don't
// gate on score yet" — most jobs aren't Stage-scored, so a high threshold would
// auto-apply to nothing. Owner raises it in Profile once scoring is widespread.
export const DEFAULT_STATE = Object.freeze({
  enabled: false,
  last_tick_at: null,
  daily_count: 0,
  daily_count_date: null,
  daily_cap: 5,
  score_threshold: 0,
});

// Local YYYY-MM-DD for the given epoch ms. Used to detect day rollover so the
// daily count resets at local midnight (matches how the owner thinks about
// "today's applications").
export function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Coerce an arbitrary parsed object into a valid state, filling missing/invalid
// fields from DEFAULT_STATE. Never throws — a corrupt field shouldn't disable
// the daemon's ability to load state.
function coerce(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_STATE.enabled,
    last_tick_at: typeof o.last_tick_at === 'string' ? o.last_tick_at : null,
    // daily_count floored at 0 — a negative count would inflate remaining cap.
    daily_count: Math.max(0, num(o.daily_count, 0)),
    daily_count_date: typeof o.daily_count_date === 'string' ? o.daily_count_date : null,
    // Clamp to [0, HARD_DAILY_CAP] regardless of write path (rule-2 safety).
    daily_cap: Math.min(HARD_DAILY_CAP, Math.max(0, num(o.daily_cap, DEFAULT_STATE.daily_cap))),
    // Clamp to [0, MAX_SCORE_THRESHOLD]; a negative or >5 threshold is nonsense
    // on the 1–5 Stage scale (negative → matches all, >5 → matches none).
    score_threshold: Math.min(MAX_SCORE_THRESHOLD, Math.max(0, num(o.score_threshold, DEFAULT_STATE.score_threshold))),
  };
}

// Missing file or unparseable contents → DEFAULT_STATE. Never throws (state
// corruption shouldn't kill the daemon — it boots OFF and waits for /enable).
export async function readAutopilotState(file = AUTOPILOT_STATE_FILE) {
  if (!existsSync(file)) return { ...DEFAULT_STATE };
  try {
    const raw = await fs.readFile(file, 'utf-8');
    if (!raw.trim()) return { ...DEFAULT_STATE };
    return coerce(JSON.parse(raw));
  } catch (e) {
    console.warn(`[autopilotState] read failed, using defaults: ${e.message}`);
    return { ...DEFAULT_STATE };
  }
}

// Atomic-rename write. Tmp filename includes a UUID slice so two concurrent
// writers in the same ms don't collide on tmp path (same as cadenceState).
export async function writeAutopilotState(state, file = AUTOPILOT_STATE_FILE) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  const clean = coerce(state);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(clean, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return clean;
}

// Module-level promise queue serializes read-modify-write so concurrent
// patchers (e.g. tick incrementing daily_count while POST /config edits the
// cap) can't lost-update each other. Mirrors cadenceState.updateForTypes.
let _updateQueue = Promise.resolve();

// Read-modify-write: shallow-merge `patch` into current state, persist, return
// the new state. Serialized via the queue. Throws on write failure (caller
// decides whether to swallow — the tick swallows).
export function patchAutopilotState(patch, file = AUTOPILOT_STATE_FILE) {
  const prev = _updateQueue;
  const next = (async () => {
    await prev.catch(() => {});
    const state = await readAutopilotState(file);
    const merged = coerce({ ...state, ...patch });
    return writeAutopilotState(merged, file);
  })();
  // Keep the queue alive even if this RMW rejects (failures isolated to caller).
  _updateQueue = next.catch(() => {});
  return next;
}

// Returns state with daily_count reset to 0 if daily_count_date != today.
// Pure read-side helper — does NOT persist. The tick calls this then persists
// via patchAutopilotState when it actually does work, so a reset alone doesn't
// thrash the file every tick. now is injectable for tests.
export function withDailyReset(state, nowMs = Date.now()) {
  const today = dayKey(nowMs);
  if (state.daily_count_date === today) return state;
  return { ...state, daily_count: 0, daily_count_date: today };
}
