// Protocol types shared by the Node server and the SolidJS UI.
// Keep this file free of runtime dependencies (types + tiny pure helpers only).

export type Side = 'LEFT' | 'RIGHT';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old file (absent for additions). */
  oldLine?: number;
  /** Line number in the new file (absent for deletions). */
  newLine?: number;
  text: string;
  /** "\ No newline at end of file" follows this line. */
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string | undefined;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export type ReviewState = 'unvisited' | 'in-progress' | 'reviewed';

export interface FileEntry {
  path: string;
  oldPath?: string | undefined;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  reviewState: ReviewState;
  reviewedBy?: Actor;
}

export type Actor = 'human' | 'agent';

export interface Cursor {
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  side?: Side | undefined;
  note?: string | undefined;
  at: string;
}

export type CursorInput = Omit<Cursor, 'at'>;

export interface Presence {
  human: Cursor | null;
  agent: Cursor | null;
}

export type Priority = 'high' | 'medium' | 'low';

export interface PlanItem {
  path: string;
  priority: Priority;
  note: string;
}

export interface ReviewPlan {
  summary: string;
  files: PlanItem[];
  createdAt: string;
}

export type Phase = 'preparing' | 'walkthrough' | 'wrapup' | 'idle';

export interface PendingComment {
  id: string;
  path: string;
  side: Side;
  line: number;
  startLine?: number | undefined;
  body: string;
  author: Actor;
  editedByHuman?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A code change the agent proposes, shown inline in the diff. It is never applied to the working tree
 * (the agent is read-only); the human can stage it as a GitHub suggestion comment or dismiss it.
 */
export interface ChangeProposal {
  id: string;
  path: string;
  /** New-file (RIGHT) line range the proposal replaces; both ends in one diff hunk. */
  startLine: number;
  endLine: number;
  /** Current text of those lines, captured from the diff when proposed. */
  original: string[];
  /** Proposed lines (empty = delete the range). */
  replacement: string[];
  note: string;
  createdAt: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  author: string;
  draft: boolean;
}

export interface ReviewTarget {
  base: string;
  baseSha: string;
  head: string;
  headSha: string;
  mergeBaseSha: string;
  uncommitted: boolean;
  branch: string | null;
  repoRoot: string;
  repoName: string;
}

export type AgentAuthMode = 'claude-code' | 'api-key';
/** How the Claude account email is shown (`privacy.account`). */
export type AccountDisplay = 'hide' | 'mask' | 'show';

export interface AgentAuthSummary {
  mode: AgentAuthMode;
  ready: boolean;
  method?: string;
  account?: string;
  subscription?: string;
  binary?: string;
  hint?: string;
  warnings: string[];
}

export interface GitHubAuthSummary {
  ready: boolean;
  source?: 'GH_TOKEN' | 'GITHUB_TOKEN' | 'gh';
  host: string;
  login?: string;
  hint?: string;
}

export type AgentStatus = 'disabled' | 'starting' | 'thinking' | 'waiting' | 'error' | 'stopped' | 'signed-out';

export interface AgentInfo {
  status: AgentStatus;
  auth: AgentAuthSummary | null;
  error?: string;
  model?: string;
  /** Models the agent can switch to (from the SDK's `supportedModels()`), once the session is up. */
  models?: ModelOption[];
  loginInProgress: boolean;
}

export interface ModelOption {
  /** What `setModel()` takes, e.g. an alias like `sonnet`. */
  value: string;
  /** The model id the alias resolves to (what the SDK reports after init). */
  resolvedModel?: string | undefined;
  displayName: string;
  description: string;
}

export interface Submission {
  url: string;
  at: string;
  count: number;
  event: ReviewEvent;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface Warning {
  code: string;
  message: string;
}

export interface GitHubContext {
  auth: GitHubAuthSummary | null;
  owner: string | null;
  repo: string | null;
}

export interface ReviewStateSnapshot {
  target: ReviewTarget;
  pr: PullRequestInfo | null;
  files: FileEntry[];
  plan: ReviewPlan | null;
  phase: Phase;
  presence: Presence;
  followAgent: boolean;
  pending: PendingComment[];
  proposals: ChangeProposal[];
  agent: AgentInfo;
  github: GitHubContext;
  lastSubmission: Submission | null;
  warnings: Warning[];
}

// ---------------------------------------------------------------- chat

export type ChatRole = 'human' | 'agent' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Markdown text (agent/human), or a one-line summary (tool/system). */
  text: string;
  at: string;
  /** Agent message still streaming. */
  streaming?: boolean;
  /** For tool rows: a one-line summary, optionally linking to a location. */
  tool?: { summary: string; ref?: Ref | undefined; isError?: boolean };
}

export type ChatEvent =
  | { type: 'append'; message: ChatMessage }
  | { type: 'delta'; id: string; text: string }
  | { type: 'update'; message: ChatMessage };

export interface HelloEvent {
  version: string;
  bootId: string;
}

// ---------------------------------------------------------------- references

/** `@path/to/file.ts#L10-L20` — the shared reference format for humans and the agent. */
export const REF_PATTERN = /@([A-Za-z0-9_][A-Za-z0-9_./\-]*[A-Za-z0-9_])(?:#L(\d+)(?:-L?(\d+))?)?/g;

export interface Ref {
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

/** The location a pending comment covers, as a shared reference. */
export function commentRef(c: Pick<PendingComment, 'path' | 'line' | 'startLine'>): Ref {
  return { path: c.path, startLine: c.startLine ?? c.line, endLine: c.line };
}

export function formatRef(ref: Ref): string {
  if (ref.startLine === undefined) return `@${ref.path}`;
  if (ref.endLine === undefined || ref.endLine === ref.startLine) return `@${ref.path}#L${ref.startLine}`;
  return `@${ref.path}#L${ref.startLine}-L${ref.endLine}`;
}

export function parseRefs(text: string): Array<{ index: number; length: number; ref: Ref }> {
  const out: Array<{ index: number; length: number; ref: Ref }> = [];
  for (const m of text.matchAll(REF_PATTERN)) {
    const path = m[1];
    if (path === undefined || !path.includes('.') && !path.includes('/')) continue;
    const ref: Ref = { path };
    if (m[2] !== undefined) ref.startLine = Number(m[2]);
    if (m[3] !== undefined) ref.endLine = Number(m[3]);
    out.push({ index: m.index, length: m[0].length, ref });
  }
  return out;
}
