import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffMessage } from './prompts.js';
import { ReviewStore } from '../store.js';
import { parseUnifiedDiff } from '../diff.js';

const file = (path: string) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,2 +1,2 @@
 one
-two
+TWO
`;

const PATHS = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

function setup() {
  const target = { base: 'origin/main', baseSha: 'b', head: 'HEAD', headSha: 'h', mergeBaseSha: 'm', uncommitted: false, branch: 'feat', repoRoot: '/r', repoName: 'r' };
  return new ReviewStore(target, parseUnifiedDiff(PATHS.map(file).join('')), null);
}

test('handoff carries the focus, the next files, pending ids and the last agent message', () => {
  const store = setup();
  store.setPlan({ summary: 's', files: PATHS.map((path) => ({ path, priority: 'high' as const, note: `look at ${path}` })) });
  store.setReviewState('a.ts', 'reviewed', 'agent');
  store.setCursor('agent', { path: 'b.ts', startLine: 2 });
  const c = store.addPending({ path: 'a.ts', line: 2, body: 'x', author: 'agent' });
  store.appendChat(store.makeMessage('agent', 'Next up:\n@b.ts'));
  store.appendChat(store.makeMessage('human', 'ok'));

  const text = handoffMessage(store, 'file reviewed');
  assert.match(text, /^<handoff>\n/);
  assert.match(text, /\(file reviewed\)/);
  assert.match(text, /\nyour focus: @b\.ts#L2\n/);
  assert.doesNotMatch(text, /phase:/);
  assert.match(text, /next in plan: @b\.ts \(high: look at b\.ts\), @c\.ts \(high: look at c\.ts\), @d\.ts \(high: look at d\.ts\) \(\+1 more\)/);
  assert.match(text, new RegExp(`pending comments: ${c.id} @a\\.ts#L2`));
  assert.match(text, /your last message: "Next up: @b\.ts"/);
  assert.doesNotMatch(text, /change proposals/);
});

test('handoff omits what the store does not have', () => {
  const text = handoffMessage(setup(), 'phase → walkthrough');
  assert.equal(text.split('\n').length, 3);
});
