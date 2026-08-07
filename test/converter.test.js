'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const s = require('../server.js');

test('anthropicToOpenAI: converts system string', () => {
  const out = s.anthropicToOpenAI({
    model: 'deepseek/deepseek-v4-flash',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: false,
  });
  assert.deepStrictEqual(out.messages[0], { role: 'system', content: 'You are helpful.' });
  assert.deepStrictEqual(out.messages[1], { role: 'user', content: 'Hi' });
  assert.strictEqual(out.model, 'deepseek/deepseek-v4-flash');
  assert.strictEqual(out.stream, false);
});

test('anthropicToOpenAI: converts system array of blocks', () => {
  const out = s.anthropicToOpenAI({
    model: 'm',
    system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
    messages: [],
  });
  assert.strictEqual(out.messages[0].content, 'A\nB');
});

test('anthropicToOpenAI: converts content blocks (text + image)', () => {
  const out = s.anthropicToOpenAI({
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is' },
      { type: 'image', source: { type: 'base64', data: 'x' } },
    ] }],
  });
  assert.strictEqual(out.messages[0].content, 'what is\n[image]');
});

test('anthropicToOpenAI: copies max_tokens/temperature/top_p', () => {
  const out = s.anthropicToOpenAI({
    model: 'm', messages: [], max_tokens: 512, temperature: 0.5, top_p: 0.9,
  });
  assert.strictEqual(out.max_tokens, 512);
  assert.strictEqual(out.temperature, 0.5);
  assert.strictEqual(out.top_p, 0.9);
});

test('anthropicToOpenAI: omits undefined optional params', () => {
  const out = s.anthropicToOpenAI({ model: 'm', messages: [] });
  assert.ok(!('max_tokens' in out));
  assert.ok(!('temperature' in out));
});

test('openAIToAnthropic: full conversion', () => {
  const out = s.openAIToAnthropic({
    id: 'chatcmpl-1',
    model: 'deepseek/deepseek-v4-flash',
    choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.strictEqual(out.type, 'message');
  assert.strictEqual(out.role, 'assistant');
  assert.deepStrictEqual(out.content, [{ type: 'text', text: 'Hello' }]);
  assert.strictEqual(out.stop_reason, 'end_turn');
  assert.strictEqual(out.usage.input_tokens, 10);
  assert.strictEqual(out.usage.output_tokens, 5);
});

test('openAIToAnthropic: maps finish_reason length → length', () => {
  const out = s.openAIToAnthropic({
    choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
  });
  assert.strictEqual(out.stop_reason, 'length');
});

test('openAIToAnthropic: includes reasoning_content as [reasoning] block', () => {
  const out = s.openAIToAnthropic({
    choices: [{ message: { content: 'Answer', reasoning_content: 'thinking...' } }],
  });
  assert.deepStrictEqual(out.content, [
    { type: 'text', text: 'Answer' },
    { type: 'text', text: '[reasoning] thinking...' },
  ]);
});

test('openAIChunkToAnthropicSSE: content delta', () => {
  const sse = s.openAIChunkToAnthropicSSE({
    choices: [{ delta: { content: 'Hi' } }],
  });
  assert.ok(sse.includes('event: content_block_delta'));
  assert.ok(sse.includes('"delta":{"type":"text_delta","text":"Hi"}'));
});

test('openAIChunkToAnthropicSSE: reasoning delta prefixed', () => {
  const sse = s.openAIChunkToAnthropicSSE({
    choices: [{ delta: { reasoning_content: 'hmm' } }],
  });
  assert.ok(sse.includes('[reasoning] hmm'));
});

test('openAIChunkToAnthropicSSE: empty delta → empty string', () => {
  assert.strictEqual(s.openAIChunkToAnthropicSSE({ choices: [{ delta: {} }] }), '');
});
