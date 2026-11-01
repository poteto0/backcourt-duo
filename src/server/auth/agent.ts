// Agent (Claude) authentication — specs/sessions/agent-claude-code.md, agent-api-key.md
import { run, which, CommandNotFoundError } from '../exec.js';
import type { AgentAuthMode, AgentAuthSummary } from '../../shared/types.js';
import { VERSION } from '../version.js';

export interface ResolvedAgentAuth {
  summary: AgentAuthSummary;
  /** Environment for the Claude Code subprocess. Contains secrets — never log or send to clients. */
  env: Record<string, string | undefined>;
  /** Claude Code executable to use; undefined = SDK bundled binary. */
  executable: string | undefined;
}

export function resolveAuthMode(flag: string | undefined): AgentAuthMode {
  const raw = flag ?? process.env['BACKCOURT_DUO_AUTH'] ?? 'claude-code';
  if (raw === 'claude-code' || raw === 'api-key') return raw;
  throw new Error(`unknown --auth mode "${raw}" (expected claude-code or api-key)`);
}

export async function findClaudeBinary(): Promise<string | null> {
  const override = process.env['BACKCOURT_DUO_CLAUDE_PATH'];
  if (override) return override;
  return which('claude');
}

export function maskSecret(v: string): string {
  if (v.length <= 12) return '…';
  return `${v.slice(0, 7)}…${v.slice(-4)}`;
}

interface ClaudeAuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  subscriptionType?: string;
}

export async function claudeAuthStatus(binary: string): Promise<{ ok: true; status: ClaudeAuthStatusJson } | { ok: false; error: string }> {
  try {
    const env = { ...process.env };
    delete env['ANTHROPIC_API_KEY'];
    delete env['ANTHROPIC_AUTH_TOKEN'];
    const r = await run(binary, ['auth', 'status', '--json'], { timeoutMs: 10_000, env });
    const text = r.stdout.trim();
    if (text.startsWith('{')) return { ok: true, status: JSON.parse(text) as ClaudeAuthStatusJson };
    return { ok: false, error: (r.stderr || r.stdout).trim().split('\n')[0] ?? `exit ${r.code}` };
  } catch (err) {
    if (err instanceof CommandNotFoundError) return { ok: false, error: `claude not found at ${binary}` };
    return { ok: false, error: String(err) };
  }
}

function baseEnv(): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `backcourt-duo/${VERSION}` };
}

async function resolveClaudeCode(): Promise<ResolvedAgentAuth> {
  const warnings: string[] = [];
  const env = baseEnv();
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
    if (env[key]) {
      warnings.push(`${key} is set but ignored in claude-code mode (use --auth api-key to use it)`);
      delete env[key];
    }
  }
  const binary = await findClaudeBinary();
  if (!binary) {
    return {
      env,
      executable: undefined,
      summary: {
        mode: 'claude-code',
        ready: false,
        hint: 'Claude Code is not installed. Install it (npm i -g @anthropic-ai/claude-code) and run `backcourt-duo auth login`, or use --auth api-key.',
        warnings,
      },
    };
  }
  const st = await claudeAuthStatus(binary);
  if (!st.ok) {
    return { env, executable: binary, summary: { mode: 'claude-code', ready: false, binary, hint: st.error, warnings } };
  }
  const s = st.status;
  const summary: AgentAuthSummary = { mode: 'claude-code', ready: s.loggedIn === true, binary, warnings };
  if (s.authMethod) summary.method = s.apiProvider && s.apiProvider !== 'firstParty' ? s.apiProvider : s.authMethod;
  if (s.email) summary.account = s.email;
  if (s.subscriptionType) summary.subscription = s.subscriptionType;
  if (!summary.ready) summary.hint = 'Sign in with Claude (subscription): click “Sign in with Claude” or run `backcourt-duo auth login`.';
  return { env, executable: binary, summary };
}

function resolveApiKey(): ResolvedAgentAuth {
  const env = baseEnv();
  const warnings: string[] = [];
  delete env['CLAUDE_CODE_USE_BEDROCK'];
  delete env['CLAUDE_CODE_USE_VERTEX'];
  const candidates: Array<[string, 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN']> = [
    ['BACKCOURT_DUO_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
    ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  ];
  for (const [source, target] of candidates) {
    const value = process.env[source];
    if (!value) continue;
    delete env['ANTHROPIC_API_KEY'];
    delete env['ANTHROPIC_AUTH_TOKEN'];
    env[target] = value;
    if (env['ANTHROPIC_BASE_URL']) warnings.push(`using ANTHROPIC_BASE_URL=${env['ANTHROPIC_BASE_URL']}`);
    return {
      env,
      executable: undefined,
      summary: { mode: 'api-key', ready: true, method: source, account: maskSecret(value), warnings },
    };
  }
  return {
    env,
    executable: undefined,
    summary: { mode: 'api-key', ready: false, hint: 'Set ANTHROPIC_API_KEY (or use --auth claude-code)', warnings },
  };
}

export async function resolveAgentAuth(mode: AgentAuthMode): Promise<ResolvedAgentAuth> {
  if (mode === 'api-key') {
    const r = resolveApiKey();
    // Prefer the user's installed claude binary even in api-key mode (same version they use), if present.
    r.executable = (await findClaudeBinary()) ?? undefined;
    if (r.executable) r.summary.binary = r.executable;
    return r;
  }
  return resolveClaudeCode();
}

/** Errors coming back from the agent that mean "you need to sign in again". */
export function looksLikeAuthError(text: string): boolean {
  return /(authenticat|not logged in|please run \/login|log ?in|invalid api key|401|oauth token)/i.test(text);
}
