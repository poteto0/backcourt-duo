import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCommentable, isCommentableRange, parseUnifiedDiff, renderFileDiffForAgent, skippedKind } from './diff.js';
import { parseRemoteUrl } from './git.js';
import { buildReviewPayload, AGENT_FOOTER } from './github.js';
import { parseRefs, formatRef } from '../shared/types.js';
import { ReviewStore } from './store.js';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ export function a() {
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;

 export {};
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
index 3333333..4444444 100644
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-hello
\\ No newline at end of file
+hello world
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/img.png differ
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 6666666..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`;

test('parses files, statuses and line numbers', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary]),
    [
      ['src/a.ts', 'modified', 2, 1, false],
      ['new.txt', 'renamed', 1, 1, false],
      ['img.png', 'added', 0, 0, true],
      ['gone.ts', 'deleted', 0, 2, false],
    ],
  );
  const a = files[0]!;
  assert.equal(a.hunks[0]!.section, 'export function a() {');
  const lines = a.hunks[0]!.lines;
  assert.deepEqual(lines.map((l) => [l.kind, l.oldLine, l.newLine]), [
    ['context', 1, 1],
    ['del', 2, undefined],
    ['add', undefined, 2],
    ['add', undefined, 3],
    ['context', 3, 4],
    ['context', 4, 5],
  ]);
  assert.equal(files[1]!.oldPath, 'old.txt');
  assert.equal(files[1]!.hunks[0]!.lines[0]!.noNewline, true);
});

test('commentable lines follow GitHub rules', () => {
  const a = parseUnifiedDiff(SAMPLE)[0]!;
  assert.equal(isCommentable(a, 'RIGHT', 2), true);
  assert.equal(isCommentable(a, 'RIGHT', 5), true); // context
  assert.equal(isCommentable(a, 'RIGHT', 99), false);
  assert.equal(isCommentable(a, 'LEFT', 2), true); // deleted line
  assert.equal(isCommentable(a, 'LEFT', 9), false);
  assert.equal(isCommentableRange(a, 'RIGHT', 2, 4), true);
  assert.equal(isCommentableRange(a, 'RIGHT', 2, 40), false);
});

test('agent rendering puts one line number in the gutter', () => {
  const lines = renderFileDiffForAgent(parseUnifiedDiff(SAMPLE)[0]!).split('\n');
  assert.deepEqual(lines.slice(2), [
    '@@ -1,4 +1,5 @@ export function a() {',
    'R1  const x = 1;',
    'L2 -const y = 2;',
    'R2 +const y = 3;',
    'R3 +const z = 4;',
    'R4  ',
    'R5  export {};',
  ]);
});

/** A diff with `hunks` hunks of `size` added lines each. */
function bigDiff(hunks: number, size: number): string {
  let text = 'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n';
  for (let h = 0; h < hunks; h++) {
    const start = h * 1000 + 1;
    text += `@@ -${start},0 +${start},${size} @@\n`;
    for (let i = 0; i < size; i++) text += `+line ${h}.${i}\n`;
  }
  return text;
}

test('agent rendering pages long diffs by diff line, across and inside hunks', () => {
  const file = parseUnifiedDiff(bigDiff(2, 400))[0]!;
  const first = renderFileDiffForAgent(file);
  assert.match(first, /R1200 \+line 1\.199\n… truncated: 200 more lines\. Call get_file_diff with offset=600 to continue\.$/);

  const rest = renderFileDiffForAgent(file, { offset: 600 }).split('\n');
  assert.deepEqual(rest.slice(1, 4), ['# from diff line 600', '@@ -1001,0 +1001,400 @@', 'R1201 +line 1.200']);
  assert.equal(rest.at(-1), 'R1400 +line 1.399');
});

test('agent rendering clips very long lines', () => {
  const file = parseUnifiedDiff(`diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -0,0 +1 @@\n+${'x'.repeat(1000)}\n`)[0]!;
  const line = renderFileDiffForAgent(file).split('\n').at(-1)!;
  assert.equal(line, `R1 +${'x'.repeat(300)}… [+700 chars]`);
});

test('classifies lockfiles and generated files', () => {
  assert.equal(skippedKind('pnpm-lock.yaml'), 'lockfile');
  assert.equal(skippedKind('crates/x/Cargo.lock'), 'lockfile');
  for (const p of ['dist/server/cli.js', 'packages/a/build/x.js', 'vendor/lib.go', 'app.min.js', 'a.min.css', 'a.js.map', 'src/__snapshots__/a.test.ts.snap']) {
    assert.equal(skippedKind(p), 'generated', p);
  }
  for (const p of ['src/server/diff.ts', 'distill.ts', 'src/build.ts', 'map.ts']) assert.equal(skippedKind(p), undefined, p);
});

test('agent rendering skips lockfiles unless forced', () => {
  const file = parseUnifiedDiff(bigDiff(2, 700).replaceAll('big.ts', 'pnpm-lock.yaml'))[0]!;
  assert.equal(
    renderFileDiffForAgent(file),
    '# pnpm-lock.yaml (modified, +1400 -0)\n(skipped: lockfile — 1,400 changed lines. Pass force: true to read it.)',
  );
  assert.match(renderFileDiffForAgent(file, { force: true }), /R1 \+line 0\.0\n/);
});

test('parses remotes', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:poteto0/backcourt-duo.git'), { host: 'github.com', owner: 'poteto0', repo: 'backcourt-duo' });
  assert.deepEqual(parseRemoteUrl('https://github.example.com/org/repo'), { host: 'github.example.com', owner: 'org', repo: 'repo' });
  assert.deepEqual(parseRemoteUrl('ssh://git@github.com/o/r.git'), { host: 'github.com', owner: 'o', repo: 'r' });
  assert.equal(parseRemoteUrl('/local/path'), null);
});

test('refs round-trip', () => {
  const refs = parseRefs('see @src/a.ts#L10-L20, and @README.md. Also @b/c.ts#L3 and email@x');
  assert.deepEqual(refs.map((r) => r.ref), [
    { path: 'src/a.ts', startLine: 10, endLine: 20 },
    { path: 'README.md' },
    { path: 'b/c.ts', startLine: 3 },
  ]);
  assert.equal(formatRef({ path: 'a.ts', startLine: 1, endLine: 4 }), '@a.ts#L1-L4');
  assert.equal(formatRef({ path: 'a.ts', startLine: 4, endLine: 4 }), '@a.ts#L4');
});

test('review payload maps multi-line comments and footers', () => {
  const p = buildReviewPayload({
    event: 'COMMENT',
    body: 'ok',
    commitId: 'abc',
    comments: [
      { id: '1', path: 'a.ts', side: 'RIGHT', line: 4, startLine: 2, body: 'x', author: 'agent', createdAt: '', updatedAt: '' },
      { id: '2', path: 'a.ts', side: 'LEFT', line: 2, body: 'y', author: 'human', createdAt: '', updatedAt: '' },
    ],
  });
  assert.deepEqual(p.comments, [
    { path: 'a.ts', line: 4, side: 'RIGHT', start_line: 2, start_side: 'RIGHT', body: `x${AGENT_FOOTER}` },
    { path: 'a.ts', line: 2, side: 'LEFT', body: 'y' },
  ]);
});

test('store validates pending locations and tracks presence/activity', () => {
  const diff = parseUnifiedDiff(SAMPLE);
  const target = { base: 'origin/main', baseSha: 'b', head: 'HEAD', headSha: 'h', mergeBaseSha: 'm', uncommitted: false, branch: 'feat', repoRoot: '/r', repoName: 'r' };
  const store = new ReviewStore(target, diff, null);
  assert.throws(() => store.addPending({ path: 'src/a.ts', line: 99, body: 'x', author: 'human' }), /not inside a diff hunk/);
  assert.throws(() => store.addPending({ path: 'img.png', line: 1, body: 'x', author: 'human' }), /binary/);
  const c = store.addPending({ path: 'src/a.ts', line: 3, startLine: 2, body: 'nice', author: 'human' });
  assert.equal(c.startLine, 2);
  store.setCursor('agent', { path: 'src/a.ts', startLine: 2, endLine: 3 });
  assert.equal(store.files[0]!.reviewState, 'in-progress');
  store.setCursor('human', { path: 'new.txt' });
  const activity = store.drainActivity();
  assert.equal(activity.length, 2);
  assert.match(activity[0]!, /added pending comment .* @src\/a.ts#L2-L3/);
  assert.match(activity[1]!, /opened @new.txt/);
  assert.equal(store.drainActivity().length, 0);
  assert.throws(() => store.setPlan({ summary: 's', files: [{ path: 'nope', priority: 'high', note: '' }] }), /unknown paths/);
  const plan = store.setPlan({ summary: 's', files: [{ path: 'gone.ts', priority: 'high', note: 'n' }] });
  assert.equal(plan.files.length, 4);
  assert.equal(store.phase, 'walkthrough');
});
