#!/usr/bin/env node
// Smoke for 11-autopilot-ui-reframe m4 + the standalone-product route refactor.
// Pure client-side routing/structure (no new endpoints) — a structural-invariant
// guard over the source: autopilot closed-loop nav, root-mounted routes (no
// /career prefix), legacy redirects (no 404), and the Profile groups.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.error('FAIL:', name); console.error(e); process.exit(1); }
}
const read = (p) => fs.readFile(path.resolve(p), 'utf-8');

await test('App: standalone root mount + legacy /career/* redirect', async () => {
  const src = await read('src/App.tsx');
  assert.ok(/path="\/\*"\s+element=\{<CareerApp/.test(src), 'CareerApp mounted at /*');
  assert.ok(/path="\/career\/\*"/.test(src), 'legacy /career/* route present');
  assert.ok(/replace\(\/\^\\\/career/.test(src) || src.includes('/^\\/career'), 'strips /career prefix');
});

await test('CareerNav: 5 autopilot-loop tabs at root, legacy entries gone', async () => {
  const src = await read('src/career/CareerNav.tsx');
  for (const route of ['/dashboard', '/review', '/find-jobs', '/applied', '/settings']) {
    assert.ok(src.includes(`'${route}'`), `primary tab ${route} present`);
  }
  for (const label of ['Dashboard', 'Review', 'Jobs', 'Tracker', 'Profile']) {
    assert.ok(src.includes(`'${label}'`), `label ${label}`);
  }
  assert.ok(!src.includes('(legacy)'), 'no "(legacy)" nav entries');
  // No /career-prefixed ROUTER links (quote-anchored); /api/career API calls are fine.
  assert.ok(!/['"`]\/career\//.test(src), 'no /career-prefixed router links');
});

await test('CareerApp: root routes, legacy redirects (no 404), no legacy imports', async () => {
  const src = await read('src/CareerApp.tsx');
  assert.ok(/path="overview" element=\{<Navigate to="\/dashboard"/.test(src), 'overview→/dashboard');
  assert.ok(/path="pipeline" element=\{<Navigate to="\/find-jobs"/.test(src), 'pipeline→/find-jobs');
  assert.ok(/path="shortlist" element=\{<Navigate to="\/find-jobs"/.test(src), 'shortlist→/find-jobs');
  assert.ok(!/import Overview from/.test(src), 'Overview import removed');
  assert.ok(!/import Pipeline from/.test(src), 'Pipeline import removed');
  assert.ok(!/import Shortlist from/.test(src), 'Shortlist import removed');
  // Catch-all must be ABSOLUTE (a relative target loops on deep unknown paths).
  assert.ok(/path="\*" element=\{<Navigate to="\/dashboard"/.test(src), 'catch-all → /dashboard (absolute)');
  assert.ok(!src.includes('Back to Learn'), 'vestigial Back-to-Learn arrow removed');
});

await test('SettingsLayout: 3 groups incl. Dev/Debug with absolute debug links', async () => {
  const src = await read('src/career/settings/SettingsLayout.tsx');
  for (const title of ['机器怎么填', '机器怎么找', '集成 & 调试']) {
    assert.ok(src.includes(title), `group "${title}"`);
  }
  assert.ok(src.includes("'/learning'"), 'Learning absolute link');
  assert.ok(src.includes("'/iteration'"), 'Iteration absolute link');
  assert.ok(/label: 'Filters'/.test(src) && /label: 'Sources'/.test(src), 'Filters + Sources labels');
});

await test('dist build artifact exists (vite build ran clean)', async () => {
  const exists = await fs.stat(path.resolve('dist/index.html')).then(() => true).catch(() => false);
  assert.ok(exists, 'dist/index.html present (run `npx vite build`)');
});

console.log(`\n${passed} passed`);
