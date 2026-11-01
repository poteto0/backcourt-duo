// Shared bootstrap for commands: repo, target, diff, GitHub, PR.
import * as git from '../git.js';
import { resolveGitHubAuth, type ResolvedGitHubAuth } from '../auth/github.js';
import { findPullForBranch, getPull } from '../github.js';
import type { DiffFile, PullRequestInfo, ReviewTarget } from '../../shared/types.js';

export interface RepoContext {
  root: string;
  gitDir: string;
  target: ReviewTarget;
  diff: DiffFile[];
  remote: git.RemoteRepo | null;
  github: ResolvedGitHubAuth | null;
  pr: PullRequestInfo | null;
  prError: string | null;
}

export interface RepoContextOptions {
  cwd: string;
  base?: string | undefined;
  head?: string | undefined;
  pr?: number | undefined;
  uncommitted?: boolean | undefined;
}

/** origin's GitHub coordinates, if any. */
export async function remoteRepo(root: string): Promise<git.RemoteRepo | null> {
  const url = await git.remoteUrl(root);
  return url ? git.parseRemoteUrl(url) : null;
}

async function lookupGitHub(root: string, branch: string | null, remote: git.RemoteRepo, prNumber: number | undefined) {
  const github = await resolveGitHubAuth(remote.host);
  let pr: PullRequestInfo | null = null;
  let prError: string | null = null;
  if (github.token) {
    try {
      if (prNumber !== undefined) pr = await getPull(github, remote.owner, remote.repo, prNumber);
      else if (branch) pr = await findPullForBranch(github, remote.owner, remote.repo, branch, root);
    } catch (err) {
      prError = err instanceof Error ? err.message : String(err);
    }
  }
  return { github, pr, prError };
}

export async function loadRepoContext(opts: RepoContextOptions): Promise<RepoContext> {
  const root = await git.repoRoot(opts.cwd);
  // `--pr <n>` reviews that PR's head as fetched from origin, unless the user pinned the head
  // (`--head`) or asked for the working tree (`--uncommitted`) — then it only picks where to post.
  if (opts.pr !== undefined && opts.head === undefined && !opts.uncommitted) return loadPullRequestContext(root, opts.pr, opts.base);

  const [gitDir, target, remote] = await Promise.all([
    git.gitDir(root),
    git.resolveTarget(root, { base: opts.base, head: opts.head, uncommitted: opts.uncommitted }),
    remoteRepo(root),
  ]);
  // The diff only needs the target; don't make it wait behind GitHub round trips.
  const [diff, gh] = await Promise.all([git.loadDiff(target), remote ? lookupGitHub(root, target.branch, remote, opts.pr) : null]);
  return { root, gitDir, target, diff, remote, github: gh?.github ?? null, pr: gh?.pr ?? null, prError: gh?.prError ?? null };
}

async function loadPullRequestContext(root: string, prNumber: number, base: string | undefined): Promise<RepoContext> {
  const [gitDir, remote] = await Promise.all([git.gitDir(root), remoteRepo(root)]);
  if (!remote) throw new git.GitError(`--pr ${prNumber} needs an "origin" remote on GitHub`);
  // The PR's base branch decides what to diff against, so GitHub has to answer before git can.
  // Without GitHub auth we can still fetch the head via git and diff against the default branch.
  const gh = await lookupGitHub(root, null, remote, prNumber);
  const head = await git.fetchPullRequest(root, prNumber, gh.pr?.baseRef ?? null);
  const target = await git.resolveTarget(root, {
    base: base ?? (gh.pr ? `origin/${gh.pr.baseRef}` : undefined),
    head,
    branch: gh.pr?.headRef ?? `pr-${prNumber}`,
  });
  const diff = await git.loadDiff(target);
  return { root, gitDir, target, diff, remote, github: gh.github, pr: gh.pr, prError: gh.prError };
}
