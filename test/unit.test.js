'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const s = require('../server.js');

// ── injectFreebuffMarker ─────────────────────────────────────────────────────

test('marker: prepends marker to existing system message', () => {
  const out = s.injectFreebuffMarker({
    messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'hi' }],
  });
  assert.ok(out.messages[0].content.startsWith('You are Buffy, the strategic coding assistant.'));
  assert.ok(out.messages[0].content.includes('Be concise.'));
  assert.strictEqual(out.messages.length, 2);
});

test('marker: inserts system message when none exists', () => {
  const out = s.injectFreebuffMarker({
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(out.messages[0].role, 'system');
  assert.ok(out.messages[0].content.includes('Buffy'));
  assert.strictEqual(out.messages[1].role, 'user');
});

test('marker: leaves already-marked system untouched', () => {
  const payload = {
    messages: [{ role: 'system', content: 'You are Buffy, the strategic coding assistant.' }],
  };
  const out = s.injectFreebuffMarker(payload);
  assert.strictEqual(out.messages[0].content, payload.messages[0].content);
});

test('marker: returns payload unchanged for empty messages', () => {
  const payload = { messages: [] };
  assert.strictEqual(s.injectFreebuffMarker(payload), payload);
});

// ── accumulateSSEToJSON ──────────────────────────────────────────────────────

test('SSE: accumulates content and usage', () => {
  const raw = [
    'data: {"id":"1","model":"m","choices":[{"delta":{"role":"assistant"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ].join('\n');
  const parsed = JSON.parse(s.accumulateSSEToJSON(raw));
  assert.strictEqual(parsed.choices[0].message.content, 'Hello');
  assert.strictEqual(parsed.choices[0].finish_reason, 'stop');
  assert.strictEqual(parsed.usage.prompt_tokens, 5);
  assert.strictEqual(parsed.usage.completion_tokens, 2);
});

test('SSE: accumulates reasoning_content', () => {
  const raw = [
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"ing"}}]}',
    'data: {"choices":[{"delta":{"content":"ans"}}]}',
  ].join('\n');
  const parsed = JSON.parse(s.accumulateSSEToJSON(raw));
  assert.strictEqual(parsed.choices[0].message.reasoning_content, 'thinking');
  assert.strictEqual(parsed.choices[0].message.content, 'ans');
});

test('SSE: handles invalid JSON lines gracefully', () => {
  const raw = 'data: not-json\ndata: {"choices":[{"delta":{"content":"ok"}}]}';
  const parsed = JSON.parse(s.accumulateSSEToJSON(raw));
  assert.strictEqual(parsed.choices[0].message.content, 'ok');
});

test('SSE: defaults for empty stream', () => {
  const parsed = JSON.parse(s.accumulateSSEToJSON(''));
  assert.strictEqual(parsed.choices[0].message.content, '');
  assert.strictEqual(parsed.choices[0].message.role, 'assistant');
});

// ── extractFinalJSONFromSSE ──────────────────────────────────────────────────

test('extract: returns last JSON chunk', () => {
  const raw = [
    'data: {"a":1}',
    'data: {"a":2}',
    'data: [DONE]',
  ].join('\n');
  assert.strictEqual(s.extractFinalJSONFromSSE(raw), JSON.stringify({ a: 2 }));
});

test('extract: falls back to accumulator when no JSON', () => {
  const out = s.extractFinalJSONFromSSE('data: [DONE]');
  assert.ok(out.includes('"object":"chat.completion"'));
});

// ── parseDuration ────────────────────────────────────────────────────────────

test('parseDuration: ms/s/m/h', () => {
  assert.strictEqual(s.parseDuration('500ms'), 500);
  assert.strictEqual(s.parseDuration('5s'), 5000);
  assert.strictEqual(s.parseDuration('2m'), 120000);
  assert.strictEqual(s.parseDuration('1h'), 3600000);
});

test('parseDuration: default 15m for garbage', () => {
  assert.strictEqual(s.parseDuration('??'), 15 * 60 * 1000);
});

// ── parseFreeAgents ──────────────────────────────────────────────────────────

test('parseFreeAgents: extracts agent→model map', () => {
  const ts = `
    export const FREE_AGENTS = {
      'base2-free-deepseek-flash': {
        models: ['deepseek/deepseek-v4-flash'],
      },
      'base2-free-mimo': {
        models: ['mimo/mimo-v2.5'],
      },
    };
  `;
  const out = s.parseFreeAgents(ts);
  assert.strictEqual(out['deepseek/deepseek-v4-flash'], 'base2-free-deepseek-flash');
  assert.strictEqual(out['mimo/mimo-v2.5'], 'base2-free-mimo');
});

test('parseFreeAgents: ignores unknown shapes', () => {
  assert.deepStrictEqual(s.parseFreeAgents('no agents here'), {});
});

// ── loadConfig ───────────────────────────────────────────────────────────────

test('loadConfig: defaults when file missing', () => {
  const cfg = s.loadConfig(path.join(os.tmpdir(), 'nonexistent-' + Date.now() + '.json'));
  assert.strictEqual(cfg.LISTEN_ADDR, ':8080');
  assert.strictEqual(cfg.MAX_REQUESTS_PER_MIN, 0);
  assert.strictEqual(cfg.CORS_ORIGIN, '*');
  assert.deepStrictEqual(cfg.AUTH_TOKENS, []);
});

test('loadConfig: merges file over defaults', () => {
  const tmp = path.join(os.tmpdir(), 'cfg-' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ LISTEN_ADDR: ':9999', MAX_REQUESTS_PER_MIN: 30 }));
  try {
    const cfg = s.loadConfig(tmp);
    assert.strictEqual(cfg.LISTEN_ADDR, ':9999');
    assert.strictEqual(cfg.MAX_REQUESTS_PER_MIN, 30);
    assert.strictEqual(cfg.UPSTREAM_BASE_URL, 'https://www.codebuff.com'); // default kept
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('loadConfig: env overrides file (AUTH_TOKENS comma-split)', () => {
  const tmp = path.join(os.tmpdir(), 'cfg-' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ LISTEN_ADDR: ':9999' }));
  const prev = process.env.AUTH_TOKENS;
  process.env.AUTH_TOKENS = ' tok1 , tok2 ';
  try {
    const cfg = s.loadConfig(tmp);
    assert.deepStrictEqual(cfg.AUTH_TOKENS, ['tok1', 'tok2']);
  } finally {
    if (prev === undefined) delete process.env.AUTH_TOKENS;
    else process.env.AUTH_TOKENS = prev;
    fs.unlinkSync(tmp);
  }
});

test('loadConfig: MAX_BODY_SIZE default 10MB', () => {
  const cfg = s.loadConfig(path.join(os.tmpdir(), 'nonexistent-' + Date.now() + '.json'));
  assert.strictEqual(cfg.MAX_BODY_SIZE, 10 * 1024 * 1024);
});

// ── token pool ───────────────────────────────────────────────────────────────

test('selectPool: round-robin skips cooldown pools', () => {
  const { tokenPools, nextPoolIdx } = s;
  const before = tokenPools.length;
  try {
    const p1 = s.createTokenPool('t1', 'a');
    const p2 = s.createTokenPool('t2', 'b');
    p1.cooldownUntil = Date.now() + 60000; // cooling down
    p2.cooldownUntil = 0;
    tokenPools.push(p1, p2);
    const picked = s.selectPool();
    assert.strictEqual(picked, p2); // skips p1 (cooldown)
  } finally {
    tokenPools.length = before;
  }
});

test('selectPool: null when all cooling down', () => {
  const { tokenPools } = s;
  const before = tokenPools.length;
  try {
    const p = s.createTokenPool('t', 'a');
    p.cooldownUntil = Date.now() + 60000;
    tokenPools.push(p);
    assert.strictEqual(s.selectPool(), null);
  } finally {
    tokenPools.length = before;
  }
});

test('createTokenPool: initial state', () => {
  const p = s.createTokenPool('tok', 'n');
  assert.strictEqual(p.name, 'n');
  assert.strictEqual(p.token, 'tok');
  assert.strictEqual(p.session, null);
  assert.strictEqual(p.activeRun, null);
  assert.strictEqual(p.lastError, '');
  assert.strictEqual(p.cooldownUntil, 0);
});

// HAFIZH-PATCH: quota/limit detection → pool cooldown → failover
test('isQuotaError: 429 and 503 always quota', () => {
  assert.strictEqual(s.isQuotaError(429, '{}'), true);
  assert.strictEqual(s.isQuotaError(503, '{"error":"overloaded"}'), true);
});

test('isQuotaError: 409 with quota/limit/capacity wording', () => {
  assert.strictEqual(s.isQuotaError(409, '{"error":"free_mode_capacity_deferred"}'), true);
  assert.strictEqual(s.isQuotaError(409, '{"error":"quota exceeded"}'), true);
  assert.strictEqual(s.isQuotaError(409, '{"error":"rate limit"}'), true);
});

test('isQuotaError: 409 model mismatch is NOT quota (session bound, not exhausted)', () => {
  assert.strictEqual(s.isQuotaError(409, '{"error":"session_model_mismatch"}'), false);
  assert.strictEqual(s.isQuotaError(409, '{"error":"session_superseded"}'), false);
  assert.strictEqual(s.isQuotaError(400, 'bad request'), false);
  assert.strictEqual(s.isQuotaError(200, ''), false);
});

// HAFIZH-PATCH: session_model_mismatch message contains "Limited free access is
// only available with DeepSeek V4 Flash or MiMo 2.5." — the word "Limited"
// (limit) previously false-positived isQuotaError → both pools cooled 10min.
test('isQuotaError: 409 session_model_mismatch WITH "Limited" wording is NOT quota', () => {
  const body = '{"error":"session_model_mismatch","message":"Limited free access is only available with DeepSeek V4 Flash or MiMo 2.5."}';
  assert.strictEqual(s.isQuotaError(409, body), false);
});

// Real quota wording still detected even at 409
test('isQuotaError: 409 with real quota wording still detected', () => {
  assert.strictEqual(s.isQuotaError(409, '{"error":"free_mode_capacity_deferred"}'), true);
  assert.strictEqual(s.isQuotaError(409, '{"error":"rate limit exceeded"}'), true);
});

// ── doctor.js helpers ────────────────────────────────────────────────────────
const d = require('../doctor.js');

test('doctor: maskToken masks middle of token', () => {
  assert.strictEqual(d.maskToken('1234567890123456'), '12345678…3456');
  assert.strictEqual(d.maskToken('short'), 'short');
  assert.strictEqual(d.maskToken(''), '(empty)');
});

test('doctor: badge renders OK/FAIL with ANSI color', () => {
  const okBadge = d.badge(true);
  assert.ok(okBadge.includes('✓'));
  assert.ok(okBadge.includes('\x1b[32m'));
  const failBadge = d.badge(false, 'problem');
  assert.ok(failBadge.includes('✗'));
  assert.ok(failBadge.includes('problem'));
  assert.ok(failBadge.includes('\x1b[31m'));
});

test('doctor: fmtTime humanizes durations', () => {
  assert.strictEqual(d.fmtTime(0), '—');
  assert.strictEqual(d.fmtTime(45 * 1000), '45s');
  assert.strictEqual(d.fmtTime(5 * 60 * 1000), '5m 0s');
  assert.strictEqual(d.fmtTime(3 * 3600 * 1000), '3j 0m');
});

test('doctor: statusColor applies color by ok', () => {
  assert.ok(d.statusColor('x', true).includes('\x1b[32m'));
  assert.ok(d.statusColor('x', false).includes('\x1b[31m'));
});

test('doctor: loadConfig parses config.json with defaults', () => {
  const { error, config } = d.loadConfig();
  assert.strictEqual(error, null);
  assert.ok(Array.isArray(config.AUTH_TOKENS));
  assert.ok(config.UPSTREAM_BASE_URL);
});
