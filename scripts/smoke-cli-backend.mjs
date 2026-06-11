#!/usr/bin/env node
// Smoke for the `claude -p` CLI LLM backend (anthropicClient.makeCliClient).
//
// This is the only test that exercises the CLI backend end-to-end, since
// MOCK_ANTHROPIC short-circuits getClient() before the CLI branch. It makes
// a REAL `claude -p` round-trip, so it needs:
//   - `claude` on PATH (Claude Code install, subscription auth)
//   - network (the CLI talks to Anthropic)
//
// It is therefore NOT part of the offline smoke suite — run it manually to
// confirm CAREER_LLM_BACKEND=cli works in your environment:
//
//     node scripts/smoke-cli-backend.mjs
//
// Exits 0 on success, non-zero on failure. ~1 short Haiku call (cheap).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error('  ', e?.message ?? e);
    failed++;
  }
}

// ── Preflight: claude on PATH ──────────────────────────────────────────────
const which = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (which.error || which.status !== 0) {
  console.error(
    'SKIP: `claude` CLI not found on PATH. Install Claude Code (or run this ' +
      'in a shell where `claude --version` works) to exercise the CLI backend.',
  );
  process.exit(2);
}
console.log('claude CLI:', (which.stdout || '').trim());

// Force the CLI backend BEFORE importing the client (getClient memoizes).
process.env.CAREER_LLM_BACKEND = 'cli';
delete process.env.MOCK_ANTHROPIC; // MOCK would short-circuit the CLI branch
delete process.env.ANTHROPIC_API_KEY; // prove no key is needed

const { getClient } = await import('../src/career/lib/anthropicClient.mjs');

await test('getClient() returns the CLI-backed client (no API key)', () => {
  const client = getClient();
  assert.ok(client && client.messages && typeof client.messages.create === 'function');
});

await test('messages.create round-trips through `claude -p`', async () => {
  const client = getClient();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly the single word: PONG. No punctuation.',
      },
    ],
  });

  // SDK-shaped response
  assert.equal(res.type, 'message', 'type should be "message"');
  assert.equal(res.role, 'assistant', 'role should be "assistant"');
  assert.ok(Array.isArray(res.content) && res.content[0]?.type === 'text', 'content[0] should be a text block');

  const text = res.content[0].text || '';
  console.log('   model replied:', JSON.stringify(text.slice(0, 60)));
  assert.ok(/pong/i.test(text), `expected reply to contain "PONG", got: ${text.slice(0, 80)}`);

  // usage normalized to SDK shape so downstream cost code works
  assert.equal(typeof res.usage?.input_tokens, 'number', 'usage.input_tokens should be a number');
  assert.equal(typeof res.usage?.output_tokens, 'number', 'usage.output_tokens should be a number');
  assert.ok(res.usage.output_tokens > 0, 'output_tokens should be > 0');
});

await test('system prompt is honored via --system-prompt', async () => {
  const client = getClient();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    system: 'You always answer with exactly one word: BANANA.',
    messages: [{ role: 'user', content: 'What is your favorite fruit?' }],
  });
  const text = res.content?.[0]?.text || '';
  console.log('   system-steered reply:', JSON.stringify(text.slice(0, 60)));
  assert.ok(/banana/i.test(text), `expected system prompt to steer reply to "BANANA", got: ${text.slice(0, 80)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
