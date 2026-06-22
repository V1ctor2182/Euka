// Autopilot activity feed + funnel aggregation — the single endpoint the
// Dashboard (11-autopilot-ui-reframe m1) reads to render the activity stream
// and the 4 funnel numbers.
//
// 10-autopilot-engine m3.
//
// Feed: append-only JSONL at data/career/autopilot-feed.jsonl. One line per
// orchestrator per-candidate outcome (parked / needs_review / needs_human /
// failed / timeout / busy). Append-only so it survives restarts and is cheap to
// tail; readRecentFeed returns the newest N.
//
// Funnel: 4 counts computed live from pipeline + apply-sessions + applications
// (no separate persistence — always consistent with the source of truth).

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readApplications } from '../applications/store.mjs';
import { readSession } from '../applier/multistep/applySessionsStore.mjs';
import { readAutopilotState } from './autopilotState.mjs';
import {
  selectCandidates,
  readPipelineJobs,
  appliedJobIdSet,
  readActiveSessionJobIds,
} from './orchestrator.mjs';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const AUTOPILOT_FEED_FILE = path.join(CAREER_DIR, 'autopilot-feed.jsonl');

// Bounded so the activity-stream read is cheap and the file doesn't grow
// unbounded. We keep the newest CAP lines on each append-driven rewrite.
const FEED_CAP = 500;

export const FEED_EVENT_TYPES = Object.freeze([
  'parked',
  'needs_review',
  'needs_human',
  'failed',
  'timeout',
  'busy',
]);

// Append one event. Never throws (a feed-write failure must not break the tick).
// `at` is injectable for tests (Date.now() is unavailable in some contexts).
export async function appendEvent(type, payload = {}, file = AUTOPILOT_FEED_FILE) {
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
    const ts = typeof payload.ts === 'string' ? payload.ts : new Date(payload.at ?? Date.now()).toISOString();
    // Strip at/ts/type from rest so the explicit `type` param is canonical (a
    // divergent payload.type can't override it via the spread).
    const { at: _at, ts: _ts, type: _type, ...rest } = payload;
    const line = JSON.stringify({ ts, type, ...rest });
    await fs.appendFile(file, line + '\n');
  } catch (e) {
    console.warn('[autopilot] feed append failed:', String(e?.message ?? e).slice(0, 200));
  }
}

// Newest `limit` events, newest-first. Missing/corrupt file → []. Never throws.
export async function readRecentFeed(limit = 50, file = AUTOPILOT_FEED_FILE) {
  if (!existsSync(file)) return [];
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const out = [];
    // Parse from the end so a single corrupt early line doesn't cost us the tail.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch (e) {
    console.warn('[autopilot] feed read failed:', String(e?.message ?? e).slice(0, 200));
    return [];
  }
}

// Keep only the newest FEED_CAP lines. Called opportunistically (not on every
// append — that would be O(n) per event). SAFE against concurrent appends only
// because the orchestrator's single-flight tick serializes all emits (and the
// server awaits appendEvent before compactFeed), so no append lands between the
// read snapshot and the rename. Never throws.
export async function compactFeed(file = AUTOPILOT_FEED_FILE, cap = FEED_CAP) {
  if (!existsSync(file)) return;
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length <= cap) return;
    const kept = lines.slice(lines.length - cap);
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, kept.join('\n') + '\n');
    await fs.rename(tmp, file);
  } catch (e) {
    console.warn('[autopilot] feed compact failed:', String(e?.message ?? e).slice(0, 200));
  }
}

// Statuses that count as "submitted" in the funnel (reached the Applied
// milestone or beyond, excluding the terminal Rejected/Discarded/SKIP).
const SUBMITTED_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer']);

// The 4 funnel numbers, computed live. Mirrors the daemon's own view:
//   candidates  — eligible jobs the daemon could fill next (same selection as
//                 the tick, ignoring the daily cap so the number is stable)
//   filling     — apply-sessions currently active (a fill in progress)
//   parked      — apply-sessions paused at the submit gate, awaiting human
//   submitted   — applications that reached Applied+ (post-Submit)
// All deps injectable for tests. Never throws — a failed read degrades the
// affected number to 0 rather than 500-ing the whole dashboard.
export async function computeFunnel(deps = {}) {
  const _readState = deps.readState ?? readAutopilotState;
  const _readPipeline = deps.readPipeline ?? readPipelineJobs;
  const _readApps = deps.readApplications ?? readApplications;
  const _readSessionIds = deps.readActiveSessions ?? readActiveSessionJobIds;
  const _readSession = deps.readSession ?? readSession;

  let candidates = 0;
  let filling = 0;
  let parked = 0;
  let submitted = 0;

  let apps = [];
  try {
    apps = await _readApps();
    if (!Array.isArray(apps)) apps = [];
  } catch { apps = []; }

  let sessionIds = [];
  try {
    sessionIds = await _readSessionIds();
  } catch { sessionIds = []; }

  try {
    const jobs = await _readPipeline();
    const state = await _readState();
    const appliedJobIds = appliedJobIdSet(apps);
    for (const id of sessionIds) appliedJobIds.add(id);
    candidates = selectCandidates(jobs, {
      threshold: state.score_threshold,
      limit: Array.isArray(jobs) ? jobs.length : 0,
      appliedJobIds,
    }).length;
  } catch { candidates = 0; }

  // Read session statuses in parallel (one /feed poll shouldn't serialize N
  // disk reads). Each read degrades to null on failure → counted as neither.
  const statuses = await Promise.all(
    sessionIds.map((id) => _readSession(id).then((s) => s?.status ?? null).catch(() => null)),
  );
  for (const st of statuses) {
    if (st === 'active') filling += 1;
    else if (st === 'paused') parked += 1;
  }

  submitted = apps.filter((a) => SUBMITTED_STATUSES.has(a?.status)).length;

  return { candidates, filling, parked, submitted };
}
