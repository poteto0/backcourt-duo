// Input schemas shared by the HTTP API (human) and the MCP tools (agent), so both validate the same shapes.
import { z } from 'zod';
import { EFFORT_LEVELS, type AccountDisplay, type EffortLevel, type Phase, type Priority, type ReviewEvent, type ReviewState, type Side } from '../shared/types.js';

export const SideSchema = z.enum(['LEFT', 'RIGHT']) satisfies z.ZodType<Side>;
export const ReviewStateSchema = z.enum(['unvisited', 'in-progress', 'reviewed']) satisfies z.ZodType<ReviewState>;
export const ReviewEventSchema = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']) satisfies z.ZodType<ReviewEvent>;
export const PrioritySchema = z.enum(['high', 'medium', 'low']) satisfies z.ZodType<Priority>;
export const AccountDisplaySchema = z.enum(['hide', 'mask', 'show']) satisfies z.ZodType<AccountDisplay>;
export const EffortSchema = z.enum(EFFORT_LEVELS) satisfies z.ZodType<EffortLevel>;
export const AgentPhaseSchema = z.enum(['walkthrough', 'wrapup']) satisfies z.ZodType<Phase>;

const line = z.number().int().positive();

/** Raw shapes (zod objects' `.shape`) are what the Agent SDK's `tool()` takes. */
export const cursorShape = {
  path: z.string(),
  startLine: line.optional(),
  endLine: line.optional(),
  side: SideSchema.optional().describe('RIGHT = new file line numbers (default), LEFT = old file (deleted lines)'),
};

export const pendingShape = {
  path: z.string(),
  line: line.describe('last line of the range'),
  startLine: line.optional().describe('first line, for multi-line comments'),
  side: SideSchema.optional().describe('RIGHT = new file line numbers (default), LEFT = old file (deleted lines)'),
  body: z.string().min(1).describe('Markdown, written for the PR author'),
};

export const CursorSchema = z.object(cursorShape);
export const PendingCreateSchema = z.object(pendingShape);
