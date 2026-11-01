// AgentSession — one long-lived streaming-input query() per server (specs/sessions/agent-session.md)
import { query, type Query, type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ReviewStore } from '../store.js';
import { looksLikeAuthError, resolveAgentAuth } from '../auth/agent.js';
import { createDuoServer, DUO_TOOL_NAMES } from './tools.js';
import { KICKOFF_PROMPT, REVIEW_SYSTEM_PROMPT, wrapHumanMessage } from './prompts.js';
import type { AgentAuthMode, ChatMessage, Cursor } from '../../shared/types.js';
import { formatRef } from '../../shared/types.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const DENIED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'];

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
}

export class AgentSession {
  private q: Query | null = null;
  private input: InputQueue | null = null;
  private generation = 0;
  /** stream content-block index → chat message id (for the current assistant message) */
  private blockMsg = new Map<number, string>();
  private streamedMessageIds = new Set<string>();
  private toolRows = new Map<string, string>();
  private currentStreamMessageId: string | null = null;

  constructor(private readonly store: ReviewStore, private readonly opts: AgentSessionOptions) {}

  get running(): boolean {
    return this.q !== null;
  }

  /** Resolve auth and open the session. Sends the kickoff unless resuming. */
  async start(): Promise<void> {
    const gen = ++this.generation;
    this.store.setAgent({ status: 'starting' });
    const auth = await resolveAgentAuth(this.opts.authMode);
    if (gen !== this.generation) return;
    this.store.setAgent({ auth: auth.summary });
    for (const w of auth.summary.warnings) this.system(`⚠️ ${w}`);
    if (!auth.summary.ready) {
      this.store.setAgent({ status: this.opts.authMode === 'claude-code' ? 'signed-out' : 'error', error: auth.summary.hint ?? 'agent is not authenticated' });
      return;
    }

    const input = new InputQueue();
    this.input = input;
    const resume = this.store.agentSessionId;
    const options: Options = {
      cwd: this.store.target.repoRoot,
      tools: READ_ONLY_TOOLS,
      allowedTools: [...READ_ONLY_TOOLS, ...DUO_TOOL_NAMES.map((n) => `mcp__duo__${n}`)],
      disallowedTools: DENIED_TOOLS,
      // Anything not in allowedTools is denied without prompting (read-only review session).
      permissionMode: 'dontAsk',
      mcpServers: { duo: createDuoServer(this.store, (t) => this.system(t)) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: REVIEW_SYSTEM_PROMPT },
      settingSources: [],
      includePartialMessages: true,
      env: auth.env,
      stderr: (data) => {
        if (process.env['BACKCOURT_DUO_DEBUG']) process.stderr.write(`[agent] ${data}`);
      },
    };
    if (auth.executable) options.pathToClaudeCodeExecutable = auth.executable;
    const model = this.opts.model ?? process.env['BACKCOURT_DUO_MODEL'];
    if (model) options.model = model;
    if (resume) options.resume = resume;

    const q = query({ prompt: input, options });
    this.q = q;
    void this.pump(q, gen);

    if (!resume) {
      this.store.setPhase(this.store.plan ? this.store.phase : 'preparing');
      this.system('🏀 Agent is preparing the review…');
      this.send(KICKOFF_PROMPT, { synthetic: true });
    } else {
      this.store.setAgent({ status: 'waiting' });
      this.system('🏀 Resumed the previous agent conversation.');
    }
  }

  /** Send a human message (wrapped with presence + activity). */
  sendHuman(text: string): ChatMessage {
    const msg = this.store.appendChat(this.store.makeMessage('human', text));
    this.send(wrapHumanMessage(this.store, text), { synthetic: false });
    return msg;
  }

  private send(text: string, _opts: { synthetic: boolean }): void {
    if (!this.input) throw new Error('agent is not running');
    this.store.setAgent({ status: 'thinking' });
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.input?.close();
    this.q?.close();
    this.q = null;
    this.input = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // ------------------------------------------------------------------ message pump

  private system(text: string): void {
    this.store.appendChat(this.store.makeMessage('system', text));
  }

  private async pump(q: Query, gen: number): Promise<void> {
    try {
      for await (const m of q) {
        if (gen !== this.generation) return;
        this.handle(m);
      }
      if (gen === this.generation) this.store.setAgent({ status: 'stopped' });
    } catch (err) {
      if (gen !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      this.finishStreaming();
      if (looksLikeAuthError(message)) {
        this.store.setAgent({ status: 'signed-out', error: 'Claude rejected the credentials — please sign in again.' });
      } else {
        this.store.setAgent({ status: 'error', error: message.split('\n')[0] ?? message });
      }
      this.system(`❌ Agent stopped: ${message.split('\n')[0]}`);
    } finally {
      if (gen === this.generation) {
        this.q = null;
        this.input = null;
      }
    }
  }

  private finishStreaming(): void {
    for (const id of this.blockMsg.values()) this.store.updateChat(id, { streaming: false });
    this.blockMsg.clear();
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.store.setAgentSessionId(m.session_id);
          this.store.setAgent({ model: m.model });
        }
        return;
      case 'auth_status':
        if (m.error) this.store.setAgent({ status: 'signed-out', error: m.error });
        return;
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === 'message_start') {
          this.currentStreamMessageId = ev.message.id;
          this.blockMsg.clear();
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
          const msg = this.store.appendChat(this.store.makeMessage('agent', ev.content_block.text ?? '', { streaming: true }));
          this.blockMsg.set(ev.index, msg.id);
          if (this.currentStreamMessageId) this.streamedMessageIds.add(this.currentStreamMessageId);
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
        const streamed = this.streamedMessageIds.has(m.message.id);
        for (const block of m.message.content) {
          if (block.type === 'text' && !streamed && block.text.trim()) {
            this.store.appendChat(this.store.makeMessage('agent', block.text));
          } else if (block.type === 'tool_use') {
            const row = this.store.appendChat(this.store.makeMessage('tool', '', { tool: describeTool(block.name, block.input as Record<string, unknown>, this.store.target.repoRoot) }));
            this.toolRows.set(block.id, row.id);
          }
        }
        if (m.error) {
          const text = typeof m.error === 'string' ? m.error : JSON.stringify(m.error);
          if (looksLikeAuthError(text)) this.store.setAgent({ status: 'signed-out', error: 'Please sign in to Claude.' });
        }
        return;
      }
      case 'user': {
        const content = m.message.content;
        if (typeof content === 'string') return;
        for (const block of content) {
          if (block.type === 'tool_result' && block.is_error) {
            const rowId = this.toolRows.get(block.tool_use_id);
            const row = rowId ? this.store.chat.find((c) => c.id === rowId) : undefined;
            if (row?.tool) this.store.updateChat(row.id, { tool: { ...row.tool, isError: true } });
          }
        }
        return;
      }
      case 'result': {
        this.finishStreaming();
        this.streamedMessageIds.clear();
        if (m.subtype !== 'success' || m.is_error) {
          const errs = 'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : '';
          const resultText = 'result' in m && typeof m.result === 'string' ? m.result : '';
          const text = errs || resultText || m.subtype;
          if (looksLikeAuthError(text)) {
            this.store.setAgent({ status: 'signed-out', error: 'Claude asked to sign in again.' });
            return;
          }
          this.system(`⚠️ Turn ended with ${m.subtype}${text && text !== m.subtype ? `: ${text.slice(0, 300)}` : ''}`);
        }
        this.store.setAgent({ status: 'waiting' });
        return;
      }
      default:
        return;
    }
  }
}

function describeTool(name: string, input: Record<string, unknown>, root: string): NonNullable<ChatMessage['tool']> {
  const short = name.replace(/^mcp__duo__/, '');
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const n = (k: string) => (typeof input[k] === 'number' ? (input[k] as number) : undefined);
  const refOf = (): Cursor | undefined => {
    const path = s('path') ?? s('file_path');
    if (!path) return undefined;
    const c: Cursor = { path, at: new Date().toISOString() };
    const start = n('startLine') ?? n('line');
    const end = n('endLine') ?? n('line');
    if (start !== undefined) c.startLine = start;
    if (end !== undefined) c.endLine = end;
    return c;
  };
  const ref = refOf();
  const refText = ref ? formatRef({ path: ref.path, ...(ref.startLine !== undefined ? { startLine: ref.startLine } : {}), ...(ref.endLine !== undefined ? { endLine: ref.endLine } : {}) }) : '';
  let summary: string;
  switch (short) {
    case 'focus': summary = `📍 focus ${refText}${s('note') ? ` — ${s('note')}` : ''}`; break;
    case 'get_review_context': summary = '🗂️ read review context'; break;
    case 'get_file_diff': summary = `🧾 read diff ${refText}`; break;
    case 'set_review_plan': summary = `🗺️ set review plan (${Array.isArray(input['files']) ? input['files'].length : 0} files)`; break;
    case 'get_human_focus': summary = '👀 checked where you are'; break;
    case 'add_pending_comment': summary = `💬 staged comment on ${refText}`; break;
    case 'update_pending_comment': summary = `✏️ edited pending ${s('id') ?? ''}`; break;
    case 'delete_pending_comment': summary = `🗑️ deleted pending ${s('id') ?? ''}`; break;
    case 'mark_file_reviewed': summary = `✅ marked ${refText} reviewed`; break;
    case 'set_phase': summary = `🏁 phase → ${s('phase') ?? ''}`; break;
    case 'Read': {
      const p = s('file_path') ?? '';
      const rel = p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
      summary = `📖 Read ${rel}`;
      break;
    }
    case 'Grep': summary = `🔎 Grep ${JSON.stringify(s('pattern') ?? '')}${s('path') ? ` in ${s('path')}` : ''}`; break;
    case 'Glob': summary = `🔎 Glob ${s('pattern') ?? ''}`; break;
    default: summary = `🔧 ${short}`;
  }
  const out: NonNullable<ChatMessage['tool']> = { name: short, summary };
  if (ref && short !== 'Read') out.ref = ref;
  return out;
}
