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

async function lookupGitHub(root: string, target: ReviewTarget, remote: git.RemoteRepo, prNumber: number | undefined) {
  const github = await resolveGitHubAuth(remote.host);
  let pr: PullRequestInfo | null = null;
  let prError: string | null = null;
  if (github.token) {
    try {
      if (prNumber !== undefined) pr = await getPull(github, remote.owner, remote.repo, prNumber);
      else if (target.branch) pr = await findPullForBranch(github, remote.owner, remote.repo, target.branch, root);
    } catch (err) {
      prError = err instanceof Error ? err.message : String(err);
    }
  }
  return { github, pr, prError };
}

export async function loadRepoContext(opts: RepoContextOptions): Promise<RepoContext> {
  const root = await git.repoRoot(opts.cwd);
  const [gitDir, target, remote] = await Promise.all([
    git.gitDir(root),
    git.resolveTarget(root, { base: opts.base, head: opts.head, uncommitted: opts.uncommitted }),
    remoteRepo(root),
  ]);
  // The diff only needs the target; don't make it wait behind GitHub round trips.
  const [diff, gh] = await Promise.all([git.loadDiff(target), remote ? lookupGitHub(root, target, remote, opts.pr) : null]);
  return { root, gitDir, target, diff, remote, github: gh?.github ?? null, pr: gh?.pr ?? null, prError: gh?.prError ?? null };
}
