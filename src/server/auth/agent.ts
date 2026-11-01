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

/** Credentials that would shadow the Claude Code sign-in (specs/sessions/agent-claude-code.md). */
const SHADOWING_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** Environment for any `claude` subprocess that must use the user's Claude Code sign-in. */
export function claudeCodeEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: `backcourt-duo/${VERSION}` };
  for (const key of SHADOWING_KEYS) delete env[key];
  return env;
}

function maskSecret(v: string): string {
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

async function claudeAuthStatus(binary: string): Promise<{ ok: true; status: ClaudeAuthStatusJson } | { ok: false; error: string }> {
  try {
    const r = await run(binary, ['auth', 'status', '--json'], { timeoutMs: 10_000, env: claudeCodeEnv() });
    const text = r.stdout.trim();
    if (text.startsWith('{')) return { ok: true, status: JSON.parse(text) as ClaudeAuthStatusJson };
    return { ok: false, error: (r.stderr || r.stdout).trim().split('\n')[0] ?? `exit ${r.code}` };
  } catch (err) {
    if (err instanceof CommandNotFoundError) return { ok: false, error: `claude not found at ${binary}` };
    return { ok: false, error: String(err) };
  }
}

async function resolveClaudeCode(): Promise<ResolvedAgentAuth> {
  const warnings = SHADOWING_KEYS.filter((key) => process.env[key]).map((key) => `${key} is set but ignored in claude-code mode (use --auth api-key to use it)`);
  const env = claudeCodeEnv();
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
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `backcourt-duo/${VERSION}` };
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

/** Typed SDK errors that mean "sign in again" rather than "try again". */
const SIGN_IN_ERRORS = new Set<string>(['authentication_failed', 'oauth_org_not_allowed']);

export function isSignInError(code: string | undefined): boolean {
  return code !== undefined && SIGN_IN_ERRORS.has(code);
}

/** Fallback for untyped failures (a thrown process error or an error result's text). */
export function looksLikeAuthError(text: string): boolean {
  return /(not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_failed)/i.test(text);
}
