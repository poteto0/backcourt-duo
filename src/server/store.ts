// ReviewStore — the single source of truth (specs/architecture.md).
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCommentable, isCommentableRange, rightLineTexts } from './diff.js';
import type {
  Actor,
  AgentInfo,
  AgentStatus,
  ChangeProposal,
  ChatEvent,
  ChatMessage,
  CursorInput,
  DiffFile,
  FileEntry,
  GitHubContext,
  PendingComment,
  Phase,
  Presence,
  PullRequestInfo,
  ReviewPlan,
  ReviewRecommendation,
  ReviewState,
  ReviewStateSnapshot,
  ReviewTarget,
  Side,
  Submission,
  Warning,
} from '../shared/types.js';
import { commentRef, formatRef } from '../shared/types.js';
import { describeLanguage, looksLikeOtherLanguage, type LanguageSettings } from '../shared/language.js';

type LanguageTags = { conversation: string | null; review: string | null };

interface Persisted {
  version: 1;
  headSha: string;
  mergeBaseSha: string;
  pending: PendingComment[];
  proposals?: ChangeProposal[];
  reviewStates: Record<string, { state: ReviewState; by?: Actor }>;
  plan: ReviewPlan | null;
  phase: Phase;
  chat: ChatMessage[];
  agentSessionId: string | null;
  lastSubmission: Submission | null;
  recommendation?: ReviewRecommendation | null;
  /** Language tags the agent conversation was last instructed with. */
  language?: LanguageTags;
}

export class StoreError extends Error {}

const now = () => new Date().toISOString();

/** Events carry pre-serialised JSON so N SSE clients cost one JSON.stringify. */
export class ReviewStore extends EventEmitter<{ state: [string]; chat: [string] }> {
  readonly diffByPath = new Map<string, DiffFile>();
  files: FileEntry[];
  pr: PullRequestInfo | null = null;
  plan: ReviewPlan | null = null;
  phase: Phase = 'preparing';
  presence: Presence = { human: null, agent: null };
  followAgent = true;
  pending: PendingComment[] = [];
  proposals: ChangeProposal[] = [];
  agent: AgentInfo = { status: 'starting', auth: null, loginInProgress: false, usage: { limits: [] } };
  github: GitHubContext = { auth: null, owner: null, repo: null };
  lastSubmission: Submission | null = null;
  recommendation: ReviewRecommendation | null = null;
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
    /** Fixed at startup (specs/commands/start.md#言語). */
    readonly language: LanguageSettings = { conversation: null, review: null },
  ) {
    super();
    for (const f of diff) this.diffByPath.set(f.path, f);
    this.files = diff.map((f) => {
      return { path: f.path, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary, reviewState: 'unvisited' } satisfies FileEntry;
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
    const review = this.language.review;
    const off = review ? this.pending.filter((c) => looksLikeOtherLanguage(c.body, review.tag)) : [];
    if (review && off.length) w.push({ code: 'review-language', message: `${off.length} pending comment${off.length === 1 ? ' seems' : 's seem'} not to be in ${review.name}, the review language (${off.map((c) => c.id).join(', ')}).` });
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
      proposals: this.proposals,
      agent: this.agent,
      github: this.github,
      lastSubmission: this.lastSubmission,
      recommendation: this.recommendation,
      language: this.language,
      warnings: this.warnings,
    };
  }

  /** Coalesce state broadcasts (presence updates can be chatty). */
  changed(opts: { persist?: boolean } = {}): void {
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emit('state', JSON.stringify(this.snapshot()));
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
    // Proposals survive only if the lines they replace are unchanged.
    this.proposals = (data.proposals ?? []).filter(
      (p) => this.validateLocation(p.path, 'RIGHT', p.endLine, p.startLine) === null && rightLineTexts(this.diffByPath.get(p.path)!, p.startLine, p.endLine).join('\n') === p.original.join('\n'),
    );
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
    // The agent conversation and its verdict only carry over if the code under review is unchanged.
    const sameCode = data.headSha === this.target.headSha && data.mergeBaseSha === this.target.mergeBaseSha;
    this.agentSessionId = sameCode ? data.agentSessionId : null;
    this.recommendation = sameCode ? (data.recommendation ?? null) : null;
    // A resumed conversation may have been held in other languages: tell the agent once, on its next turn.
    const was = data.language ?? { conversation: null, review: null };
    const tags = this.languageTags();
    if (this.agentSessionId && (was.conversation !== tags.conversation || was.review !== tags.review)) {
      this.logActivity(`language settings changed since this conversation started (${describeLanguage(this.language)}); follow the Language section of your instructions from now on`);
    }
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
      proposals: this.proposals,
      reviewStates: Object.fromEntries(
        this.files.filter((f) => f.reviewState !== 'unvisited').map((f) => [f.path, f.reviewedBy ? { state: f.reviewState, by: f.reviewedBy } : { state: f.reviewState }]),
      ),
      plan: this.plan,
      phase: this.phase,
      chat: this.chat.slice(-500),
      agentSessionId: this.agentSessionId,
      lastSubmission: this.lastSubmission,
      recommendation: this.recommendation,
      language: this.languageTags(),
    };
    const dir = join(this.statePath, '..');
    await mkdir(dir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.statePath);
  }

  private languageTags(): LanguageTags {
    return { conversation: this.language.conversation?.tag ?? null, review: this.language.review?.tag ?? null };
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

  setCursor(who: Actor, cursor: CursorInput | null): void {
    const prev = this.presence[who];
    if (cursor) {
      const f = this.requireFile(cursor.path);
      if (who === 'agent' && f.reviewState === 'unvisited') f.reviewState = 'in-progress';
      if (who === 'human' && prev?.path !== cursor.path) this.logActivity(`opened ${formatRef({ path: cursor.path })}`);
    }
    // A single start line means a one-line range, whoever sets it.
    const next = cursor ? { ...cursor, endLine: cursor.endLine ?? cursor.startLine, at: now() } : null;
    this.presence = { ...this.presence, [who]: next };
    // Presence is not persisted; only the agent's in-progress promotion is.
    this.changed({ persist: who === 'agent' && prev?.path !== cursor?.path });
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

  /** Status transitions replace the error: it is set exactly when given. */
  setAgentStatus(status: AgentStatus, error?: string): void {
    const { error: _old, ...rest } = this.agent;
    this.agent = error === undefined ? { ...rest, status } : { ...rest, status, error };
    this.changed({ persist: false });
  }

  setAgent(patch: Partial<Omit<AgentInfo, 'status' | 'error'>>): void {
    this.agent = { ...this.agent, ...patch };
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

  addPending(input: { path: string; side?: Side | undefined; line: number; startLine?: number | undefined; body: string; author: Actor }): PendingComment {
    const side = input.side ?? 'RIGHT';
    const body = requireText(input.body, 'comment body');
    const err = this.validateLocation(input.path, side, input.line, input.startLine);
    if (err) throw new StoreError(err);
    const startLine = input.startLine !== undefined && input.startLine !== input.line ? input.startLine : undefined;
    const c: PendingComment = { id: `c_${++this.seq}_${randomUUID().slice(0, 6)}`, path: input.path, side, line: input.line, startLine, body, author: input.author, createdAt: now(), updatedAt: now() };
    this.pending = [...this.pending, c];
    if (input.author === 'human') this.logActivity(`added pending comment ${c.id} on ${formatRef(commentRef(c))}: "${truncate(body, 120)}"`);
    this.changed();
    return c;
  }

  updatePending(id: string, body: string, by: Actor): PendingComment {
    const c = this.pending.find((x) => x.id === id);
    if (!c) throw new StoreError(`no pending comment ${id}`);
    const text = requireText(body, 'comment body');
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
    if (by === 'human') this.logActivity(`deleted pending comment ${id} (${c.author}) on ${formatRef(commentRef(c))}`);
    this.changed();
    return c;
  }

  // ------------------------------------------------------------ change proposals (never applied to files)

  addProposal(input: { path: string; startLine: number; endLine?: number | undefined; replacement: string; note: string }): ChangeProposal {
    const endLine = input.endLine ?? input.startLine;
    const err = this.validateLocation(input.path, 'RIGHT', endLine, input.startLine);
    if (err) throw new StoreError(`${err} (proposals use new-file R line numbers)`);
    const original = rightLineTexts(this.diffByPath.get(input.path)!, input.startLine, endLine);
    const replacement = input.replacement === '' ? [] : input.replacement.replace(/\n$/, '').split('\n');
    const p: ChangeProposal = { id: `p_${++this.seq}_${randomUUID().slice(0, 6)}`, path: input.path, startLine: input.startLine, endLine, original, replacement, note: input.note.trim(), createdAt: now() };
    this.proposals = [...this.proposals, p];
    this.changed();
    return p;
  }

  private takeProposal(id: string): ChangeProposal {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new StoreError(`no change proposal ${id}`);
    this.proposals = this.proposals.filter((x) => x.id !== id);
    return p;
  }

  removeProposal(id: string, by: Actor): ChangeProposal {
    const p = this.takeProposal(id);
    if (by === 'human') this.logActivity(`dismissed change proposal ${id} on ${formatRef(p)}`);
    this.changed();
    return p;
  }

  /** Turn a proposal into a pending comment with a GitHub suggestion block (the human's call). */
  stageProposal(id: string): PendingComment {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new StoreError(`no change proposal ${id}`);
    const code = p.replacement.join('\n');
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const c = this.addPending({ path: p.path, line: p.endLine, startLine: p.startLine, body: `${p.note}\n\n${fence}suggestion\n${code}${code ? '\n' : ''}${fence}`, author: 'agent' });
    this.takeProposal(id); // addPending already broadcast; this rides the same coalesced emit
    this.logActivity(`staged change proposal ${id} as pending comment ${c.id}`);
    return c;
  }

  // ------------------------------------------------------------ recommendation / submit

  setRecommendation(input: ReviewRecommendation): void {
    this.recommendation = { event: input.event, body: requireText(input.body, 'summary body') };
    this.changed();
  }

  /** The submission-completed transition: everything scoped to one review round is reset here. */
  completeSubmission(sub: Submission): void {
    this.pending = [];
    this.recommendation = null;
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
    this.emitChat({ type: 'append', message: msg });
    if (!msg.streaming) this.scheduleSave();
    return msg;
  }

  /** Streaming targets are almost always the newest messages: search from the end. */
  private chatIndex(id: string): number {
    return this.chat.findLastIndex((m) => m.id === id);
  }

  chatDelta(id: string, text: string): void {
    const m = this.chat[this.chatIndex(id)];
    if (!m) return;
    m.text += text;
    this.emitChat({ type: 'delta', id, text });
  }

  updateChat(id: string, patch: Partial<ChatMessage>): void {
    const idx = this.chatIndex(id);
    if (idx < 0) return;
    const m = { ...this.chat[idx]!, ...patch };
    this.chat[idx] = m;
    this.emitChat({ type: 'update', message: m });
    this.scheduleSave();
  }

  private emitChat(e: ChatEvent): void {
    this.emit('chat', JSON.stringify(e));
  }

  setAgentSessionId(id: string): void {
    if (this.agentSessionId === id) return;
    this.agentSessionId = id;
    this.scheduleSave();
  }
}

function requireText(s: string, what: string): string {
  const text = s.trim();
  if (!text) throw new StoreError(`${what} is empty`);
  return text;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
