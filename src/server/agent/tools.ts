// MCP tools exposed to the agent (server name "duo") — specs/sessions/agent-session.md
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { renderFileDiffForAgent } from '../diff.js';
import { StoreError, type ReviewStore } from '../store.js';
import { AgentPhaseSchema, cursorShape, pendingShape, PrioritySchema, ReviewEventSchema } from '../schemas.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

async function guard(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StoreError) return fail(err.message);
    return fail(`internal error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const DUO_SERVER = 'duo';

/** `mcp__duo__focus` → `focus`; built-in tools pass through. */
export const shortToolName = (name: string) => name.replace(`mcp__${DUO_SERVER}__`, '');

export function createDuoTools(store: ReviewStore, notify: (text: string) => void) {
  return [
    tool('get_review_context', 'Overview of the review: target refs, PR title/body, changed files (stats, review state, plan notes), pending comments, presence, phase, and the chat / review languages.', {}, async () =>
      guard(() => {
        const notes = new Map(store.plan?.files.map((p) => [p.path, p]) ?? []);
        const { target, pr } = store;
        return ok({
          target: { base: target.base, head: target.head, branch: target.branch, mergeBase: target.mergeBaseSha.slice(0, 12), headSha: target.headSha.slice(0, 12) },
          pr: pr && { number: pr.number, title: pr.title, body: pr.body.slice(0, 6000), author: pr.author, baseRef: pr.baseRef, draft: pr.draft },
          phase: store.phase,
          plan: store.plan && { summary: store.plan.summary },
          files: store.files.map((f) => {
            const note = notes.get(f.path);
            return { path: f.path, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary, reviewState: f.reviewState, priority: note?.priority, note: note?.note };
          }),
          pending: store.pending.map(({ id, path, side, line, startLine, author, body }) => ({ id, path, side, line, startLine, author, body })),
          proposals: store.proposals.map(({ id, path, startLine, endLine, note }) => ({ id, path, startLine, endLine, note })),
          recommendation: store.recommendation,
          language: store.language,
          presence: store.presence,
          warnings: store.warnings.map((w) => w.message),
        });
      }),
    ),

    tool('get_file_diff', 'Diff of one changed file, every line annotated with old (L) and new (R) line numbers. Only these lines can receive comments.', { path: z.string() }, async ({ path }) =>
      guard(() => {
        store.requireFile(path);
        return ok(renderFileDiffForAgent(store.diffByPath.get(path)!));
      }),
    ),

    tool(
      'set_review_plan',
      'Register the reading order for the walkthrough (riskiest/central first). Moves phase from preparing to walkthrough. Files you omit are appended as low priority.',
      {
        summary: z.string().describe('2–6 line overview of what the change does'),
        files: z.array(z.object({ path: z.string(), priority: PrioritySchema, note: z.string().describe('why this file matters / what to look at') })),
      },
      async (input) =>
        guard(() => {
          const plan = store.setPlan(input);
          return ok({ ok: true, phase: store.phase, order: plan.files.map((f) => f.path) });
        }),
    ),

    tool(
      'focus',
      "Move the agent cursor to a file (and optionally a line range). The human's diff view follows when 'follow agent' is on. Call this before discussing any code.",
      { ...cursorShape, note: z.string().optional().describe('short label shown next to the highlight, e.g. "error handling"') },
      async (cursor) =>
        guard(() => {
          store.setCursor('agent', cursor);
          return ok({ ok: true, followAgent: store.followAgent, humanIsOn: store.presence.human?.path ?? null });
        }),
    ),

    tool('get_human_focus', 'Where the human is currently looking (file, selected lines) and whether they follow you.', {}, async () =>
      guard(() => ok({ human: store.presence.human, followAgent: store.followAgent })),
    ),

    tool(
      'add_pending_comment',
      'Stage a review comment (posted to GitHub only when the human submits). line = last line of the range; startLine for multi-line. Must be inside a diff hunk.',
      pendingShape,
      async (input) =>
        guard(() => {
          const c = store.addPending({ ...input, author: 'agent' });
          return ok({ ok: true, id: c.id, pendingCount: store.pending.length });
        }),
    ),

    tool('update_pending_comment', 'Edit the body of a pending comment.', { id: z.string(), body: z.string() }, async ({ id, body }) =>
      guard(() => {
        const c = store.updatePending(id, body, 'agent');
        if (c.author === 'human') notify(`🤖 edited your pending comment ${id}`);
        return ok({ ok: true, id: c.id });
      }),
    ),

    tool('delete_pending_comment', 'Remove a pending comment.', { id: z.string() }, async ({ id }) =>
      guard(() => {
        const c = store.deletePending(id, 'agent');
        if (c.author === 'human') notify(`🤖 deleted your pending comment ${id}`);
        return ok({ ok: true, pendingCount: store.pending.length });
      }),
    ),

    tool(
      'propose_change',
      'Show a concrete code change inline in the diff, under new-file lines startLine..endLine (R numbers, one hunk). It is only displayed — no file is modified. The human can stage it as a GitHub suggestion comment or dismiss it.',
      {
        path: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive().optional().describe('defaults to startLine'),
        replacement: z.string().describe('the full new text for those lines, without diff markers; empty string = delete them'),
        note: z.string().describe('one or two sentences: what the change does and why'),
      },
      async (input) =>
        guard(() => {
          const p = store.addProposal(input);
          return ok({ ok: true, id: p.id, replaces: p.original });
        }),
    ),

    tool('withdraw_proposal', 'Remove a change proposal you made (e.g. superseded by a better one).', { id: z.string() }, async ({ id }) =>
      guard(() => {
        store.removeProposal(id, 'agent');
        return ok({ ok: true });
      }),
    ),

    tool('mark_file_reviewed', 'Mark a file as reviewed (the "Viewed" checkbox) once you and the human are done with it.', { path: z.string() }, async ({ path }) =>
      guard(() => {
        store.setReviewState(path, 'reviewed', 'agent');
        return ok({ ok: true, remaining: store.files.filter((f) => f.reviewState !== 'reviewed').map((f) => f.path) });
      }),
    ),

    tool(
      'recommend_review',
      'At wrap-up, register your suggested verdict and overall review summary. The Submit dialog opens with them prefilled; the human can submit as-is or edit. Calling again replaces the previous recommendation.',
      { event: ReviewEventSchema, body: z.string().min(1).describe('overall review summary (Markdown), written for the PR author') },
      async (input) =>
        guard(() => {
          store.setRecommendation(input);
          return ok({ ok: true, event: input.event });
        }),
    ),

    tool('set_phase', 'Declare the review phase. Use wrapup once every file is reviewed.', { phase: AgentPhaseSchema }, async ({ phase }) =>
      guard(() => {
        store.setPhase(phase);
        return ok({ ok: true, phase });
      }),
    ),
  ];
}

export function createDuoServer(tools: ReturnType<typeof createDuoTools>) {
  return createSdkMcpServer({
    name: DUO_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    instructions: 'Tools that read and drive the shared backcourt-duo review state (diff, presence, plan, pending comments, change proposals).',
    tools,
  });
}
