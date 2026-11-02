import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './http.js';
import { LocalSession } from './auth/local.js';
import { ReviewStore } from './store.js';
import { parseUnifiedDiff } from './diff.js';

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 one
-two
+TWO
`;

function setup() {
  const target = { base: 'origin/main', baseSha: 'b', head: 'HEAD', headSha: 'h', mergeBaseSha: 'm', uncommitted: false, branch: 'feat', repoRoot: '/r', repoName: 'r' };
  const store = new ReviewStore(target, parseUnifiedDiff(DIFF), null);
  const session = new LocalSession(1200);
  const app = createApp({ store, session, agent: null, github: null, authMode: 'claude-code', webRoot: '/nonexistent' });
  return { app, store, session };
}

const host = { Host: 'localhost:1200' };

test('rejects foreign Host headers (DNS rebinding)', async () => {
  const { app } = setup();
  const res = await app.request('/api/state', { headers: { Host: 'evil.example:1200' } });
  assert.equal(res.status, 421);
});

test('requires the session token for the API', async () => {
  const { app, session } = setup();
  assert.equal((await app.request('/api/state', { headers: host })).status, 401);
  const ok = await app.request('/api/state', { headers: { ...host, Authorization: `Bearer ${session.token}` } });
  assert.equal(ok.status, 200);
});

test('exchanges ?token= for an HttpOnly cookie', async () => {
  const { app, session } = setup();
  const res = await app.request(`/?token=${session.token}`, { headers: host });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('set-cookie') ?? '', /bd_session=.*HttpOnly.*SameSite=Strict/i);
  assert.equal((await app.request('/?token=wrong', { headers: host })).status, 401);
});

test('mutations need a same-origin Origin and JSON', async () => {
  const { app, session, store } = setup();
  const auth = { ...host, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ path: 'a.ts', line: 2, body: 'hi' });
  assert.equal((await app.request('/api/pending', { method: 'POST', headers: auth, body })).status, 403);
  assert.equal((await app.request('/api/pending', { method: 'POST', headers: { ...auth, Origin: 'http://evil.example' }, body })).status, 403);
  const ok = await app.request('/api/pending', { method: 'POST', headers: { ...auth, Origin: 'http://localhost:1200' }, body });
  assert.equal(ok.status, 200);
  assert.equal(store.pending.length, 1);
  const bad = await app.request('/api/pending', { method: 'POST', headers: { ...auth, Origin: 'http://localhost:1200' }, body: JSON.stringify({ path: 'a.ts', line: 50, body: 'x' }) });
  assert.equal(bad.status, 400);
});

test('submit without a PR is refused', async () => {
  const { app, session } = setup();
  const res = await app.request('/api/submit', {
    method: 'POST',
    headers: { ...host, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Origin: 'http://localhost:1200' },
    body: JSON.stringify({ event: 'COMMENT', body: 'x' }),
  });
  assert.equal(res.status, 409);
});

test('switching the model validates the body and needs a running agent', async () => {
  const { app, session } = setup();
  const put = (body: unknown) =>
    app.request('/api/agent/model', {
      method: 'PUT',
      headers: { ...host, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Origin: 'http://localhost:1200' },
      body: JSON.stringify(body),
    });
  assert.equal((await put({ model: '' })).status, 400);
  assert.equal((await put({ model: 'sonnet' })).status, 409);
});

test('submit posts one review to the PR and clears pending', async () => {
  const { createServer } = await import('node:http');
  let received: { url?: string; body?: Record<string, unknown> } = {};
  const gh = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received = { url: req.url!, body: JSON.parse(data) as Record<string, unknown> };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1' }));
    });
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
  const port = (gh.address() as { port: number }).port;
  const { store, session } = setup();
  store.pr = { number: 7, url: 'u', title: 't', body: '', baseRef: 'main', headRef: 'feat', headSha: 'h', author: 'x', draft: false };
  store.github = { auth: { ready: true, host: 'github.com' }, owner: 'o', repo: 'r' };
  store.addPending({ path: 'a.ts', line: 2, body: 'agent says', author: 'agent' });
  const app = createApp({ store, session, agent: null, github: { token: 't0k', apiBase: `http://127.0.0.1:${port}`, summary: { ready: true, host: 'github.com' } }, authMode: 'claude-code', webRoot: '/x' });
  const res = await app.request('/api/submit', {
    method: 'POST',
    headers: { ...host, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Origin: 'http://localhost:1200' },
    body: JSON.stringify({ event: 'REQUEST_CHANGES', body: 'please fix' }),
  });
  gh.close();
  assert.equal(res.status, 200);
  assert.equal(received.url, '/repos/o/r/pulls/7/reviews');
  assert.equal(received.body?.['event'], 'REQUEST_CHANGES');
  assert.equal(received.body?.['commit_id'], 'h');
  assert.equal((received.body?.['comments'] as unknown[]).length, 1);
  assert.equal(store.pending.length, 0);
  assert.equal(store.phase, 'idle');
  assert.equal(store.lastSubmission?.count, 1);
});

test('change proposals are shown, never applied, and can be staged as a suggestion', async () => {
  const { app, store, session } = setup();
  const headers = { ...host, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Origin: 'http://localhost:1200' };
  assert.throws(() => store.addProposal({ path: 'a.ts', startLine: 5, replacement: 'x', note: '' }), /inside the same diff hunk/);
  const p = store.addProposal({ path: 'a.ts', startLine: 1, endLine: 2, replacement: 'ONE\nTWO', note: 'Uppercase both.' });
  assert.deepEqual(p.original, ['one', 'TWO']);
  assert.deepEqual(store.snapshot().proposals.map((x) => x.id), [p.id]);

  const res = await app.request(`/api/proposals/${p.id}/stage`, { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(store.proposals.length, 0);
  assert.equal(store.pending[0]?.startLine, 1);
  assert.equal(store.pending[0]?.line, 2);
  assert.equal(store.pending[0]?.body, 'Uppercase both.\n\n```suggestion\nONE\nTWO\n```');

  const q = store.addProposal({ path: 'a.ts', startLine: 2, replacement: '', note: 'drop it' });
  assert.equal((await app.request(`/api/proposals/${q.id}`, { method: 'DELETE', headers })).status, 200);
  assert.equal(store.proposals.length, 0);
  assert.equal((await app.request(`/api/proposals/${q.id}`, { method: 'DELETE', headers })).status, 400);
});
