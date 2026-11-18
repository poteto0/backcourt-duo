import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from './diff.js';
import { ReviewStore } from './store.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
`;

const target = { base: 'origin/main', baseSha: 'b', head: 'HEAD', headSha: 'h', mergeBaseSha: 'm', uncommitted: false, branch: 'feat', repoRoot: '/r', repoName: 'r' };

test('agent session ids are scoped to the backend that created them (#48)', () => {
  const store = new ReviewStore(target, parseUnifiedDiff(DIFF), null);
  assert.equal(store.resumeIdFor('claude'), null);
  assert.equal(store.resumeIdFor('opencode'), null);

  store.setAgentSessionId('11111111-1111-1111-1111-111111111111', 'claude');
  assert.equal(store.resumeIdFor('claude'), '11111111-1111-1111-1111-111111111111');
  assert.equal(store.resumeIdFor('opencode'), null);

  store.setAgentSessionId('ses_abc', 'opencode');
  assert.equal(store.resumeIdFor('opencode'), 'ses_abc');
  assert.equal(store.resumeIdFor('claude'), null);

  store.setAgentSessionId(null, 'opencode');
  assert.equal(store.resumeIdFor('opencode'), null);
  assert.equal(store.resumeIdFor('claude'), null);
});

test('setAgentSessionId defaults to the Claude backend (state written before #48)', () => {
  const store = new ReviewStore(target, parseUnifiedDiff(DIFF), null);
  store.setAgentSessionId('legacy-id');
  assert.equal(store.resumeIdFor('claude'), 'legacy-id');
  assert.equal(store.resumeIdFor('opencode'), null);
});
