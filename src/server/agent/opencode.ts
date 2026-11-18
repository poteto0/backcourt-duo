// OpenCode backend — one `opencode run` child process per turn, with the duo tools reached over MCP
// (specs/sessions/agent-opencode.md). Claude stays the default; this file is only used with `--agent opencode`.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ReviewStore } from '../store.js';
import { CommandNotFoundError, run, which } from '../exec.js';
import { handoffMessage, kickoffPrompt, reviewSystemPrompt, wrapHumanMessage } from './prompts.js';
import { describeTool } from './toolSummary.js';
import type { AgentRuntime } from './backend.js';
import type { AgentAuthSummary, AgentStatus, ChatMessage, EffortLevel, ModelOption, Phase } from '../../shared/types.js';
import { compact } from './usage.js';

const DEBUG = Boolean(process.env['BACKCOURT_DUO_DEBUG']);
/** Kill switch for the context reset (specs/sessions/agent-session.md#コンテキストのリセット). */
const CONTEXT_RESET = !/^(0|off|false)$/i.test(process.env['BACKCOURT_DUO_CONTEXT_RESET'] ?? '');
/** Prompt size at which the conversation is dropped (same budget as the Claude backend). */
const RESET_AT_TOKENS = 60_000;

export const OPENCODE_AGENT = 'duo';
const CONFIG_FILE = 'opencode.json';

interface Progress {
  phase: Phase;
  reviewed: number;
}

export interface OpencodeSessionOptions {
  model?: string | undefined;
  /** Streamable HTTP MCP endpoint of this backcourt-duo server. */
  mcpUrl: string;
  /** Local server session token; sent as the bearer credential. */
  token: string;
}

interface RunEvent {
  type: string;
  sessionID?: string;
  part?: {
    id?: string;
    partID?: string;
    type?: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: Record<string, unknown>; output?: string; title?: string };
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
    cost?: number;
  };
}

/** The OpenCode config used for every turn: duo agent + read-only permissions + the duo MCP server. */
export function opencodeConfig(opts: { system: string; mcpUrl: string; token: string }): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    default_agent: OPENCODE_AGENT,
    agents: {
      [OPENCODE_AGENT]: {
        description: 'backcourt-duo review partner (read-only, driven by the shared review state)',
        mode: 'primary',
        system: opts.system,
        permissions: [
          { action: 'edit', resource: '*', effect: 'deny' },
          { action: 'shell', resource: '*', effect: 'deny' },
          { action: 'webfetch', resource: '*', effect: 'deny' },
          { action: 'websearch', resource: '*', effect: 'deny' },
          { action: 'subagent', resource: '*', effect: 'deny' },
          { action: 'skill', resource: '*', effect: 'deny' },
          { action: 'external_directory', resource: '*', effect: 'deny' },
        ],
      },
    },
    mcp: {
      servers: {
        duo: {
          type: 'remote',
          url: opts.mcpUrl,
          oauth: false,
          codemode: false,
          headers: { Authorization: `Bearer ${opts.token}` },
        },
      },
    },
  };
}

/** `opencode models` prints one `provider/model` per line. */
export function parseOpencodeModels(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const raw of stdout.split('\n')) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const slash = value.indexOf('/');
    out.push({
      value,
      displayName: slash > 0 ? value.slice(slash + 1) : value,
      description: slash > 0 ? `OpenCode model on ${value.slice(0, slash)}` : 'OpenCode model',
    });
  }
  return out;
}

export async function findOpencodeBinary(): Promise<string | null> {
  return process.env['BACKCOURT_DUO_OPENCODE_PATH'] || (await which('opencode'));
}

/** OpenCode keeps its own credentials; we only check that it is installed and has a model to run. */
export async function resolveOpencodeAuth(): Promise<{ auth: AgentAuthSummary; models: ModelOption[]; binary: string | null }> {
  const binary = await findOpencodeBinary();
  if (!binary) {
    return {
      binary,
      models: [],
      auth: {
        mode: 'opencode',
        ready: false,
        hint: 'OpenCode is not installed. Install it (https://opencode.ai) or set BACKCOURT_DUO_OPENCODE_PATH, then run `opencode auth login` if needed.',
        warnings: [],
      },
    };
  }
  try {
    const r = await run(binary, ['models', '--standalone'], { timeoutMs: 60_000 });
    const models = parseOpencodeModels(r.stdout);
    if (models.length === 0) {
      return {
        binary,
        models,
        auth: {
          mode: 'opencode',
          ready: false,
          binary,
          method: 'opencode',
          hint: (r.stderr.trim().split('\n')[0] ?? '') || 'OpenCode has no models available. Run `opencode auth login` or choose a free model in OpenCode.',
          warnings: [],
        },
      };
    }
    return { binary, models, auth: { mode: 'opencode', ready: true, binary, method: 'opencode', warnings: [] } };
  } catch (err) {
    return {
      binary,
      models: [],
      auth: {
        mode: 'opencode',
        ready: false,
        binary,
        hint: err instanceof CommandNotFoundError ? err.message : `opencode models failed: ${(err as Error).message}`,
        warnings: [],
      },
    };
  }
}

export class OpencodeSession implements AgentRuntime {
  private child: ChildProcess | null = null;
  private queue: string[] = [];
  private busy = false;
  private ready = false;
  private generation = 0;
  private sessionId: string | null = null;
  private configDir: string | null = null;
  private model: string | undefined;
  /** Set by a reset; the next human message opens with the handoff. */
  private handoffReason: string | null = null;
  private progress: Progress = { phase: 'preparing', reviewed: 0 };
  private contextTokens = 0;
  private costBase = 0;
  /** Part id → chat row, so a part that is re-emitted updates its row instead of appending. */
  private partRows = new Map<string, string>();
  private aborted = false;

  constructor(private readonly store: ReviewStore, private readonly opts: OpencodeSessionOptions) {
    this.model = opts.model;
  }

  get running(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const gen = ++this.generation;
    this.store.setAgent({ backend: 'opencode' });
    this.store.setAgentStatus('starting');
    const { auth, models } = await resolveOpencodeAuth();
    if (gen !== this.generation) return;
    this.store.setAgent({ auth, models, backend: 'opencode' });
    if (!auth.ready) {
      this.ready = false;
      this.store.setAgentStatus(auth.mode === 'opencode' ? 'signed-out' : 'error', auth.hint ?? 'OpenCode is not ready');
      return;
    }
    this.ready = true;
    this.costBase = 0;
    this.store.setAgent({ usage: { ...this.store.agent.usage, costUSD: undefined } });
    this.publishModel();
    this.sessionId = this.store.resumeIdFor('opencode');
    if (this.sessionId) {
      this.store.setAgentStatus('waiting');
      this.store.system('🏀 Resumed the previous OpenCode conversation.');
    } else {
      if (!this.store.plan) this.store.setPhase('preparing');
      this.store.system('🏀 OpenCode is preparing the review…');
      this.send(kickoffPrompt(this.store.language));
    }
  }

  sendHuman(text: string): ChatMessage {
    const handoff = this.handoffReason ? `${handoffMessage(this.store, this.handoffReason)}\n\n` : '';
    const msg = this.store.appendChat(this.store.makeMessage('human', text));
    this.send(handoff + wrapHumanMessage(this.store, text));
    this.handoffReason = null;
    return msg;
  }

  private send(text: string): void {
    if (!this.ready) throw new Error('the agent is not running');
    this.queue.push(text);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy || !this.ready) return;
    this.busy = true;
    try {
      for (let prompt = this.queue.shift(); prompt !== undefined; prompt = this.queue.shift()) {
        if (!this.ready) break;
        await this.runTurn(prompt);
      }
    } finally {
      this.busy = false;
      if (this.ready && this.queue.length === 0) this.store.setAgentStatus('waiting');
    }
  }

  /** Run one `opencode run`; resolves when the child exits. */
  private async runTurn(prompt: string): Promise<void> {
    const gen = this.generation;
    const binary = await findOpencodeBinary();
    if (!binary) {
      this.fail('OpenCode is not installed.', true);
      return;
    }
    const dir = await this.writeConfig();
    if (dir === null || gen !== this.generation) return;
    const args = ['run', '--standalone', '--format', 'json', '--agent', OPENCODE_AGENT, '--auto'];
    if (this.model) args.push('-m', this.model);
    if (this.sessionId) args.push('--session', this.sessionId);
    args.push(prompt);

    this.store.setAgentStatus('thinking');
    this.progress = this.currentProgress();
    this.contextTokens = 0;
    this.partRows.clear();
    this.aborted = false;
    if (DEBUG) process.stderr.write(`[opencode] spawn ${binary} ${args.slice(0, -1).join(' ')} <prompt ${prompt.length} chars>\n`);
    let turnSessionId: string | null = null;
    let cost = 0;
    let stderr = '';
    const child = spawn(binary, args, {
      cwd: this.store.target.repoRoot,
      env: { ...process.env, OPENCODE_CONFIG: join(dir, CONFIG_FILE), OPENCODE_CONFIG_PROJECT_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      if (gen !== this.generation) return;
      if (DEBUG) process.stderr.write(`[opencode event] ${line.slice(0, 200)}\n`);
      const event = parseEvent(line);
      if (!event) return;
      if (event.sessionID) turnSessionId = event.sessionID;
      cost += this.handleEvent(event);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (DEBUG) process.stderr.write(`[opencode] ${d.toString()}`);
    });
    const code = await new Promise<number>((resolve) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          this.fail(`opencode not found at ${binary}`, true);
          resolve(127);
        } else {
          this.fail(err.message, true);
          resolve(1);
        }
      });
      // `close` (not `exit`) fires after stdout/stderr are fully drained, so no event is lost at the tail.
      child.on('close', (c) => resolve(c ?? 1));
    });
    this.child = null;
    if (gen !== this.generation) return;
    this.endTurn();

    if (this.aborted) {
      this.store.system('⏹ Stopped the current OpenCode turn.');
      this.store.setAgentStatus('waiting');
      return;
    }
    if (code !== 0) {
      const first = (stderr.trim().split('\n')[0] ?? '').slice(0, 300);
      // A resumed session can be gone (OpenCode's storage was cleared, a different HOME, …): start fresh next turn.
      if (this.sessionId && /session.*(not found|does not exist|unknown)|unknown session/i.test(stderr)) {
        this.sessionId = null;
        this.store.setAgentSessionId(null, 'opencode');
        this.store.system('💭 The previous OpenCode conversation is gone; the next message starts a new one (the review state is intact).');
      }
      const signIn = /not (logged in|authenticated)|auth|credential|provider/i.test(first);
      this.fail(first || `opencode exited with code ${code}`, !signIn);
      return;
    }
    if (turnSessionId) {
      this.sessionId = turnSessionId;
      // Saved once a turn completes: a restart then never resumes a turn that did not finish.
      this.store.setAgentSessionId(turnSessionId, 'opencode');
    }
    this.afterTurn(cost);
    this.store.setAgentStatus('waiting');
  }

  /** Apply one JSON event; returns its cost (0 for most). */
  private handleEvent(event: RunEvent): number {
    const part = event.part;
    if (!part) return 0;
    const partId = part.id ?? part.partID;
    if (DEBUG && event.type === 'text') process.stderr.write(`[opencode text] id=${String(partId)} len=${typeof part?.text === 'string' ? part.text.length : 'n/a'}\n`);
    if (event.type === 'text' && partId !== undefined && typeof part.text === 'string') {
      const existing = this.partRows.get(partId);
      if (existing) this.store.updateChat(existing, { text: part.text, streaming: false });
      else {
        const row = this.store.appendChat(this.store.makeMessage('agent', part.text));
        this.partRows.set(partId, row.id);
      }
      return 0;
    }
    if (event.type === 'tool_use' && partId !== undefined && typeof part.tool === 'string') {
      const state = part.state;
      if (state?.status !== 'completed' && state?.status !== 'error') return 0;
      const input = state.input ?? {};
      const tool = { ...describeTool(part.tool, input, this.store.target.repoRoot), ...(state.status === 'error' ? { isError: true } : {}) };
      const existing = this.partRows.get(partId);
      if (existing) this.store.updateChat(existing, { tool });
      else {
        const row = this.store.appendChat(this.store.makeMessage('tool', '', { tool }));
        this.partRows.set(partId, row.id);
      }
      return 0;
    }
    if (event.type === 'step_finish' && part?.tokens) {
      const t = part.tokens;
      this.contextTokens = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      if (DEBUG && (t.input ?? 0) + (t.output ?? 0) > 0) {
        process.stderr.write(`[opencode tokens] in=${compact(t.input ?? 0)} cache_read=${compact(t.cache?.read ?? 0)} out=${compact(t.output ?? 0)} cost=$${(part.cost ?? 0).toFixed(4)}\n`);
      }
      return part.cost ?? 0;
    }
    return 0;
  }

  private endTurn(): void {
    this.partRows.clear();
  }

  private currentProgress(): Progress {
    return { phase: this.store.phase, reviewed: this.store.reviewedCount };
  }

  private resetReason(was: Progress, now: Progress): string | null {
    if (now.phase !== was.phase) return `phase → ${now.phase}`;
    if (now.reviewed > was.reviewed) return 'file reviewed';
    if (this.contextTokens >= RESET_AT_TOKENS) return `context reached ${compact(this.contextTokens)} tokens`;
    return null;
  }

  /** Drop the OpenCode session at a boundary; the store is the memory that carries over. */
  private afterTurn(cost: number): void {
    this.costBase += cost;
    const usage = { ...this.store.agent.usage, ...(this.costBase > 0 ? { costUSD: this.costBase } : {}) };
    this.store.setAgent({ usage });
    if (!CONTEXT_RESET) return;
    const now = this.currentProgress();
    const reason = this.resetReason(this.progress, now);
    this.progress = now;
    if (!reason) return;
    this.sessionId = null;
    this.store.setAgentSessionId(null, 'opencode');
    this.handoffReason = reason;
    this.store.system(`🧹 Agent context reset (${reason}); it continues from the shared review state.`);
  }

  private fail(text: string, fatal: boolean): void {
    const firstLine = text.split('\n')[0] ?? text;
    const signIn = /not (logged in|authenticated)|please run .*login|credential/i.test(text);
    const status: AgentStatus = signIn ? 'signed-out' : fatal ? 'error' : 'waiting';
    this.store.setAgentStatus(status, signIn ? 'OpenCode asked to sign in again (run `opencode auth login`).' : fatal ? firstLine : undefined);
    this.store.system(signIn ? '🔐 OpenCode needs you to sign in again (`opencode auth login`).' : `${fatal ? '❌ Agent stopped' : '⚠️ Turn ended with an error'}: ${firstLine.slice(0, 300)}`);
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    this.publishModel();
    this.store.system(`🔁 Model switched to \`${model}\`.`);
  }

  /** OpenCode selects variants with `provider/model#variant`; there is no separate effort dial. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.store.setAgent({ effort: effort ?? undefined });
    this.store.system(`🧠 Effort is selected with the OpenCode model variant; \`${effort ?? 'default'}\` saved for Claude runs.`);
  }

  private publishModel(): void {
    if (!this.model) return;
    const option = this.store.agent.models?.find((m) => m.value === this.model);
    this.store.setAgent({ model: option?.value ?? this.model });
  }

  async interrupt(): Promise<void> {
    this.aborted = true;
    this.child?.kill('SIGTERM');
  }

  async stop(): Promise<void> {
    this.ready = false;
    ++this.generation;
    this.queue = [];
    this.child?.kill('SIGTERM');
    this.child = null;
    const dir = this.configDir;
    this.configDir = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async signIn(): Promise<void> {
    throw new Error('OpenCode uses its own credentials. Run `opencode auth login` in a terminal, then restart the agent.');
  }

  /** Write the per-session config (system prompt reflects the current language) and return its directory. */
  private async writeConfig(): Promise<string | null> {
    try {
      this.configDir ??= await mkdtemp(join(tmpdir(), 'backcourt-duo-opencode-'));
      const config = opencodeConfig({ system: reviewSystemPrompt(this.store.language, 'opencode'), mcpUrl: this.opts.mcpUrl, token: this.opts.token });
      await writeFile(join(this.configDir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      return this.configDir;
    } catch (err) {
      this.fail(`could not write the OpenCode config: ${(err as Error).message}`, true);
      return null;
    }
  }
}

function parseEvent(line: string): RunEvent | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text) as RunEvent;
  } catch {
    return null;
  }
}
