import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewContext } from './tools.js';
import { ReviewStore } from '../store.js';
import { parseUnifiedDiff } from '../diff.js';

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
  const store = new ReviewStore(target, parseUnifiedDiff(DIFF), null, { conversation: { tag: 'ja', name: 'Japanese', source: 'config' }, review: null });
  store.pr = { number: 7, url: 'u', title: 'T', body: 'x'.repeat(5000), baseRef: 'main', headRef: 'feat', headSha: 'h', author: 'me', draft: false };
  store.addPending({ path: 'a.ts', line: 2, body: 'secret body', author: 'human' });
  return store;
}

test('get_review_context is lean by default', () => {
  const ctx = reviewContext(setup()) as any;
  assert.equal(ctx.pr.body.length, 1500);
  assert.equal(ctx.pr.draft, undefined);
  assert.equal(ctx.pending[0].body, undefined);
  assert.equal(ctx.pending[0].path, 'a.ts');
  assert.ok(!('language' in ctx));
  assert.ok(!('warnings' in ctx));
  assert.ok(!('proposals' in ctx));
  assert.ok(!('plan' in ctx));
  assert.deepEqual(Object.keys(ctx.files[0]).sort(), ['additions', 'deletions', 'path', 'reviewState', 'status']);
});

test('includeBodies and detail full add the omitted fields', () => {
  const store = setup();
  assert.equal((reviewContext(store, { includeBodies: true }) as any).pending[0].body, 'secret body');
  const full = reviewContext(store, { detail: 'full' }) as any;
  assert.equal(full.pr.body.length, 5000);
  assert.equal(full.pending[0].body, 'secret body');
  assert.deepEqual(full.language, { conversation: { tag: 'ja', name: 'Japanese', source: 'config' } });
});

test('plan notes live on the plan, not on files', () => {
  const store = setup();
  store.setPlan({ summary: 's', files: [{ path: 'a.ts', priority: 'high', note: 'look here' }] });
  const ctx = reviewContext(store) as any;
  assert.deepEqual(ctx.plan, { summary: 's', files: [{ path: 'a.ts', priority: 'high', note: 'look here' }] });
  assert.equal(ctx.files[0].note, undefined);
});

test('nested nulls are pruned and the recommendation body needs includeBodies', () => {
  const store = setup();
  store.setRecommendation({ event: 'COMMENT', body: 'summary' });
  const ctx = reviewContext(store) as any;
  assert.ok(!('presence' in ctx));
  assert.deepEqual(ctx.recommendation, { event: 'COMMENT' });
  assert.equal((reviewContext(store, { includeBodies: true }) as any).recommendation.body, 'summary');
});
