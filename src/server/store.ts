// ReviewStore — the single source of truth (specs/architecture.md).
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCommentable, isCommentableRange } from './diff.js';
import type {
  Actor,
  AgentInfo,
  ChatEvent,
  ChatMessage,
  Cursor,
  DiffFile,
  FileEntry,
  GitHubAuthSummary,
  PendingComment,
  Phase,
  PullRequestInfo,
  ReviewPlan,
  ReviewState,
  ReviewStateSnapshot,
  ReviewTarget,
  Side,
  Submission,
  Warning,
} from '../shared/types.js';
import { formatRef } from '../shared/types.js';

interface Persisted {
  version: 1;
  headSha: string;
  mergeBaseSha: string;
  pending: PendingComment[];
  reviewStates: Record<string, { state: ReviewState; by?: Actor }>;
  plan: ReviewPlan | null;
  phase: Phase;
  chat: ChatMessage[];
  agentSessionId: string | null;
  lastSubmission: Submission | null;
}

export class StoreError extends Error {}

const now = () => new Date().toISOString();

export class ReviewStore extends EventEmitter<{ state: [ReviewStateSnapshot]; chat: [ChatEvent] }> {
  readonly diffByPath = new Map<string, DiffFile>();
  files: FileEntry[];
  pr: PullRequestInfo | null = null;
  plan: ReviewPlan | null = null;
  phase: Phase = 'preparing';
  presence: { human: Cursor | null; agent: Cursor | null } = { human: null, agent: null };
  followAgent = true;
  pending: PendingComment[] = [];
  agent: AgentInfo = { status: 'starting', auth: null, loginInProgress: false };
  github: { auth: GitHubAuthSummary | null; owner: string | null; repo: string | null } = { auth: null, owner: null, repo: null };
  lastSubmission: Submission | null = null;
  chat: ChatMessage[] = [];
  agentSessionId: string | null = null;
  /** Human actions since the agent's last turn (specs/sessions/agent-session.md). */
  private activity: string[] = [];
  private emitTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(
    readonly target: ReviewTarget,
    readonly diff: DiffFile[],
    private readonly statePath: string | null,
  ) {
    super();
    for (const f of diff) this.diffByPath.set(f.path, f);
    this.files = diff.map((f) => {
      const e: FileEntry = { path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary, reviewState: 'unvisited' };
      if (f.oldPath) e.oldPath = f.oldPath;
      return e;
    });
  }

  static statePathFor(gitDir: string, branch: string | null, headSha: string): string {
    const name = (branch ?? `detached-${headSha.slice(0, 12)}`).replace(/[^\w.-]+/g, '_');
    return join(gitDir, 'backcourt-duo', `${name}.json`);
  }

  // ------------------------------------------------------------ snapshot / events

  get warnings(): Warning[] {
    const w: Warning[] = [];
    if (this.pr) {
      if (this.pr.headSha !== this.target.headSha) {
        w.push({ code: 'head-mismatch', message: `PR #${this.pr.number} head is ${this.pr.headSha.slice(0, 7)} but local head is ${this.target.headSha.slice(0, 7)} — push your branch, or comments may land on the wrong lines.` });
      }
      const base = this.target.base.replace(/^origin\//, '');
      if (this.pr.baseRef !== base) {
        w.push({ code: 'base-mismatch', message: `PR #${this.pr.number} targets ${this.pr.baseRef}, but this diff is against ${this.target.base}. Restart with --base origin/${this.pr.baseRef} to match GitHub.` });
      }
    } else if (this.github.auth?.ready) {
      w.push({ code: 'no-pr', message: 'No open pull request found for this branch — Submit is disabled. Create one (gh pr create) or pass --pr <number>.' });
    }
    if (this.target.uncommitted) w.push({ code: 'uncommitted', message: 'Including uncommitted changes: comments on those lines cannot be posted.' });
    return w;
  }

  snapshot(): ReviewStateSnapshot {
    return {
      target: this.target,
      pr: this.pr,
      files: this.files,
      plan: this.plan,
      phase: this.phase,
      presence: this.presence,
      followAgent: this.followAgent,
      pending: this.pending,
      agent: this.agent,
      github: this.github,
      lastSubmission: this.lastSubmission,
      warnings: this.warnings,
    };
  }

  /** Coalesce state broadcasts (presence updates can be chatty). */
  changed(opts: { persist?: boolean } = {}): void {
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emit('state', this.snapshot());
      }, 30);
    }
    if (opts.persist !== false) this.scheduleSave();
  }

  // ------------------------------------------------------------ persistence

  async load(): Promise<boolean> {
    if (!this.statePath) return false;
    let data: Persisted;
    try {
      data = JSON.parse(await readFile(this.statePath, 'utf8')) as Persisted;
    } catch {
      return false;
    }
    if (data.version !== 1) return false;
    // Pending comments survive only if their lines still exist in this diff.
    this.pending = data.pending.filter((c) => this.validateLocation(c.path, c.side, c.line, c.startLine) === null);
    for (const f of this.files) {
      const rs = data.reviewStates[f.path];
      if (rs) {
        f.reviewState = rs.state;
        if (rs.by) f.reviewedBy = rs.by;
      }
    }
    this.plan = data.plan;
    this.phase = data.phase;
    this.chat = data.chat.map((m) => (m.streaming ? { ...m, streaming: false } : m));
    this.lastSubmission = data.lastSubmission;
    // Only resume the agent conversation if the code under review is unchanged.
    this.agentSessionId = data.headSha === this.target.headSha && data.mergeBaseSha === this.target.mergeBaseSha ? data.agentSessionId : null;
    if (!this.agentSessionId && this.chat.length) {
      this.chat.push(this.makeMessage('system', 'The branch changed since the last session; the agent starts a fresh conversation (pending comments were kept where lines still match).'));
    }
    return true;
  }

  private scheduleSave(): void {
    if (!this.statePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
  }

  async save(): Promise<void> {
    if (!this.statePath) return;
    const data: Persisted = {
      version: 1,
      headSha: this.target.headSha,
      mergeBaseSha: this.target.mergeBaseSha,
      pending: this.pending,
      reviewStates: Object.fromEntries(
        this.files.filter((f) => f.reviewState !== 'unvisited').map((f) => [f.path, f.reviewedBy ? { state: f.reviewState, by: f.reviewedBy } : { state: f.reviewState }]),
      ),
      plan: this.plan,
      phase: this.phase,
      chat: this.chat.slice(-500),
      agentSessionId: this.agentSessionId,
      lastSubmission: this.lastSubmission,
    };
    const dir = join(this.statePath, '..');
    await mkdir(dir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.statePath);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }

  // ------------------------------------------------------------ activity log for the agent

  logActivity(line: string): void {
    this.activity.push(line);
    if (this.activity.length > 50) this.activity.splice(0, this.activity.length - 50);
  }

  drainActivity(): string[] {
    const a = this.activity;
    this.activity = [];
    return a;
  }

  // ------------------------------------------------------------ files / presence

  requireFile(path: string): FileEntry {
    const f = this.files.find((x) => x.path === path);
    if (!f) throw new StoreError(`"${path}" is not part of this diff. Changed files: ${this.files.map((x) => x.path).join(', ')}`);
    return f;
  }

  setReviewState(path: string, state: ReviewState, by: Actor): void {
    const f = this.requireFile(path);
    if (f.reviewState === state) return;
    f.reviewState = state;
    if (state === 'reviewed') f.reviewedBy = by;
    else delete f.reviewedBy;
    if (by === 'human') this.logActivity(`marked ${formatRef({ path })} as ${state}`);
    this.changed();
  }

  setCursor(who: Actor, cursor: Omit<Cursor, 'at'> | null): void {
    if (cursor) this.requireFile(cursor.path);
    const prev = this.presence[who];
    const next: Cursor | null = cursor ? { ...cursor, at: now() } : null;
    this.presence = { ...this.presence, [who]: next };
    if (who === 'agent' && next) {
      const f = this.requireFile(next.path);
      if (f.reviewState === 'unvisited') f.reviewState = 'in-progress';
    }
    if (who === 'human' && next && prev?.path !== next.path) this.logActivity(`opened ${formatRef({ path: next.path })}`);
    this.changed({ persist: who === 'agent' });
  }

  setFollowAgent(v: boolean): void {
    this.followAgent = v;
    this.changed({ persist: false });
  }

  setPlan(plan: Omit<ReviewPlan, 'createdAt'>): ReviewPlan {
    const known = new Set(this.files.map((f) => f.path));
    const unknown = plan.files.filter((p) => !known.has(p.path)).map((p) => p.path);
    if (unknown.length) throw new StoreError(`unknown paths in plan: ${unknown.join(', ')}`);
    const listed = new Set(plan.files.map((p) => p.path));
    // Files the agent left out are appended as low priority so nothing is silently skipped.
    const rest = this.files.filter((f) => !listed.has(f.path)).map((f) => ({ path: f.path, priority: 'low' as const, note: '(not prioritised by the agent)' }));
    this.plan = { summary: plan.summary, files: [...plan.files, ...rest], createdAt: now() };
    if (this.phase === 'preparing') this.phase = 'walkthrough';
    this.changed();
    return this.plan;
  }

  setPhase(phase: Phase): void {
    this.phase = phase;
    this.changed();
  }

  setAgent(patch: Partial<AgentInfo>): void {
    this.agent = { ...this.agent, ...patch };
    if (patch.status && patch.status !== 'error' && patch.status !== 'signed-out' && !('error' in patch)) delete this.agent.error;
    this.changed({ persist: false });
  }

  // ------------------------------------------------------------ pending comments

  /** Returns an error message, or null when the location is commentable on GitHub. */
  validateLocation(path: string, side: Side, line: number, startLine?: number): string | null {
    const file = this.diffByPath.get(path);
    if (!file) return `"${path}" is not part of this diff`;
    if (file.binary) return `"${path}" is binary`;
    if (!Number.isInteger(line) || line < 1) return 'line must be a positive integer';
    if (startLine !== undefined) {
      if (startLine > line) return 'startLine must be <= line';
      if (!isCommentableRange(file, side, startLine, line)) return `lines ${startLine}-${line} (${side}) are not both inside the same diff hunk of ${path}`;
      return null;
    }
    if (!isCommentable(file, side, line)) {
      return `line ${line} (${side}) of ${path} is not inside a diff hunk; GitHub only accepts comments on changed lines and their surrounding context. Use get_file_diff to pick a line.`;
    }
    return null;
  }

  addPending(input: { path: string; side?: Side; line: number; startLine?: number; body: string; author: Actor }): PendingComment {
    const side = input.side ?? 'RIGHT';
    const body = input.body.trim();
    if (!body) throw new StoreError('comment body is empty');
    const err = this.validateLocation(input.path, side, input.line, input.startLine);
    if (err) throw new StoreError(err);
    const c: PendingComment = { id: `c_${++this.seq}_${randomUUID().slice(0, 6)}`, path: input.path, side, line: input.line, body, author: input.author, createdAt: now(), updatedAt: now() };
    if (input.startLine !== undefined && input.startLine !== input.line) c.startLine = input.startLine;
    this.pending = [...this.pending, c];
    if (input.author === 'human') this.logActivity(`added pending comment ${c.id} on ${formatRef({ path: c.path, startLine: c.startLine ?? c.line, endLine: c.line })}: "${truncate(body, 120)}"`);
    this.changed();
    return c;
  }

  updatePending(id: string, body: string, by: Actor): PendingComment {
    const c = this.pending.find((x) => x.id === id);
    if (!c) throw new StoreError(`no pending comment ${id}`);
    const text = body.trim();
    if (!text) throw new StoreError('comment body is empty');
    const next: PendingComment = { ...c, body: text, updatedAt: now() };
    if (by === 'human' && c.author === 'agent') next.editedByHuman = true;
    this.pending = this.pending.map((x) => (x.id === id ? next : x));
    if (by === 'human') this.logActivity(`edited pending comment ${id}: "${truncate(text, 120)}"`);
    this.changed();
    return next;
  }

  deletePending(id: string, by: Actor): PendingComment {
    const c = this.pending.find((x) => x.id === id);
    if (!c) throw new StoreError(`no pending comment ${id}`);
    this.pending = this.pending.filter((x) => x.id !== id);
    if (by === 'human') this.logActivity(`deleted pending comment ${id} (${c.author}) on ${formatRef({ path: c.path, startLine: c.line })}`);
    this.changed();
    return c;
  }

  clearPendingAfterSubmit(sub: Submission): void {
    this.pending = [];
    this.lastSubmission = sub;
    this.phase = 'idle';
    this.changed();
  }

  // ------------------------------------------------------------ chat

  makeMessage(role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id: `m_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`, role, text, at: now(), ...extra };
  }

  appendChat(msg: ChatMessage): ChatMessage {
    this.chat.push(msg);
    if (this.chat.length > 2000) this.chat.splice(0, this.chat.length - 2000);
    this.emit('chat', { type: 'append', message: msg });
    if (!msg.streaming) this.scheduleSave();
    return msg;
  }

  chatDelta(id: string, text: string): void {
    const m = this.chat.find((x) => x.id === id);
    if (!m) return;
    m.text += text;
    this.emit('chat', { type: 'delta', id, text });
  }

  updateChat(id: string, patch: Partial<ChatMessage>): void {
    const idx = this.chat.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const m = { ...this.chat[idx]!, ...patch };
    this.chat[idx] = m;
    this.emit('chat', { type: 'update', message: m });
    this.scheduleSave();
  }

  setAgentSessionId(id: string): void {
    if (this.agentSessionId === id) return;
    this.agentSessionId = id;
    this.scheduleSave();
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
