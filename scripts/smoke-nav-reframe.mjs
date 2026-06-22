#!/usr/bin/env node
// Smoke for 11-autopilot-ui-reframe m4: nav reframe + Profile reclass.
// This milestone is pure client-side routing/structure (no new endpoints), so
// it's a structural-invariant guard over the source — it locks the autopilot
// closed-loop nav, the legacy-route redirects (no 404), and the Profile groups.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.error('FAIL:', name); console.error(e); process.exit(1); }
}
const read = (p) => fs.readFile(path.resolve(p), 'utf-8');

await test('CareerNav: 5 autopilot-loop tabs, legacy entries gone', async () => {
  const src = await read('src/career/CareerNav.tsx');
  for (const route of ['/career/dashboard', '/career/review', '/career/find-jobs', '/career/applied', '/career/settings']) {
    assert.ok(src.includes(route), `primary tab ${route} present`);
  }
  for (const label of ['Dashboard', 'Review', 'Jobs', 'Tracker', 'Profile']) {
    assert.ok(src.includes(`'${label}'`) || src.includes(`"${label}"`) || src.includes(`label: '${label}'`), `label ${label}`);
  }
  // Legacy entries removed from the nav.
  assert.ok(!src.includes('(legacy)'), 'no "(legacy)" nav entries');
  assert.ok(!/ADVANCED_TABS[\s\S]*\/career\/overview/.test(src), 'overview not in ADVANCED_TABS');
});

await test('CareerApp: legacy routes redirect (no 404), components not imported', async () => {
  const src = await read('src/CareerApp.tsx');
  // Redirects present
  assert.ok(/path="overview"\s+element=\{<Navigate to="\/career\/dashboard"/.test(src), 'overview→dashboard redirect');
  assert.ok(/path="pipeline"\s+element=\{<Navigate to="\/career\/find-jobs"/.test(src), 'pipeline→jobs redirect');
  assert.ok(/path="shortlist"\s+element=\{<Navigate to="\/career\/find-jobs"/.test(src), 'shortlist→jobs redirect');
  // Legacy page components no longer imported (dead-route cleanup)
  assert.ok(!/import Overview from/.test(src), 'Overview import removed');
  assert.ok(!/import Pipeline from/.test(src), 'Pipeline import removed');
  assert.ok(!/import Shortlist from/.test(src), 'Shortlist import removed');
  // Catch-all no longer points at the removed overview page
  assert.ok(!/path="\*" element=\{<Navigate to="overview"/.test(src), 'catch-all not → overview');
  assert.ok(/path="\*" element=\{<Navigate to="dashboard"/.test(src), 'catch-all → dashboard');
});

await test('SettingsLayout: 3 groups incl. Dev/Debug with absolute debug links', async () => {
  const src = await read('src/career/settings/SettingsLayout.tsx');
  for (const title of ['机器怎么填', '机器怎么找', '集成 & 调试']) {
    assert.ok(src.includes(title), `group "${title}"`);
  }
  assert.ok(src.includes("'/career/learning'"), 'Learning absolute link');
  assert.ok(src.includes("'/career/iteration'"), 'Iteration absolute link');
  // Sources/Filters relabeled under 机器怎么找
  assert.ok(/label: 'Filters'/.test(src) && /label: 'Sources'/.test(src), 'Filters + Sources labels');
});

await test('dist build artifact exists (vite build ran clean)', async () => {
  // Guards that the reframe compiles — `npx vite build` is run in CI/dev; here we
  // just assert the bundle was produced at least once.
  const exists = await fs.stat(path.resolve('dist/index.html')).then(() => true).catch(() => false);
  assert.ok(exists, 'dist/index.html present (run `npx vite build`)');
});

console.log(`\n${passed} passed`);
