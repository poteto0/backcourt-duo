// `backcourt-duo auth status|login|logout` — specs/commands/auth.md
import { createInterface } from 'node:readline/promises';
import { findClaudeBinary, resolveAgentAuth, resolveAuthMode } from '../auth/agent.js';
import { findOpencodeBinary, resolveOpencodeAuth } from '../agent/opencode.js';
import type { AgentBackend } from '../../shared/types.js';
import { resolveGitHubAuth } from '../auth/github.js';
import { CommandNotFoundError, runInteractive, which } from '../exec.js';
import { repoRoot } from '../git.js';
import { remoteRepo } from './context.js';
import { resolveBackend } from '../config.js';
import { style } from '../term.js';

export interface AuthOptions {
  cwd: string;
  json: boolean;
  auth?: string | undefined;
  agent?: AgentBackend | undefined;
  claude: boolean;
  github: boolean;
  console: boolean;
  yes: boolean;
  showAccount: boolean;
}

async function githubHost(cwd: string): Promise<string> {
  try {
    return (await remoteRepo(await repoRoot(cwd)))?.host ?? 'github.com';
  } catch {
    return 'github.com';
  }
}

/** `--agent` > `--claude` > config `agent.backend` > claude (the saved default, #48). */
function backendFor(opts: AuthOptions): AgentBackend {
  if (opts.agent) return opts.agent;
  if (opts.claude) return 'claude';
  return resolveBackend(undefined).value;
}

export async function authStatus(opts: AuthOptions): Promise<number> {
  const backend = backendFor(opts);
  const [agent, gh] = await Promise.all([
    backend === 'opencode' ? resolveOpencodeAuth().then((r) => r.auth) : resolveAgentAuth(resolveAuthMode(opts.auth), opts.showAccount ? 'show' : undefined).then((r) => r.summary),
    githubHost(opts.cwd).then((h) => resolveGitHubAuth(h)),
  ]);
  const a = agent;
  const g = gh.summary;
  if (opts.json) {
    console.log(JSON.stringify({ backend, agent: a, github: g }, null, 2));
  } else {
    const mark = (ok: boolean) => (ok ? style.green('✔') : style.red('✖'));
    console.log(style.bold(backend === 'opencode' ? 'Agent (OpenCode)' : 'Agent (Claude)'));
    console.log(`  mode:    ${a.mode}`);
    console.log(`  status:  ${mark(a.ready)} ${a.ready ? `ready${a.method ? ` (${a.method}${a.subscription ? `, ${a.subscription}` : ''})` : ''}${a.account ? `  ${a.account}` : ''}` : 'not ready'}`);
    if (a.binary) console.log(`  binary:  ${a.binary}`);
    if (a.hint && !a.ready) console.log(`  hint:    ${a.hint}`);
    for (const w of a.warnings) console.log(`  ${style.yellow('note:')}    ${w}`);
    console.log(style.bold('GitHub'));
    console.log(`  host:    ${g.host}`);
    console.log(`  status:  ${mark(g.ready)} ${g.ready ? `${g.source ?? ''}${g.login ? `  account: ${g.login}` : ''}` : 'not ready'}`);
    if (g.hint && !g.ready) console.log(`  hint:    ${g.hint}`);
  }
  if (a.ready && g.ready) return 0;
  if (!a.ready && !g.ready) return 12;
  return a.ready ? 11 : 10;
}

export async function authLogin(opts: AuthOptions): Promise<number> {
  if (opts.github) {
    if (!(await which('gh'))) {
      console.error('gh is not installed. Install GitHub CLI (https://cli.github.com) or export GH_TOKEN=<token with repo scope>.');
      return 1;
    }
    return runInteractive('gh', ['auth', 'login'], { cwd: opts.cwd });
  }
  if (backendFor(opts) === 'opencode') return opencodeAuth(opts.cwd, 'login');
  const binary = await findClaudeBinary();
  if (!binary) {
    console.error('Claude Code is not installed. Install it with `npm i -g @anthropic-ai/claude-code`, then run this again.');
    return 1;
  }
  try {
    return await runInteractive(binary, ['auth', 'login', opts.console ? '--console' : '--claudeai']);
  } catch (err) {
    if (err instanceof CommandNotFoundError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

export async function authLogout(opts: AuthOptions): Promise<number> {
  if (opts.github) {
    console.error('backcourt-duo does not manage GitHub logins; use `gh auth logout`.');
    return 64;
  }
  if (backendFor(opts) === 'opencode') {
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('This logs OpenCode itself out on this machine. Continue? [y/N] ');
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) return 1;
    }
    return opencodeAuth(opts.cwd, 'logout');
  }
  const binary = await findClaudeBinary();
  if (!binary) {
    console.error('Claude Code is not installed.');
    return 1;
  }
  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('This logs Claude Code itself out on this machine. Continue? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return 1;
  }
  return runInteractive(binary, ['auth', 'logout']);
}

/** Delegate `auth login|logout` to OpenCode's own credential store. */
async function opencodeAuth(cwd: string, sub: 'login' | 'logout'): Promise<number> {
  const binary = await findOpencodeBinary();
  if (!binary) {
    console.error('OpenCode is not installed. Install it (https://opencode.ai) or set BACKCOURT_DUO_OPENCODE_PATH.');
    return 1;
  }
  try {
    return await runInteractive(binary, ['auth', sub], { cwd });
  } catch (err) {
    if (err instanceof CommandNotFoundError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}
