// Manual apply queue — jobIds the user explicitly pushed to the daemon via the
// Jobs page "让机器投" button. These are filled by the orchestrator's tick on a
// FORCED pass that bypasses the score threshold (the user chose them on
// purpose), but still respects: solved ATS only, never re-apply, daily cap,
// single-flight. Drained once attempted.
//
// 11-autopilot-ui-reframe m3. Persisted so a queued job survives a restart and
// still gets picked up when Autopilot is next ON.

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const AUTOPILOT_QUEUE_FILE = path.join(CAREER_DIR, 'autopilot-queue.json');

const JOB_ID_RE = /^[a-f0-9]{12}$/;

// Returns the queued jobIds (deduped, valid only). Missing/corrupt → []. Never
// throws.
export async function readQueue(file = AUTOPILOT_QUEUE_FILE) {
  if (!existsSync(file)) return [];
  try {
    const raw = await fs.readFile(file, 'utf-8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id) => typeof id === 'string' && JOB_ID_RE.test(id)))];
  } catch (e) {
    console.warn(`[autopilot] queue read failed, treating as empty: ${e.message}`);
    return [];
  }
}

async function writeQueue(ids, file = AUTOPILOT_QUEUE_FILE) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(ids, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// Serialize read-modify-write so concurrent enqueue/dequeue can't lost-update.
let _q = Promise.resolve();
function rmw(fn, file) {
  const next = (async () => {
    await _q.catch(() => {});
    const ids = await readQueue(file);
    const nextIds = fn(ids);
    await writeQueue(nextIds, file);
    return nextIds;
  })();
  _q = next.catch(() => {});
  return next;
}

// Hard cap so a buggy/abusive client can't grow the file unbounded. Drop-oldest
// beyond the cap (FIFO) — the daemon drains the front each tick anyway.
const QUEUE_CAP = 200;

// Add a jobId (idempotent). Returns the new queue. Throws only on write failure.
export function enqueue(jobId, file = AUTOPILOT_QUEUE_FILE) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    return Promise.reject(new Error('invalid jobId'));
  }
  return rmw((ids) => {
    if (ids.includes(jobId)) return ids;
    const next = [...ids, jobId];
    return next.length > QUEUE_CAP ? next.slice(next.length - QUEUE_CAP) : next;
  }, file);
}

// Remove jobIds (e.g. after the tick attempts them). Returns the new queue.
export function dequeue(jobIds, file = AUTOPILOT_QUEUE_FILE) {
  const drop = new Set(Array.isArray(jobIds) ? jobIds : [jobIds]);
  return rmw((ids) => ids.filter((id) => !drop.has(id)), file);
}
