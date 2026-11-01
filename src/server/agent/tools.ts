// MCP tools exposed to the agent (server name "duo") — specs/sessions/agent-session.md
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { renderFileDiffForAgent } from '../diff.js';
import { StoreError, type ReviewStore } from '../store.js';
import type { Side } from '../../shared/types.js';

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

const sideSchema = z.enum(['LEFT', 'RIGHT']).optional().describe('RIGHT = new file line numbers (default), LEFT = old file (deleted lines)');

export const DUO_TOOL_NAMES = [
  'get_review_context',
  'get_file_diff',
  'set_review_plan',
  'focus',
  'get_human_focus',
  'add_pending_comment',
  'update_pending_comment',
  'delete_pending_comment',
  'mark_file_reviewed',
  'set_phase',
] as const;

export function createDuoServer(store: ReviewStore, notify: (text: string) => void) {
  return createSdkMcpServer({
    name: 'duo',
    version: '1.0.0',
    alwaysLoad: true,
    instructions: 'Tools that read and drive the shared backcourt-duo review state (diff, presence, plan, pending comments).',
    tools: [
      tool('get_review_context', 'Overview of the review: target refs, PR title/body, changed files (stats, review state, plan notes), pending comments, presence and phase.', {}, async () =>
        guard(() => {
          const notes = new Map(store.plan?.files.map((p) => [p.path, p]) ?? []);
          return ok({
            target: { base: store.target.base, head: store.target.head, branch: store.target.branch, mergeBase: store.target.mergeBaseSha.slice(0, 12), headSha: store.target.headSha.slice(0, 12) },
            pr: store.pr ? { number: store.pr.number, title: store.pr.title, body: store.pr.body.slice(0, 6000), author: store.pr.author, baseRef: store.pr.baseRef, draft: store.pr.draft } : null,
            phase: store.phase,
            plan: store.plan ? { summary: store.plan.summary } : null,
            files: store.files.map((f) => ({
              path: f.path,
              ...(f.oldPath ? { oldPath: f.oldPath } : {}),
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              binary: f.binary,
              reviewState: f.reviewState,
              ...(notes.get(f.path) ? { priority: notes.get(f.path)!.priority, note: notes.get(f.path)!.note } : {}),
            })),
            pending: store.pending.map((c) => ({ id: c.id, path: c.path, side: c.side, line: c.line, startLine: c.startLine, author: c.author, body: c.body })),
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
          files: z.array(z.object({ path: z.string(), priority: z.enum(['high', 'medium', 'low']), note: z.string().describe('why this file matters / what to look at') })),
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
        {
          path: z.string(),
          startLine: z.number().int().positive().optional(),
          endLine: z.number().int().positive().optional(),
          side: sideSchema,
          note: z.string().optional().describe('short label shown next to the highlight, e.g. "error handling"'),
        },
        async ({ path, startLine, endLine, side, note }) =>
          guard(() => {
            store.setCursor('agent', {
              path,
              ...(startLine !== undefined ? { startLine } : {}),
              ...(endLine !== undefined ? { endLine } : startLine !== undefined ? { endLine: startLine } : {}),
              ...(side ? { side } : {}),
              ...(note ? { note } : {}),
            });
            const human = store.presence.human;
            return ok({ ok: true, followAgent: store.followAgent, humanIsOn: human ? human.path : null });
          }),
      ),

      tool('get_human_focus', 'Where the human is currently looking (file, selected lines) and whether they follow you.', {}, async () =>
        guard(() => ok({ human: store.presence.human, followAgent: store.followAgent })),
      ),

      tool(
        'add_pending_comment',
        'Stage a review comment (posted to GitHub only when the human submits). line = last line of the range; startLine for multi-line. Must be inside a diff hunk.',
        {
          path: z.string(),
          line: z.number().int().positive(),
          startLine: z.number().int().positive().optional(),
          side: sideSchema,
          body: z.string().describe('Markdown, written for the PR author'),
        },
        async ({ path, line, startLine, side, body }) =>
          guard(() => {
            const c = store.addPending({ path, line, body, author: 'agent', ...(startLine !== undefined ? { startLine } : {}), ...(side ? { side: side as Side } : {}) });
            return ok({ ok: true, id: c.id, pendingCount: store.pending.length });
          }),
      ),

      tool('update_pending_comment', 'Edit the body of a pending comment.', { id: z.string(), body: z.string() }, async ({ id, body }) =>
        guard(() => {
          const before = store.pending.find((c) => c.id === id);
          const c = store.updatePending(id, body, 'agent');
          if (before?.author === 'human') notify(`🤖 edited your pending comment ${id}`);
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

      tool('mark_file_reviewed', 'Mark a file as reviewed (the "Viewed" checkbox) once you and the human are done with it.', { path: z.string() }, async ({ path }) =>
        guard(() => {
          store.setReviewState(path, 'reviewed', 'agent');
          const left = store.files.filter((f) => f.reviewState !== 'reviewed').map((f) => f.path);
          return ok({ ok: true, remaining: left });
        }),
      ),

      tool('set_phase', 'Declare the review phase. Use wrapup once every file is reviewed.', { phase: z.enum(['walkthrough', 'wrapup']) }, async ({ phase }) =>
        guard(() => {
          store.setPhase(phase);
          return ok({ ok: true, phase });
        }),
      ),
    ],
  });
}
