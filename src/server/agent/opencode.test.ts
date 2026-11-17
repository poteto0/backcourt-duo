import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeConfig, parseOpencodeModels } from './opencode.js';

test('opencodeConfig: duo agent, read-only permissions, and the duo MCP server', () => {
  const config = opencodeConfig({ system: 'SYSTEM', mcpUrl: 'http://127.0.0.1:1200/mcp', token: 'tok' }) as Record<string, any>;
  assert.equal(config['default_agent'], 'duo');
  assert.equal(config['agents']['duo']['system'], 'SYSTEM');
  assert.equal(config['agents']['duo']['mode'], 'primary');
  const denied = new Set(config['agents']['duo']['permissions'].map((p: any) => p.action));
  for (const action of ['edit', 'shell', 'webfetch', 'websearch', 'subagent']) assert.ok(denied.has(action), action);
  const server = config['mcp']['servers']['duo'];
  assert.equal(server.type, 'remote');
  assert.equal(server.url, 'http://127.0.0.1:1200/mcp');
  assert.equal(server.oauth, false);
  assert.equal(server.codemode, false);
  assert.equal(server.headers['Authorization'], 'Bearer tok');
});

test('parseOpencodeModels: provider/model lines, duplicates dropped, first slash splits', () => {
  const models = parseOpencodeModels('anthropic/claude-sonnet-5-5\nopencode/free\n\nopencode/free\nvendor/model/with/slash\n');
  assert.deepEqual(
    models.map((m) => m.value),
    ['anthropic/claude-sonnet-5-5', 'opencode/free', 'vendor/model/with/slash'],
  );
  assert.equal(models[0]?.displayName, 'claude-sonnet-5-5');
  assert.match(models[0]?.description ?? '', /anthropic/);
  assert.equal(models[2]?.displayName, 'model/with/slash');
});
