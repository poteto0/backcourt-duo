// `backcourt-duo doctor` — specs/commands/doctor.md
import { createServer } from 'node:net';
import * as git from '../git.js';
import { resolveGitHubAuth } from '../auth/github.js';
import { resolveAgentAuth, resolveAuthMode } from '../auth/agent.js';
import { findPullForBranch, getPull } from '../github.js';
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

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, level: Level, message: string) => checks.push({ name, level, message });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 24 ? 'ok' : 'fail', `Node.js ${process.versions.node}${major >= 24 ? '' : ' — need >= 24 (use `nix develop`)'}`);

  let root: string | null = null;
  try {
    root = await git.repoRoot(opts.cwd);
    add('git', 'ok', `repository ${root}`);
  } catch (err) {
    add('git', 'fail', (err as Error).message);
  }

  if (root) {
    let target: Awaited<ReturnType<typeof git.resolveTarget>> | null = null;
    try {
      target = await git.resolveTarget(root, { base: opts.base });
      add('base', 'ok', `base ${target.base} (merge-base ${target.mergeBaseSha.slice(0, 7)})`);
    } catch (err) {
      add('base', 'fail', (err as Error).message);
    }
    if (target) {
      const files = await git.loadDiff(target);
      add('diff', files.length ? 'ok' : 'warn', files.length ? `${files.length} changed files` : 'no changes vs base');
    }
    const url = await git.remoteUrl(root);
    const remote = url ? git.parseRemoteUrl(url) : null;
    if (!remote) {
      add('remote', 'warn', 'origin is not a GitHub remote — Submit will be unavailable');
    } else {
      add('remote', 'ok', `${remote.host}/${remote.owner}/${remote.repo}`);
      const gh = await resolveGitHubAuth(remote.host);
      add('github-auth', gh.summary.ready ? 'ok' : 'fail', gh.summary.ready ? `${gh.summary.source}${gh.summary.login ? ` (${gh.summary.login})` : ''}` : gh.summary.hint ?? 'not authenticated');
      if (gh.token && target) {
        try {
          const pr = opts.pr !== undefined ? await getPull(gh, remote.owner, remote.repo, opts.pr) : target.branch ? await findPullForBranch(gh, remote.owner, remote.repo, target.branch, root) : null;
          if (!pr) add('pr', 'warn', 'no open PR for this branch (gh pr create, or --pr <n>)');
          else {
            add('pr', 'ok', `#${pr.number} ${pr.title}`);
            add('pushed', pr.headSha === target.headSha ? 'ok' : 'warn', pr.headSha === target.headSha ? 'PR head matches local HEAD' : `PR head ${pr.headSha.slice(0, 7)} ≠ local ${target.headSha.slice(0, 7)} — git push`);
          }
        } catch (err) {
          add('pr', 'warn', `PR lookup failed: ${(err as Error).message}`);
        }
      }
    }
  }

  try {
    const agent = await resolveAgentAuth(resolveAuthMode(opts.auth));
    const a = agent.summary;
    add('agent-auth', a.ready ? 'ok' : 'fail', a.ready ? `${a.mode}: ${a.account ?? a.method ?? 'ready'}${a.subscription ? ` (${a.subscription})` : ''}` : `${a.mode}: ${a.hint ?? 'not ready'}`);
    for (const w of a.warnings) add('agent-auth', 'warn', w);
  } catch (err) {
    add('agent-auth', 'fail', (err as Error).message);
  }

  const free = await portFree(opts.port);
  add('port', free ? 'ok' : 'fail', free ? `port ${opts.port} is free` : `port ${opts.port} is in use (--port)`);

  if (opts.json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    const icon = { ok: style.green('✔'), warn: style.yellow('⚠'), fail: style.red('✖') };
    for (const c of checks) console.log(`${icon[c.level]} ${c.name.padEnd(12)} ${c.message}`);
  }
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
