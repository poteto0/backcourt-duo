import type { ReviewStore } from '../store.js';
import { commentRef, formatRef, type ChatMessage } from '../../shared/types.js';
import type { LanguageSetting, LanguageSettings } from '../../shared/language.js';
import { clip, truncate } from '../../shared/text.js';

const label = (l: LanguageSetting) => `${l.name} (${l.tag})`;

/** The language section of the system prompt (specs/sessions/agent-session.md#言語). */
export function languageInstructions({ conversation, review }: LanguageSettings): string {
  const lines = [
    conversation
      ? `- Talk to the human in ${label(conversation)}: overviews, the review plan (set_review_plan summary and notes), explanations, questions.`
      : '- Talk to the human in the language they write in. Until they have written anything, use English.',
    `- Write everything that is posted to GitHub — add_pending_comment / update_pending_comment bodies, propose_change notes (they become suggestion comments) and the recommend_review body — in ${
      review ? label(review) : 'the language of the PR title and body (English if there is no PR or it is unclear)'
    }.`,
  ];
  if (conversation && review && conversation.tag !== review.tag) {
    lines.push(
      `- When you stage a comment or change, also show the exact ${review.name} body in chat so the human can check the translation; add a one-line ${conversation.name} gloss if it helps.`,
      `- When the human asks in ${conversation.name} to stage something, translate it into ${review.name} before staging.`,
    );
  }
  lines.push(
    '- Never translate code identifiers, `@path#L` references, code blocks or suggestion blocks.',
    "- Comments the human wrote are theirs: do not translate or rewrite them unless they ask. If asked to translate one, show the translation first and update it only after they confirm.",
  );
  return `## Language\n${lines.join('\n')}`;
}

export function reviewSystemPrompt(language: LanguageSettings): string {
  return `${REVIEW_SYSTEM_PROMPT}\n\n${languageInstructions(language)}`;
}

const REVIEW_SYSTEM_PROMPT = `
# Role: backcourt-duo review partner

You are pair-reviewing a pull request with a human in a local web UI. The UI shows a GitHub-like diff in the
middle, a file tree on the left (with 👤 human / 🤖 agent presence badges) and this chat on the right.
You run the point (you prepare, set the reading order, walk the files); the human makes the calls.

## Working agreement
- You are READ-ONLY. You can Read/Grep/Glob the repository for context, and use the \`mcp__duo__*\` tools to
  drive the shared review state. Never claim to have changed code.
- Nothing reaches GitHub until the human presses Submit. You only *stage* comments with add_pending_comment.
- Always reference code with the shared format \`@path/to/file.ts#L10-L20\` (new-file line numbers unless you say
  otherwise). The UI turns these into clickable chips, and it is how the human and you stay in sync.
- Before talking about a file, call \`focus\` on it (with the line range you are discussing) so the human's
  screen follows you. Move focus whenever you move on to another region.
- Every human message starts with \`<human_context>\` (where the human is looking) and possibly
  \`<activity_since_last_turn>\` (what they did in the UI). Use it: if they are looking somewhere else, talk about that.
  Do not echo these blocks back.
- Keep turns short and conversational: one file (or one coherent chunk of a big file) per turn, then ask.
  Prefer concrete questions ("Is X intentional? It changes Y for callers in @src/b.ts#L40") over generic ones.
- Stage a comment only after the human agrees, or when it is an unambiguous bug.
  Call add_pending_comment directly; do not write the body in chat — the UI shows it inline, and the chat already
  shows the call with its location. Add at most a short why. Show the body only when the human asks to see it,
  or the Language section says so.
  Comment bodies are written for the PR author: concise, specific, with a suggested fix when you have one.
  Comments must target lines inside the diff hunks (get_file_diff shows R numbers, and L on deleted lines); use side LEFT for deleted lines.
  The L in get_file_diff is an old line number; @path#L… refs always use new-file (R) numbers.
- When a concrete fix would make a point clearer ("it would look like this"), call propose_change: the UI shows
  it as an inline diff under those lines. It changes no file. The human decides whether to stage it as a GitHub
  suggestion or dismiss it — do not stage the same fix again with add_pending_comment, and do not paste the
  replacement in chat.

## Phases
1. preparing — understand the change (get_review_context, get_file_diff, Read/Grep around it), then call
   set_review_plan with a reading order (riskiest/most central first; tests next to what they test; generated
   files and lockfiles last, low priority — get_file_diff only summarizes those; pass force: true only when
   their content matters, e.g. a suspicious dependency change). Then present a 3–6 line overview + where you'd start, and ask to proceed.
2. walkthrough — for each file in plan order: focus → explain what changed and why it matters → raise concerns /
   ask → wait. When the human is satisfied, mark_file_reviewed and move on. Follow the human if they jump elsewhere.
3. wrapup — when all files are reviewed, set_phase('wrapup'), list the pending comments, and call recommend_review
   with a suggested verdict (COMMENT / APPROVE / REQUEST_CHANGES) and an overall review summary. The Submit dialog
   opens with them prefilled. Tell the human your verdict and why in one or two lines; if they disagree, call
   recommend_review again with the revised version.
`.trim();

export function kickoffPrompt(language: LanguageSettings): string {
  const reply = language.conversation ? ` Reply in ${language.conversation.name}.` : '';
  return `Please start preparing the review. Use get_review_context to get the big picture, look at the diffs and surrounding code you need, then register a reading order with set_review_plan. When done, give me a 3–6 line overview of the change, which file you want to start with and why, and ask whether to proceed.${reply}`;
}

/** Wrap a human message with presence + activity (specs/sessions/agent-session.md). */
export function wrapHumanMessage(store: ReviewStore, text: string): string {
  const h = store.presence.human;
  const lines: string[] = ['<human_context>'];
  if (h) {
    lines.push(`viewing: ${formatRef(h)}${h.side === 'LEFT' ? ' (LEFT/old side)' : ''}`);
  } else {
    lines.push('viewing: (overview, no file selected)');
  }
  lines.push(`follow_agent: ${store.followAgent ? 'on' : 'off'}`);
  lines.push(`phase: ${store.phase}; pending comments: ${store.pending.length}; reviewed files: ${store.reviewedCount}/${store.files.length}`);
  lines.push('</human_context>');
  const activity = store.drainActivity();
  if (activity.length) {
    lines.push('<activity_since_last_turn>');
    for (const a of activity) lines.push(`- ${a}`);
    lines.push('</activity_since_last_turn>');
  }
  lines.push('', text);
  return lines.join('\n');
}

const HANDOFF_NEXT_FILES = 3;
/** Human messages (each with the replies that follow) carried over a reset. */
const HANDOFF_EXCHANGES = 5;
/** Character caps for the carried conversation: the latest agent turn (often a list the human answers by number), any other turn, all of it. */
const HANDOFF_LAST_CHARS = 4000;
const HANDOFF_TURN_CHARS = 1200;
const HANDOFF_TOTAL_CHARS = 10_000;
/** Below this much budget an older turn would be a stub, so the carried conversation starts later instead. */
const HANDOFF_MIN_CHARS = 80;

/**
 * The last HANDOFF_EXCHANGES exchanges of the chat log, oldest first, with consecutive rows of one speaker merged
 * into a turn. Tool and system rows are left out; line breaks are kept so numbered lists stay numbered.
 */
export function recentConversation(chat: readonly ChatMessage[]): string[] {
  const turns: Array<{ role: 'human' | 'agent'; parts: string[] }> = [];
  let humans = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i]!;
    const text = m.text.trim();
    if ((m.role !== 'human' && m.role !== 'agent') || !text) continue;
    const head = turns[0];
    if (head?.role === m.role) {
      head.parts.unshift(text);
      continue;
    }
    // Stop once the oldest kept turn is the HANDOFF_EXCHANGES-th human message.
    if (head?.role === 'human' && humans === HANDOFF_EXCHANGES) break;
    if (m.role === 'human') humans++;
    turns.unshift({ role: m.role, parts: [text] });
  }
  const out: string[] = [];
  let left = HANDOFF_TOTAL_CHARS;
  for (let i = turns.length - 1; i >= 0 && left >= HANDOFF_MIN_CHARS; i--) {
    const { role, parts } = turns[i]!;
    const cap = i === turns.length - 1 && role === 'agent' ? HANDOFF_LAST_CHARS : HANDOFF_TURN_CHARS;
    // An agent turn usually ends with what the human answers (a question, a numbered list), so keep its end.
    const text = clip(parts.join('\n\n'), Math.min(cap, left), role === 'agent' ? 'end' : 'start');
    left -= text.length;
    out.unshift(`[${role === 'agent' ? 'you' : 'human'}]\n${text}`);
  }
  return out;
}

/**
 * Opens the first turn after a context reset (specs/sessions/agent-session.md#コンテキストのリセット): a few lines
 * built from the store, which keeps everything the dropped conversation did to the review. Phase and progress are
 * left to the <human_context> that follows.
 */
export function handoffMessage(store: ReviewStore, reason: string): string {
  const done = new Set(store.files.filter((f) => f.reviewState === 'reviewed').map((f) => f.path));
  const next = (store.plan?.files ?? []).filter((f) => !done.has(f.path));
  const at = store.presence.agent;
  const conversation = recentConversation(store.chat);
  const lines = [
    '<handoff>',
    `Your earlier conversation was cleared to save context (${reason}). The shared review state is intact and is the source of truth: use get_review_context / get_file_diff for details instead of redoing work it already reflects.`,
  ];
  if (at) lines.push(`your focus: ${formatRef(at)}`);
  if (next.length) {
    const shown = next.slice(0, HANDOFF_NEXT_FILES).map((f) => `${formatRef(f)} (${f.priority}: ${truncate(f.note, 80)})`);
    lines.push(`next in plan: ${shown.join(', ')}${next.length > HANDOFF_NEXT_FILES ? ` (+${next.length - HANDOFF_NEXT_FILES} more)` : ''}`);
  }
  if (store.pending.length) lines.push(`pending comments: ${store.pending.map((c) => `${c.id} ${formatRef(commentRef(c))}`).join(', ')}`);
  if (store.proposals.length) lines.push(`change proposals: ${store.proposals.map((p) => `${p.id} ${formatRef(p)}`).join(', ')}`);
  if (conversation.length) {
    lines.push(
      '<recent_conversation>',
      'The last exchanges before the reset, from the chat log. The human still sees them and may refer back to them (e.g. "the 2nd point").',
      ...conversation,
      '</recent_conversation>',
    );
  }
  lines.push('</handoff>');
  return lines.join('\n');
}
