// `backcourt-duo doctor` — specs/commands/doctor.md
import { createServer } from 'node:net';
import { loadRepoContext, type RepoContext } from './context.js';
import { resolveAgentAuth, resolveAuthMode } from '../auth/agent.js';
import { style } from '../term.js';

export interface DoctorOptions {
  cwd: string;
  base?: string | undefined;
  pr?: number | undefined;
  port: number;
  auth?: string | undefined;
  json: boolean;
}

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  level: Level;
  message: string;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function repoChecks(ctx: RepoContext): Check[] {
  const { target, remote, github, pr } = ctx;
  const checks: Check[] = [
    { name: 'git', level: 'ok', message: `repository ${ctx.root}` },
    { name: 'base', level: 'ok', message: `base ${target.base} (merge-base ${target.mergeBaseSha.slice(0, 7)})` },
    { name: 'diff', level: ctx.diff.length ? 'ok' : 'warn', message: ctx.diff.length ? `${ctx.diff.length} changed files` : 'no changes vs base' },
  ];
  if (!remote || !github) {
    checks.push({ name: 'remote', level: 'warn', message: 'origin is not a GitHub remote — Submit will be unavailable' });
    return checks;
  }
  checks.push({ name: 'remote', level: 'ok', message: `${remote.host}/${remote.owner}/${remote.repo}` });
  const a = github.summary;
  checks.push({ name: 'github-auth', level: a.ready ? 'ok' : 'fail', message: a.ready ? `${a.source}${a.login ? ` (${a.login})` : ''}` : a.hint ?? 'not authenticated' });
  if (!github.token) return checks;
  if (ctx.prError) checks.push({ name: 'pr', level: 'warn', message: `PR lookup failed: ${ctx.prError}` });
  else if (!pr) checks.push({ name: 'pr', level: 'warn', message: 'no open PR for this branch (gh pr create, or --pr <n>)' });
  else {
    checks.push({ name: 'pr', level: 'ok', message: `#${pr.number} ${pr.title}` });
    const pushed = pr.headSha === target.headSha;
    checks.push({ name: 'pushed', level: pushed ? 'ok' : 'warn', message: pushed ? 'PR head matches the reviewed head' : `PR head ${pr.headSha.slice(0, 7)} ≠ local ${target.headSha.slice(0, 7)} — git push` });
  }
  return checks;
}

async function agentChecks(authFlag: string | undefined): Promise<Check[]> {
  try {
    const a = (await resolveAgentAuth(resolveAuthMode(authFlag))).summary;
    return [
      { name: 'agent-auth', level: a.ready ? 'ok' : 'fail', message: a.ready ? `${a.mode}: ${a.account ?? a.method ?? 'ready'}${a.subscription ? ` (${a.subscription})` : ''}` : `${a.mode}: ${a.hint ?? 'not ready'}` },
      ...a.warnings.map((w): Check => ({ name: 'agent-auth', level: 'warn', message: w })),
    ];
  } catch (err) {
    return [{ name: 'agent-auth', level: 'fail', message: (err as Error).message }];
  }
}

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  const major = Number(process.versions.node.split('.')[0]);
  // Independent checks run concurrently.
  const [repo, agent, free] = await Promise.all([
    loadRepoContext(opts).then(repoChecks, (err: Error): Check[] => [{ name: 'git', level: 'fail', message: err.message }]),
    agentChecks(opts.auth),
    portFree(opts.port),
  ]);
  const checks: Check[] = [
    { name: 'node', level: major >= 24 ? 'ok' : 'fail', message: `Node.js ${process.versions.node}${major >= 24 ? '' : ' — need >= 24 (use `nix develop`)'}` },
    ...repo,
    ...agent,
    { name: 'port', level: free ? 'ok' : 'fail', message: free ? `port ${opts.port} is free` : `port ${opts.port} is in use (--port)` },
  ];

  if (opts.json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    const icon = { ok: style.green('✔'), warn: style.yellow('⚠'), fail: style.red('✖') };
    for (const c of checks) console.log(`${icon[c.level]} ${c.name.padEnd(12)} ${c.message}`);
  }
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
