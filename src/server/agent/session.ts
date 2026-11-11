// AgentSession — one streaming-input query() at a time, renewed at file / phase boundaries (specs/sessions/agent-session.md)
import { query, type ModelInfo, type Query, type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ReviewStore } from '../store.js';
import { isSignInError, looksLikeAuthError, resolveAgentAuth, type ResolvedAgentAuth } from '../auth/agent.js';
import { startClaudeLogin } from '../auth/claude-login.js';
import { createDuoServer, createDuoTools, DUO_SERVER, shortToolName } from './tools.js';
import { handoffMessage, kickoffPrompt, reviewSystemPrompt, wrapHumanMessage } from './prompts.js';
import { compact, mergeRateLimit, TokenMeter } from './usage.js';
import type { AgentAuthMode, AgentStatus, AgentUsage, ChatMessage, EffortLevel, ModelOption, Phase, Ref } from '../../shared/types.js';
import { formatRef } from '../../shared/types.js';
import { truncate } from '../../shared/text.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const DENIED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'];
const DEBUG = Boolean(process.env['BACKCOURT_DUO_DEBUG']);
/** Kill switch for the context reset (specs/sessions/agent-session.md#コンテキストのリセット). */
const CONTEXT_RESET = !/^(0|off|false)$/i.test(process.env['BACKCOURT_DUO_CONTEXT_RESET'] ?? '');
/** Prompt size (input + cache read + cache write of the last request) at which the conversation is dropped. */
const RESET_AT_TOKENS = 60_000;

interface Progress {
  phase: Phase;
  reviewed: number;
}

/** Minimal async queue used as the streaming prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(m: SDKUserMessage): void {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface AgentSessionOptions {
  authMode: AgentAuthMode;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
}

export class AgentSession {
  private q: Query | null = null;
  private input: InputQueue | null = null;
  private generation = 0;
  /** stream content-block index → chat message id, for the assistant message being streamed */
  private blockMsg = new Map<number, string>();
  /** Assistant message ids whose text already arrived via stream events (cleared every turn). */
  private streamed = new Set<string>();
  /** tool_use id → its chat row, so an error result can flag the row without scanning the chat. */
  private toolRows = new Map<string, ChatMessage>();
  /** Starts as --model / env / config; a switch from the UI sticks across restarts. */
  private model: string | undefined;
  /** Per-turn token log, only under BACKCOURT_DUO_DEBUG; one per query() since its totals are per query(). */
  private meter: TokenMeter | null = null;
  /** Kept from start() so a context reset can open the next query() synchronously. */
  private auth: ResolvedAgentAuth | null = null;
  /** Review progress at the end of the previous turn: a change by the end of this one is a reset boundary. */
  private progress: Progress = { phase: 'preparing', reviewed: 0 };
  /** Prompt tokens of the latest request in this query(). */
  private contextTokens = 0;
  /** A message was pushed mid-turn, so the query() still owes a reply and must not be dropped yet. */
  private sentMidTurn = false;
  /** Set by a reset; the next human message opens with the handoff. */
  private handoffReason: string | null = null;
  /** Cost of the query() calls dropped by resets, so the meter keeps the session total. */
  private costBase = 0;

  constructor(private readonly store: ReviewStore, private readonly opts: AgentSessionOptions) {
    this.model = opts.model;
    // The store holds the effort (no alias mapping like `model`), so it survives restarts on its own.
    if (opts.effort) store.setAgent({ effort: opts.effort });
  }

  get running(): boolean {
    return this.q !== null;
  }

  /** Open the session (resolving auth unless given). Sends the kickoff unless resuming. */
  async start(resolved?: ResolvedAgentAuth): Promise<void> {
    const gen = ++this.generation;
    this.store.setAgentStatus('starting');
    const auth = resolved ?? (await resolveAgentAuth(this.opts.authMode));
    if (gen !== this.generation) return;
    // Context and cost belong to one query(); plan limits belong to the account and stay.
    this.store.setAgent({ auth: auth.summary, usage: { limits: this.store.agent.usage.limits } });
    for (const w of auth.summary.warnings) this.system(`⚠️ ${w}`);
    if (!auth.summary.ready) {
      this.store.setAgentStatus(this.opts.authMode === 'claude-code' ? 'signed-out' : 'error', auth.summary.hint ?? 'agent is not authenticated');
      return;
    }

    this.auth = auth;
    this.costBase = 0;
    this.handoffReason = null;
    const resume = this.store.agentSessionId;
    if (!resume && !this.store.plan) this.store.setPhase('preparing');
    const q = this.open(auth, gen, resume);
    void q
      .supportedModels()
      .then((models) => {
        if (gen !== this.generation) return;
        this.store.setAgent({ models: models.map(toModelOption) });
        this.publishModel(this.store.agent.model);
      })
      .catch(() => undefined);

    if (resume) {
      this.store.setAgentStatus('waiting');
      this.system('🏀 Resumed the previous agent conversation.');
    } else {
      this.system('🏀 Agent is preparing the review…');
      this.send(kickoffPrompt(this.store.language));
    }
  }

  /** Open a query() for generation `gen`, resuming the conversation `resume` if given. */
  private open(auth: ResolvedAgentAuth, gen: number, resume: string | null): Query {
    const input = new InputQueue();
    this.input = input;
    const tools = createDuoTools(this.store, (t) => this.system(t));
    const options: Options = {
      cwd: this.store.target.repoRoot,
      tools: READ_ONLY_TOOLS,
      allowedTools: [...READ_ONLY_TOOLS, ...tools.map((t) => `mcp__${DUO_SERVER}__${t.name}`)],
      disallowedTools: DENIED_TOOLS,
      // Anything not in allowedTools is denied without prompting (read-only review session).
      permissionMode: 'dontAsk',
      mcpServers: { [DUO_SERVER]: createDuoServer(tools) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: reviewSystemPrompt(this.store.language) },
      settingSources: [],
      includePartialMessages: true,
      env: auth.env,
      ...(auth.executable ? { pathToClaudeCodeExecutable: auth.executable } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.store.agent.effort ? { effort: this.store.agent.effort } : {}),
      ...(resume ? { resume } : {}),
      stderr: (data) => {
        if (DEBUG) process.stderr.write(`[agent] ${data}`);
      },
    };

    const q = query({ prompt: input, options });
    this.q = q;
    this.meter = DEBUG ? new TokenMeter() : null;
    this.contextTokens = 0;
    this.sentMidTurn = false;
    this.progress = this.currentProgress();
    void this.pump(q, gen);
    return q;
  }

  /** Send a human message (wrapped with presence + activity, and the handoff after a reset). */
  sendHuman(text: string): ChatMessage {
    // Built before the message joins the chat, so "your last message" is the agent's.
    const handoff = this.handoffReason ? `${handoffMessage(this.store, this.handoffReason)}\n\n` : '';
    const msg = this.store.appendChat(this.store.makeMessage('human', text));
    this.send(handoff + wrapHumanMessage(this.store, text));
    this.handoffReason = null;
    return msg;
  }

  private send(text: string): void {
    if (!this.input) throw new Error('agent is not running');
    if (this.store.agent.status === 'thinking') this.sentMidTurn = true;
    this.store.setAgentStatus('thinking');
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  /**
   * Subscription sign-in from the UI (specs/sessions/agent-claude-code.md): run `claude auth login`, then restart
   * with the freshly resolved auth. Rejects immediately (LoginBusyError / not installed); the rest runs in the background.
   */
  async signIn(): Promise<void> {
    const { done } = await startClaudeLogin();
    this.store.setAgent({ loginInProgress: true });
    this.system('🔐 Opening Claude sign-in in your browser…');
    void done
      .then(async (code) => {
        const auth = await resolveAgentAuth(this.opts.authMode);
        this.store.setAgent({ loginInProgress: false });
        if (!auth.summary.ready) {
          this.store.setAgent({ auth: auth.summary });
          this.system(`Sign-in did not complete (exit ${code}). You can also run \`backcourt-duo auth login\` in a terminal.`);
          return;
        }
        this.system(`✅ Signed in${auth.summary.account ? ` as ${auth.summary.account}` : ''}. Starting the agent…`);
        await this.stop();
        await this.start(auth);
      })
      .catch(() => this.store.setAgent({ loginInProgress: false }));
  }

  /** Switch the model for the following turns (the conversation is kept). */
  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
    this.model = model;
    this.publishModel(model);
    this.system(`🔁 Model switched to \`${model}\`.`);
  }

  /** Switch the reasoning effort for the following turns; null goes back to the model's default. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.q?.applyFlagSettings({ effortLevel: effort });
    this.store.setAgent({ effort: effort ?? undefined });
    this.system(`🧠 Effort switched to \`${effort ?? 'default'}\`.`);
  }

  /** `agent.model` is always a picker `value`: init reports the resolved id, a switch the alias, so map both. */
  private publishModel(model: string | undefined): void {
    if (!model) return;
    const option = this.store.agent.models?.find((m) => m.value === model || m.resolvedModel === model);
    this.store.setAgent({ model: option?.value ?? model });
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.close();
    this.q = null;
    this.input = null;
  }

  /** Retire the current query(): later messages from it are ignored. Returns the new generation. */
  private close(): number {
    this.input?.close();
    this.q?.close();
    return ++this.generation;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // ------------------------------------------------------------------ message pump

  private system(text: string): void {
    this.store.system(text);
  }

  /** One place that turns a failure into agent status. Typed SDK codes first; text only as a fallback. */
  private fail(opts: { code?: string | undefined; text: string; fatal: boolean }): void {
    const signIn = isSignInError(opts.code) || looksLikeAuthError(opts.text);
    const firstLine = opts.text.split('\n')[0] ?? opts.text;
    const status: AgentStatus = signIn ? 'signed-out' : opts.fatal ? 'error' : 'waiting';
    this.store.setAgentStatus(status, signIn ? 'Claude asked to sign in again.' : opts.fatal ? firstLine : undefined);
    this.system(signIn ? '🔐 Claude needs you to sign in again.' : `${opts.fatal ? '❌ Agent stopped' : '⚠️ Turn ended with an error'}: ${firstLine.slice(0, 300)}`);
  }

  private async pump(q: Query, gen: number): Promise<void> {
    try {
      for await (const m of q) {
        if (gen !== this.generation) return;
        const tokens = this.meter?.observe(m);
        if (tokens) process.stderr.write(`${tokens}\n`);
        this.handle(m);
      }
      if (gen === this.generation) this.store.setAgentStatus('stopped');
    } catch (err) {
      if (gen !== this.generation) return;
      this.endTurn();
      this.fail({ text: err instanceof Error ? err.message : String(err), fatal: true });
    } finally {
      if (gen === this.generation) {
        this.q = null;
        this.input = null;
      }
    }
  }

  private setUsage(patch: Partial<AgentUsage>): void {
    this.store.setAgent({ usage: { ...this.store.agent.usage, ...patch } });
  }

  /**
   * End-of-turn usage meter update, as one store change: the context fill (`summary` answers from the last response
   * without extra token-count calls) and, with an API key, the session cost.
   */
  private async refreshUsage(totalCostUSD: number): Promise<void> {
    const gen = this.generation;
    const c = await this.q?.getContextUsage({ detail: 'summary' }).catch(() => undefined);
    if (gen !== this.generation) return;
    this.setUsage({
      ...(c ? { context: { used: c.totalTokens, max: c.maxTokens } } : {}),
      ...this.costPatch(this.costBase + totalCostUSD),
    });
  }

  /** Cost is shown for API-key auth only (a subscription is not billed per call). */
  private costPatch(costUSD: number): Partial<AgentUsage> {
    return this.opts.authMode === 'api-key' ? { costUSD } : {};
  }

  private currentProgress(): Progress {
    return { phase: this.store.phase, reviewed: this.store.reviewedCount };
  }

  /** Why the conversation should be dropped after a turn that moved the review from `was` to `now`, if it should. */
  private resetReason(was: Progress, now: Progress): string | null {
    if (now.phase !== was.phase) return `phase → ${now.phase}`;
    if (now.reviewed > was.reviewed) return 'file reviewed';
    if (this.contextTokens >= RESET_AT_TOKENS) return `context reached ${compact(this.contextTokens)} tokens`;
    return null;
  }

  /** End-of-turn bookkeeping: drop the conversation at a boundary, or refresh the usage meter. */
  private afterTurn(totalCostUSD: number): void {
    // A message pushed mid-turn still owes its reply on this query(): keep the baseline so the next turn end re-checks.
    const owed = this.sentMidTurn;
    this.sentMidTurn = false;
    let reason: string | null = null;
    if (CONTEXT_RESET && !owed) {
      const now = this.currentProgress();
      reason = this.resetReason(this.progress, now);
      this.progress = now;
    }
    if (!reason || !this.auth) {
      void this.refreshUsage(totalCostUSD);
      return;
    }
    // Close the query() and open a fresh one without `resume`; the store is the memory that carries over.
    const gen = this.close();
    this.costBase += totalCostUSD;
    // The context fill belongs to the dropped query(); the cost and plan limits carry over.
    this.setUsage({ context: undefined, ...this.costPatch(this.costBase) });
    this.open(this.auth, gen, null);
    this.handoffReason = reason;
    this.system(`🧹 Agent context reset (${reason}); it continues from the shared review state.`);
  }

  private endTurn(): void {
    for (const id of this.blockMsg.values()) this.store.updateChat(id, { streaming: false });
    this.blockMsg.clear();
    this.streamed.clear();
    this.toolRows.clear();
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.publishModel(m.model);
        return;
      case 'auth_status':
        if (m.error) this.fail({ code: 'authentication_failed', text: m.error, fatal: false });
        return;
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === 'message_start') {
          this.blockMsg.clear();
          this.streamed.add(ev.message.id);
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
          const msg = this.store.appendChat(this.store.makeMessage('agent', ev.content_block.text ?? '', { streaming: true }));
          this.blockMsg.set(ev.index, msg.id);
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          const id = this.blockMsg.get(ev.index);
          if (id) this.store.chatDelta(id, ev.delta.text);
        } else if (ev.type === 'content_block_stop') {
          const id = this.blockMsg.get(ev.index);
          if (id) {
            this.store.updateChat(id, { streaming: false });
            this.blockMsg.delete(ev.index);
          }
        }
        return;
      }
      case 'assistant': {
        if (m.parent_tool_use_id) return;
        const u = m.message.usage;
        this.contextTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const streamed = this.streamed.has(m.message.id);
        for (const block of m.message.content) {
          if (block.type === 'text' && !streamed && block.text.trim()) {
            this.store.appendChat(this.store.makeMessage('agent', block.text));
          } else if (block.type === 'tool_use') {
            const row = this.store.appendChat(this.store.makeMessage('tool', '', { tool: describeTool(block.name, block.input as Record<string, unknown>, this.store.target.repoRoot) }));
            this.toolRows.set(block.id, row);
          }
        }
        if (m.error) this.fail({ code: m.error, text: m.error, fatal: false });
        return;
      }
      case 'user': {
        const content = m.message.content;
        if (typeof content === 'string') return;
        for (const block of content) {
          if (block.type !== 'tool_result' || !block.is_error) continue;
          const row = this.toolRows.get(block.tool_use_id);
          if (row?.tool) this.store.updateChat(row.id, { tool: { ...row.tool, isError: true } });
        }
        return;
      }
      case 'rate_limit_event': {
        const limits = this.store.agent.usage.limits;
        const next = mergeRateLimit(limits, m.rate_limit_info);
        if (next !== limits) this.setUsage({ limits: next });
        return;
      }
      case 'result': {
        this.endTurn();
        // Saved once a turn completes, not at init: a restart then never resumes a reset conversation that lacks the handoff.
        this.store.setAgentSessionId(m.session_id);
        this.afterTurn(m.total_cost_usd);
        if (m.subtype === 'success' && !m.is_error) {
          this.store.setAgentStatus('waiting');
          return;
        }
        const errs = 'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : '';
        const resultText = 'result' in m && typeof m.result === 'string' ? m.result : '';
        this.fail({ text: errs || resultText || m.subtype, fatal: false });
        return;
      }
      default:
        return;
    }
  }
}

function toModelOption(m: ModelInfo): ModelOption {
  return {
    value: m.value,
    resolvedModel: m.resolvedModel,
    displayName: m.displayName,
    description: m.description,
    supportedEffortLevels: m.supportsEffort ? m.supportedEffortLevels : undefined,
  };
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** One-line chat summary of a tool call, linking to the location it touches. */
function describeTool(name: string, input: Record<string, unknown>, root: string): NonNullable<ChatMessage['tool']> {
  const short = shortToolName(name);
  const path = str(input['path']);
  const ref: Ref | undefined = path === undefined ? undefined : { path, startLine: num(input['startLine']) ?? num(input['line']), endLine: num(input['endLine']) ?? num(input['line']) };
  const at = ref ? formatRef(ref) : '';
  const summaries: Record<string, () => string> = {
    focus: () => `📍 focus ${at}${str(input['note']) ? ` — ${str(input['note'])}` : ''}`,
    get_review_context: () => '🗂️ read review context',
    get_file_diff: () => `🧾 read diff ${at}`,
    set_review_plan: () => `🗺️ set review plan (${Array.isArray(input['files']) ? input['files'].length : 0} files)`,
    get_human_focus: () => '👀 checked where you are',
    add_pending_comment: () => `💬 staged comment on ${at}`,
    update_pending_comment: () => `✏️ edited pending ${str(input['id']) ?? ''}`,
    delete_pending_comment: () => `🗑️ deleted pending ${str(input['id']) ?? ''}`,
    propose_change: () => `💡 proposed a change on ${at}`,
    withdraw_proposal: () => `↩️ withdrew proposal ${str(input['id']) ?? ''}`,
    save_note: () => `📝 noted${at ? ` on ${at}` : ''}: ${truncate(str(input['text']) ?? '', 80)}`,
    update_note: () => `📝 ${input['resolved'] === true ? 'resolved' : input['resolved'] === false ? 'reopened' : 'edited'} note ${str(input['id']) ?? ''}`,
    delete_note: () => `🗑️ deleted note ${str(input['id']) ?? ''}`,
    mark_file_reviewed: () => `✅ marked ${at} reviewed`,
    set_phase: () => `🏁 phase → ${str(input['phase']) ?? ''}`,
    Read: () => `📖 Read ${(str(input['file_path']) ?? '').replace(`${root}/`, '')}`,
    Grep: () => `🔎 Grep ${JSON.stringify(str(input['pattern']) ?? '')}${path ? ` in ${path}` : ''}`,
    Glob: () => `🔎 Glob ${str(input['pattern']) ?? ''}`,
  };
  return { summary: summaries[short]?.() ?? `🔧 ${short}`, ref: short === 'Grep' ? undefined : ref };
}
