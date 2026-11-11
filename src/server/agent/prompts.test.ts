import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffMessage, recentConversation } from './prompts.js';
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
  assert.match(text, /<recent_conversation>\n.*\n\[you\]\nNext up:\n@b\.ts\n\[human\]\nok\n<\/recent_conversation>\n<\/handoff>$/);
  assert.doesNotMatch(text, /change proposals/);
});

test('handoff omits what the store does not have', () => {
  const text = handoffMessage(setup(), 'phase → walkthrough');
  assert.equal(text.split('\n').length, 3);
});

test('recent conversation keeps the last five exchanges, merging rows and skipping tool/system rows', () => {
  const store = setup();
  store.appendChat(store.makeMessage('agent', 'overview'));
  for (let i = 1; i <= 6; i++) {
    store.appendChat(store.makeMessage('human', `q${i}`));
    store.appendChat(store.makeMessage('agent', `a${i}`));
    store.appendChat(store.makeMessage('tool', '', { tool: { summary: 'read' } }));
    store.system('note');
  }
  store.appendChat(store.makeMessage('agent', '気になる点は以下です。\n1. foo\n2. bar'));

  const turns = recentConversation(store.chat);
  assert.deepEqual(turns, [
    '[human]\nq2', '[you]\na2', '[human]\nq3', '[you]\na3', '[human]\nq4', '[you]\na4', '[human]\nq5', '[you]\na5',
    '[human]\nq6', '[you]\na6\n\n気になる点は以下です。\n1. foo\n2. bar',
  ]);
});

test('recent conversation clips long turns, keeping the end of agent turns and more of the latest one', () => {
  const store = setup();
  store.appendChat(store.makeMessage('human', 'x'.repeat(5000)));
  store.appendChat(store.makeMessage('agent', `${'y'.repeat(5000)}\n1. foo`));
  const [human, agent] = recentConversation(store.chat);
  assert.equal(human?.length, '[human]\n'.length + 1200);
  assert.equal(agent?.length, '[you]\n'.length + 4000);
  assert.ok(agent?.startsWith('[you]\n…'));
  assert.ok(agent?.endsWith('\n1. foo'));
});

test('handoff re-injects open notes and leaves resolved ones out', () => {
  const store = setup();
  const kept = store.addNote({ text: '気になる点 1: retry の上限が無い', path: 'a.ts', startLine: 2, author: 'agent' });
  const done = store.addNote({ text: 'tests are skipped on purpose', author: 'human' });
  store.updateNote(done.id, { resolved: true }, 'agent');

  const text = handoffMessage(store, 'file reviewed');
  assert.match(text, new RegExp(`<open_notes>\\n${kept.id} \\(you\\) @a\\.ts#L2: 気になる点 1: retry の上限が無い\\n</open_notes>`));
  assert.doesNotMatch(text, /skipped on purpose/);
});

test('handoff keeps the newest open notes within its budget and counts the rest', () => {
  const store = setup();
  const notes = Array.from({ length: 20 }, (_, i) => store.addNote({ text: `${i} ${'x'.repeat(480)}`, author: 'agent' }));
  const text = handoffMessage(store, 'phase → wrapup');
  assert.match(text, /<open_notes>\n\(\+9 older open notes: see get_review_context\)\n/);
  assert.ok(text.includes(notes.at(-1)!.id));
  assert.ok(!text.includes(`${notes[8]!.id} `));
});
