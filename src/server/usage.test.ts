import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { compact, TokenMeter, toolResultChars } from './agent/usage.js';

const usage = (u: Partial<ModelUsage>): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  ...u,
});

// Only the fields TokenMeter reads; the SDK message types are much wider.
const toolUses = (...uses: Array<[string, string]>) =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { content: uses.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} })) } }) as unknown as SDKMessage;
const toolResults = (...results: Array<[string, unknown]>) =>
  ({ type: 'user', message: { content: results.map(([tool_use_id, content]) => ({ type: 'tool_result', tool_use_id, content })) } }) as unknown as SDKMessage;
const result = (modelUsage: Record<string, ModelUsage>) => ({ type: 'result', subtype: 'success', modelUsage }) as unknown as SDKMessage;

test('compact', () => {
  assert.equal(compact(950), '950');
  assert.equal(compact(1200), '1.2k');
  assert.equal(compact(12_400), '12.4k');
  assert.equal(compact(180_000), '180k');
  assert.equal(compact(2_500_000), '2.5M');
});

test('toolResultChars: string or text blocks', () => {
  assert.equal(toolResultChars('abc'), 3);
  assert.equal(toolResultChars([{ type: 'text', text: 'ab' }, { type: 'image' }, { type: 'text', text: 'cd' }]), 4);
  assert.equal(toolResultChars(undefined), 0);
});

test('TokenMeter: first turn as-is, later turns are the difference; tools reset per turn', () => {
  const meter = new TokenMeter();
  assert.equal(meter.observe(toolUses(['t1', 'mcp__duo__get_file_diff'], ['t2', 'mcp__duo__get_file_diff'], ['t3', 'Read'])), undefined);
  meter.observe(toolResults(['t1', 'x'.repeat(5000)], ['t2', [{ type: 'text', text: 'y'.repeat(3000) }]], ['t3', 'z'.repeat(400)], ['unknown', 'ignored']));
  const first = { opus: usage({ inputTokens: 12_400, cacheReadInputTokens: 180_000, cacheCreationInputTokens: 9000, outputTokens: 1200, costUSD: 0.031 }) };
  assert.equal(
    meter.observe(result(first)),
    '[tokens] turn=1 in=12.4k cache_read=180k cache_write=9k out=1.2k cost=$0.031 tools=get_file_diff×2:8k,Read×1:400',
  );
  const second = {
    opus: usage({ inputTokens: 13_400, cacheReadInputTokens: 200_000, cacheCreationInputTokens: 9500, outputTokens: 1500, thinkingTokens: 100, costUSD: 0.041 }),
    haiku: usage({ inputTokens: 500, outputTokens: 50, costUSD: 0.001 }),
  };
  assert.equal(meter.observe(result(second)), '[tokens] turn=2 in=1.5k cache_read=20k cache_write=500 out=350 thinking=100 cost=$0.011');
});
