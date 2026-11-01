import { basename } from 'node:path';
import { run, which } from './exec.js';
import { parseUnifiedDiff } from './diff.js';
import type { DiffFile, ReviewTarget } from '../shared/types.js';

export class GitError extends Error {}

async function git(cwd: string, args: string[], allowFail = false): Promise<string> {
  const r = await run('git', args, { cwd });
  if (r.code !== 0 && !allowFail) throw new GitError(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
}

export async function repoRoot(cwd: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel'], true);
  if (!out) throw new GitError(`not a git repository: ${cwd}`);
  return out;
}

export async function gitDir(root: string): Promise<string> {
  return git(root, ['rev-parse', '--absolute-git-dir']);
}

export async function currentBranch(root: string): Promise<string | null> {
  const b = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  return b || null;
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  const r = await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
  return r.code === 0;
}

export async function revParse(root: string, ref: string): Promise<string> {
  const sha = await git(root, ['rev-parse', '--verify', `${ref}^{commit}`], true);
  if (!sha) throw new GitError(`cannot resolve ref: ${ref}`);
  return sha;
}

/** Resolve the default branch as a ref usable locally (specs/commands/start.md). */
export async function resolveDefaultBase(root: string): Promise<string> {
  const sym = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], true);
  if (sym && (await refExists(root, sym))) return sym;
  if (await which('gh')) {
    const r = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], { cwd: root, timeoutMs: 10_000 });
    const name = r.stdout.trim();
    if (r.code === 0 && name) {
      if (await refExists(root, `origin/${name}`)) return `origin/${name}`;
      if (await refExists(root, name)) return name;
    }
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(root, candidate)) return candidate;
  }
  throw new GitError('could not determine the default branch; pass --base <ref> (or run `git remote set-head origin -a`)');
}

export async function remoteUrl(root: string, remote = 'origin'): Promise<string | null> {
  const url = await git(root, ['remote', 'get-url', remote], true);
  return url || null;
}

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
}

export function parseRemoteUrl(url: string): RemoteRepo | null {
  const patterns = [
    /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)(?::\d+)?[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^https?:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  ];
  for (const re of patterns) {
    const m = re.exec(url.trim());
    if (m) return { host: m[1]!, owner: m[2]!, repo: m[3]! };
  }
  return null;
}

export interface TargetOptions {
  base?: string | undefined;
  head?: string | undefined;
  uncommitted?: boolean | undefined;
  /** Branch name to record when `head` is not a branch (e.g. a fetched PR ref). */
  branch?: string | undefined;
}

/** Local ref that holds a fetched PR head. Kept out of refs/heads so it never clobbers a user branch. */
export function pullRequestRef(number: number): string {
  return `refs/backcourt-duo/pr/${number}`;
}

/**
 * Fetch a PR's head (`refs/pull/<n>/head`, which also covers fork PRs) from origin, plus its base branch
 * when known, so the PR can be reviewed without checking it out. Returns the local ref of the PR head.
 */
export async function fetchPullRequest(root: string, number: number, baseRef: string | null): Promise<string> {
  const ref = pullRequestRef(number);
  const refspecs = [`+refs/pull/${number}/head:${ref}`];
  if (baseRef) refspecs.push(`+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`);
  const r = await run('git', ['fetch', '--no-tags', '--quiet', 'origin', ...refspecs], {
    cwd: root,
    timeoutMs: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.code !== 0) throw new GitError(`could not fetch PR #${number} from origin: ${r.stderr.trim() || r.stdout.trim()}`);
  return ref;
}

export async function resolveTarget(root: string, opts: TargetOptions): Promise<ReviewTarget> {
  const base = opts.base ?? (await resolveDefaultBase(root));
  const head = opts.head ?? 'HEAD';
  const [baseSha, headSha] = await Promise.all([revParse(root, base), revParse(root, head)]);
  const mergeBaseSha = await git(root, ['merge-base', baseSha, headSha], true);
  if (!mergeBaseSha) throw new GitError(`no merge base between ${base} and ${head}`);
  const branch = opts.branch ?? (head === 'HEAD' ? await currentBranch(root) : head.replace(/^origin\//, ''));
  return {
    base,
    baseSha,
    head,
    headSha,
    mergeBaseSha,
    uncommitted: opts.uncommitted ?? false,
    branch,
    repoRoot: root,
    repoName: basename(root),
  };
}

export async function loadDiff(target: ReviewTarget): Promise<DiffFile[]> {
  const args = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', target.mergeBaseSha];
  if (!target.uncommitted) args.push(target.headSha);
  const out = await git(target.repoRoot, args);
  const files = parseUnifiedDiff(out);
  if (target.uncommitted) {
    // Untracked files are invisible to `git diff`; include them as additions.
    const untracked = (await git(target.repoRoot, ['ls-files', '--others', '--exclude-standard'], true)).split('\n').filter(Boolean);
    const added = await Promise.all(
      untracked.map(async (path) => {
        const r = await run('git', ['diff', '--no-color', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', '/dev/null', path], { cwd: target.repoRoot });
        return parseUnifiedDiff(r.stdout).map((f) => ({ ...f, path, status: 'added' as const }));
      }),
    );
    files.push(...added.flat());
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
