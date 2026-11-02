import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalLanguageTag, describeLanguage, languageName, looksLikeOtherLanguage, type LanguageSettings } from '../shared/language.js';
import { loadConfig, loadLanguage, resolveLanguage } from './config.js';
import { languageInstructions, kickoffPrompt, wrapHumanMessage } from './agent/prompts.js';
import { ReviewStore } from './store.js';
import type { ReviewTarget } from '../shared/types.js';

const empty = { value: {}, warnings: [] };
const cfg = (language: { conversation?: string; review?: string }) => ({ value: { language }, warnings: [] });

test('canonicalLanguageTag / languageName', () => {
  assert.equal(canonicalLanguageTag('zh-hans'), 'zh-Hans');
  assert.equal(canonicalLanguageTag(' ja '), 'ja');
  assert.equal(canonicalLanguageTag('not a tag'), null);
  assert.equal(languageName('ja'), 'Japanese');
  assert.equal(languageName('en'), 'English');
});

test('loadConfig: language as a string or an object; an invalid tag ignores the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bcd-lang-'));
  const p = join(dir, 'config.json');
  await writeFile(p, JSON.stringify({ language: { conversation: 'ja', review: 'EN' } }));
  assert.deepEqual(loadConfig(p).value, { language: { conversation: 'ja', review: 'en' } });
  await writeFile(p, JSON.stringify({ language: 'zh-hans' }));
  assert.deepEqual(loadConfig(p).value, { language: { conversation: 'zh-Hans', review: 'zh-Hans' } });
  await writeFile(p, JSON.stringify({ language: { review: 'english please' } }));
  assert.deepEqual(loadConfig(p).value, {});
  assert.match(loadConfig(p).warnings[0] ?? '', /BCP 47/);
});

test('resolveLanguage: a string applies to both; unset review follows chat; nothing set stays null', () => {
  const both = resolveLanguage({}, {}, empty, cfg({ conversation: 'ja', review: 'ja' })).value;
  assert.equal(both.conversation?.tag, 'ja');
  assert.equal(both.conversation?.name, 'Japanese');
  assert.deepEqual([both.review?.tag, both.review?.source], ['ja', 'config']);
  const chatOnly = resolveLanguage({}, {}, empty, cfg({ conversation: 'ja' })).value;
  assert.deepEqual([chatOnly.review?.tag, chatOnly.review?.source], ['ja', 'chat']);
  assert.deepEqual(resolveLanguage({}, {}, empty, empty).value, { conversation: null, review: null });
});

test('resolveLanguage: CLI > env > repository config > user config, specific beats --lang', () => {
  const user = cfg({ conversation: 'ja', review: 'ja' });
  const repo = cfg({ conversation: 'fr', review: 'en' });
  const src = (s: LanguageSettings) => [s.conversation && `${s.conversation.tag}:${s.conversation.source}`, s.review && `${s.review.tag}:${s.review.source}`];
  // The repository decides review only.
  assert.deepEqual(src(resolveLanguage({}, {}, repo, user).value), ['ja:config', 'en:.backcourt-duo.json']);
  assert.deepEqual(src(resolveLanguage({}, { BACKCOURT_DUO_LANG: 'de' }, repo, user).value), ['de:BACKCOURT_DUO_LANG', 'de:BACKCOURT_DUO_LANG']);
  assert.deepEqual(src(resolveLanguage({}, { BACKCOURT_DUO_LANG: 'de', BACKCOURT_DUO_REVIEW_LANG: 'ko' }, repo, user).value), ['de:BACKCOURT_DUO_LANG', 'ko:BACKCOURT_DUO_REVIEW_LANG']);
  assert.deepEqual(src(resolveLanguage({ lang: 'es' }, { BACKCOURT_DUO_REVIEW_LANG: 'ko' }, repo, user).value), ['es:--lang', 'es:--lang']);
  assert.deepEqual(src(resolveLanguage({ lang: 'es', reviewLang: 'en' }, {}, repo, user).value), ['es:--lang', 'en:--review-lang']);
  const bad = resolveLanguage({}, { BACKCOURT_DUO_LANG: '??' }, empty, user);
  assert.equal(bad.value.conversation?.source, 'config');
  assert.match(bad.warnings[0] ?? '', /BACKCOURT_DUO_LANG/);
  assert.equal(describeLanguage(resolveLanguage({ reviewLang: 'en' }, {}, empty, user).value), 'chat ja (config) · review en (--review-lang)');
  assert.equal(describeLanguage({ conversation: null, review: null }), 'chat auto (follows you) · review auto (PR language)');
});

test('looksLikeOtherLanguage: judged by script, ignoring code and references', () => {
  assert.equal(looksLikeOtherLanguage('この関数は null を返すことがあります', 'en'), true);
  assert.equal(looksLikeOtherLanguage('This can return null when the list is empty.', 'en'), false);
  assert.equal(looksLikeOtherLanguage('Use `日本語` here, see @src/a.ts#L3', 'en'), false);
  assert.equal(looksLikeOtherLanguage('`handleSubmit` が null を返すことがあります', 'ja'), false);
  assert.equal(looksLikeOtherLanguage('This can return null when the list is empty.', 'ja'), true);
  assert.equal(looksLikeOtherLanguage('LGTM', 'ja'), false);
  assert.equal(looksLikeOtherLanguage('这个函数可能返回空值', 'ja'), false); // Han only: can't tell
  assert.equal(looksLikeOtherLanguage('この関数は空を返す', 'zh-Hans'), true);
  assert.equal(looksLikeOtherLanguage('Это может вернуть null', 'en'), true);
});

const target: ReviewTarget = { base: 'main', baseSha: 'a'.repeat(40), head: 'HEAD', headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), uncommitted: false, branch: 'feat', repoRoot: '/r', repoName: 'r' };
const ja = { tag: 'ja', name: 'Japanese', source: 'config' };
const en = { tag: 'en', name: 'English', source: 'config' };

test('prompts: chat and review languages are stated separately', () => {
  const split = languageInstructions({ conversation: ja, review: en });
  assert.match(split, /Talk to the human in Japanese \(ja\)/);
  assert.match(split, /posted to GitHub.*in English \(en\)/);
  assert.match(split, /translate it into English before staging/);
  const unset = languageInstructions({ conversation: null, review: null });
  assert.match(unset, /language they write in.*use English/);
  assert.match(unset, /language of the PR title and body/);
  assert.match(kickoffPrompt({ conversation: ja, review: en }), /Reply in Japanese\.$/);
  assert.doesNotMatch(kickoffPrompt({ conversation: null, review: null }), /Reply in/);
});

test('a resumed conversation started with other languages is told once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bcd-resume-'));
  const path = join(dir, 'state.json');
  const first = new ReviewStore(target, [], path, { conversation: ja, review: ja });
  first.setAgentSessionId('s1');
  await first.flush();

  const same = new ReviewStore(target, [], path, { conversation: ja, review: ja });
  await same.load();
  assert.doesNotMatch(wrapHumanMessage(same, 'hi'), /language settings changed/);

  const next = new ReviewStore(target, [], path, { conversation: ja, review: en });
  await next.load();
  assert.match(wrapHumanMessage(next, 'hi'), /language settings changed.*review en/);
  assert.doesNotMatch(wrapHumanMessage(next, 'again'), /language settings changed/);
});

test('the repository config only pins language.review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bcd-repo-'));
  await writeFile(join(dir, '.backcourt-duo.json'), JSON.stringify({ language: { review: 'en' } }));
  const prev = { ...process.env };
  for (const k of ['BACKCOURT_DUO_LANG', 'BACKCOURT_DUO_CHAT_LANG', 'BACKCOURT_DUO_REVIEW_LANG']) delete process.env[k];
  try {
    assert.deepEqual(loadLanguage({ chatLang: 'ja' }, dir).value.review, { tag: 'en', name: 'English', source: '.backcourt-duo.json' });
    await writeFile(join(dir, '.backcourt-duo.json'), JSON.stringify({ language: { conversation: 'fr' } }));
    assert.match(loadLanguage({}, dir).warnings[0] ?? '', /ignoring/);
  } finally {
    Object.assign(process.env, prev);
  }
});
