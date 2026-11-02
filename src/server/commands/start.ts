// `backcourt-duo [start]` — specs/commands/start.md
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadRepoContext } from './context.js';
import { GitError } from '../git.js';
import { ReviewStore } from '../store.js';
import { LocalSession, isLoopbackHost } from '../auth/local.js';
import { resolveAuthMode } from '../auth/agent.js';
import { loadLanguage, resolveModel, type LanguageFlags } from '../config.js';
import { describeLanguage } from '../../shared/language.js';
import { AgentSession } from '../agent/session.js';
import { createApp } from '../http.js';
import { PACKAGE_ROOT, VERSION } from '../version.js';
import { style } from '../term.js';

export interface StartOptions {
  cwd: string;
  base?: string | undefined;
  head?: string | undefined;
  pr?: number | undefined;
  uncommitted?: boolean | undefined;
  port: number;
  host: string;
  auth?: string | undefined;
  model?: string | undefined;
  language: LanguageFlags;
  open: boolean;
  agent: boolean;
  fresh: boolean;
}

export async function startCommand(opts: StartOptions): Promise<number> {
  if (!isLoopbackHost(opts.host)) {
    console.error(`refusing to bind to non-loopback host "${opts.host}" (see specs/sessions/local-server.md)`);
    return 64;
  }
  const authMode = resolveAuthMode(opts.auth);

  let ctx;
  try {
    ctx = await loadRepoContext(opts);
  } catch (err) {
    if (err instanceof GitError) {
      console.error(style.red(`✖ ${err.message}`));
      return 2;
    }
    throw err;
  }
  const { target, diff } = ctx;
  console.log(`${style.bold('🏀 backcourt-duo')} ${style.dim(`v${VERSION}`)}`);
  console.log(`   ${style.dim('diff')}  ${target.base} ${style.dim(`(${target.mergeBaseSha.slice(0, 7)})`)} … ${target.head}${target.branch ? ` [${target.branch}]` : ''}${target.uncommitted ? ' + uncommitted' : ''}`);
  if (diff.length === 0) {
    console.log(style.yellow('   No changes between the base and head — nothing to review.'));
    return 0;
  }
  const adds = diff.reduce((n, f) => n + f.additions, 0);
  const dels = diff.reduce((n, f) => n + f.deletions, 0);
  console.log(`   ${style.dim('files')} ${diff.length} changed, ${style.green(`+${adds}`)} ${style.red(`-${dels}`)}`);
  if (ctx.pr) console.log(`   ${style.dim('PR')}    #${ctx.pr.number} ${ctx.pr.title} ${style.dim(ctx.pr.url)}`);
  else if (ctx.prError) console.log(style.yellow(`   PR lookup failed: ${ctx.prError}`));
  else if (ctx.github && !ctx.github.token) console.log(style.yellow(`   GitHub: ${ctx.github.summary.hint}`));
  else console.log(style.yellow('   No open PR for this branch — Submit will be disabled.'));

  const statePath = ReviewStore.statePathFor(ctx.gitDir, target.branch, target.headSha);
  const language = loadLanguage(opts.language, ctx.root);
  const store = new ReviewStore(target, diff, statePath, language.value);
  for (const w of language.warnings) console.log(style.yellow(`   ${w}`));
  console.log(`   ${style.dim('lang')}  ${describeLanguage(language.value)}`);
  if (!opts.fresh && (await store.load())) console.log(`   ${style.dim('state')} restored from ${statePath}`);
  store.pr = ctx.pr;
  store.github = { auth: ctx.github?.summary ?? null, owner: ctx.remote?.owner ?? null, repo: ctx.remote?.repo ?? null };

  const session = new LocalSession(opts.port);
  const agent = opts.agent ? new AgentSession(store, { authMode, model: resolveModel(opts.model) }) : null;
  if (!agent) store.setAgentStatus('disabled');

  const webRoot = join(PACKAGE_ROOT, 'dist', 'web');
  if (!existsSync(join(webRoot, 'index.html'))) console.log(style.yellow(`   web UI not built at ${webRoot} — run \`pnpm build\``));
  const app = createApp({ store, session, agent, github: ctx.github, authMode, webRoot });

  const server = await new Promise<ReturnType<typeof serve> | null>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => resolve(s));
    s.on('error', (err: NodeJS.ErrnoException) => {
      console.error(style.red(`✖ cannot listen on ${opts.host}:${opts.port}: ${err.code ?? err.message}`));
      resolve(null);
    });
  });
  if (!server) return 3;

  const url = session.launchUrl();
  console.log(`\n   ${style.bold('Open')} ${style.cyan(url)}\n`);
  if (opts.open) openBrowser(url);

  if (agent) {
    void agent.start().then(() => {
      const a = store.agent;
      if (a.auth) console.log(`   ${style.dim('agent')} ${a.auth.mode}${a.auth.ready ? ` ✔ ${a.auth.account ?? a.auth.method ?? ''}${a.auth.subscription ? ` (${a.auth.subscription})` : ''}` : style.yellow(` ✖ ${a.auth.hint ?? ''}`)}`);
    });
  }

  return new Promise<number>((resolve) => {
    let closing = false;
    const shutdown = async () => {
      if (closing) process.exit(130);
      closing = true;
      console.log(style.dim('\n   saving state and shutting down…'));
      await store.flush().catch(() => undefined);
      await agent?.stop();
      server.close();
      resolve(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // the URL is printed anyway
  }
}
