// Shared bootstrap for commands: repo, target, GitHub, PR.
import * as git from '../git.js';
import { resolveGitHubAuth, type ResolvedGitHubAuth } from '../auth/github.js';
import { findPullForBranch, getPull } from '../github.js';
import type { PullRequestInfo, ReviewTarget } from '../../shared/types.js';

export interface RepoContext {
  root: string;
  gitDir: string;
  target: ReviewTarget;
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

export async function loadRepoContext(opts: RepoContextOptions): Promise<RepoContext> {
  const root = await git.repoRoot(opts.cwd);
  const [gitDir, target, url] = await Promise.all([
    git.gitDir(root),
    git.resolveTarget(root, { base: opts.base, head: opts.head, uncommitted: opts.uncommitted }),
    git.remoteUrl(root),
  ]);
  const remote = url ? git.parseRemoteUrl(url) : null;
  let github: ResolvedGitHubAuth | null = null;
  let pr: PullRequestInfo | null = null;
  let prError: string | null = null;
  if (remote) {
    github = await resolveGitHubAuth(remote.host);
    if (github.token) {
      try {
        if (opts.pr !== undefined) pr = await getPull(github, remote.owner, remote.repo, opts.pr);
        else if (target.branch) pr = await findPullForBranch(github, remote.owner, remote.repo, target.branch, root);
      } catch (err) {
        prError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return { root, gitDir, target, remote, github, pr, prError };
}
