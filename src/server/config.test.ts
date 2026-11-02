import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveAccountDisplay, resolveEffort, resolveModel } from './config.js';
import { displayAccount, resolveAgentAuth } from './auth/agent.js';

const EMAIL = 'alice@example.com';

test('displayAccount: hide drops the email, mask keeps only the first letter and domain, show keeps it', () => {
  assert.equal(displayAccount(EMAIL, 'hide'), undefined);
  assert.equal(displayAccount(EMAIL, 'mask'), 'a***@example.com');
  assert.equal(displayAccount(EMAIL, 'show'), EMAIL);
  assert.equal(displayAccount('not-an-email', 'mask'), '***');
});

test('resolveAccountDisplay: env > config > hide', () => {
  const mask = { value: { privacy: { account: 'mask' as const } }, warnings: [] };
  assert.deepEqual(resolveAccountDisplay({}, { value: {}, warnings: [] }), { value: 'hide', warnings: [] });
  assert.equal(resolveAccountDisplay({}, mask).value, 'mask');
  assert.equal(resolveAccountDisplay({ BACKCOURT_DUO_ACCOUNT: 'show' }, mask).value, 'show');
  const bogus = resolveAccountDisplay({ BACKCOURT_DUO_ACCOUNT: 'bogus' }, mask);
  assert.equal(bogus.value, 'mask');
  assert.match(bogus.warnings[0] ?? '', /BACKCOURT_DUO_ACCOUNT/);
});

test('resolveModel: --model > env > config agent.model > undefined', () => {
  const cfg = { value: { agent: { model: 'haiku' } }, warnings: [] };
  assert.equal(resolveModel(undefined, {}, { value: {}, warnings: [] }), undefined);
  assert.equal(resolveModel(undefined, {}, cfg), 'haiku');
  assert.equal(resolveModel(undefined, { BACKCOURT_DUO_MODEL: 'sonnet' }, cfg), 'sonnet');
  assert.equal(resolveModel('opus', { BACKCOURT_DUO_MODEL: 'sonnet' }, cfg), 'opus');
});

test('resolveEffort: --effort > env > config agent.effort > undefined; a bad env value warns', () => {
  const cfg = { value: { agent: { effort: 'low' as const } }, warnings: [] };
  assert.deepEqual(resolveEffort(undefined, {}, { value: {}, warnings: [] }), { value: undefined, warnings: [] });
  assert.equal(resolveEffort(undefined, {}, cfg).value, 'low');
  assert.equal(resolveEffort(undefined, { BACKCOURT_DUO_EFFORT: 'xhigh' }, cfg).value, 'xhigh');
  assert.equal(resolveEffort('max', { BACKCOURT_DUO_EFFORT: 'xhigh' }, cfg).value, 'max');
  const bogus = resolveEffort(undefined, { BACKCOURT_DUO_EFFORT: 'turbo' }, cfg);
  assert.equal(bogus.value, 'low');
  assert.match(bogus.warnings[0] ?? '', /BACKCOURT_DUO_EFFORT/);
});

test('loadConfig: missing → empty, broken or invalid → ignored, unknown keys kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bcd-config-'));
  assert.deepEqual(loadConfig(join(dir, 'nope.json')), { value: {}, warnings: [] });
  const p = join(dir, 'config.json');
  await writeFile(p, '{ not json');
  assert.deepEqual(loadConfig(p).value, {});
  assert.equal(loadConfig(p).warnings.length, 1);
  await writeFile(p, JSON.stringify({ privacy: { account: 'everyone' } }));
  assert.deepEqual(loadConfig(p).value, {});
  assert.equal(loadConfig(p).warnings.length, 1);
  await writeFile(p, JSON.stringify({ privacy: { account: 'mask' }, language: 'ja' }));
  assert.deepEqual(loadConfig(p), { value: { privacy: { account: 'mask' }, language: { conversation: 'ja', review: 'ja' } }, warnings: [] });
});

test('resolveAgentAuth (claude-code) never puts the raw email in the summary unless show', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bcd-claude-'));
  const bin = join(dir, 'claude');
  const status = { loggedIn: true, authMethod: 'claude.ai', email: EMAIL, subscriptionType: 'pro' };
  await writeFile(bin, `#!/bin/sh\necho '${JSON.stringify(status)}'\n`);
  await chmod(bin, 0o755);
  const prev = process.env['BACKCOURT_DUO_CLAUDE_PATH'];
  process.env['BACKCOURT_DUO_CLAUDE_PATH'] = bin;
  try {
    const hidden = (await resolveAgentAuth('claude-code', 'hide')).summary;
    assert.equal(hidden.ready, true);
    assert.equal(hidden.subscription, 'pro');
    assert.ok(!JSON.stringify(hidden).includes(EMAIL));
    assert.equal(hidden.account, undefined);
    assert.equal((await resolveAgentAuth('claude-code', 'mask')).summary.account, 'a***@example.com');
    assert.equal((await resolveAgentAuth('claude-code', 'show')).summary.account, EMAIL);
  } finally {
    if (prev === undefined) delete process.env['BACKCOURT_DUO_CLAUDE_PATH'];
    else process.env['BACKCOURT_DUO_CLAUDE_PATH'] = prev;
  }
});
