// PR lookup and review submission — specs/sessions/github.md
import { ghHeaders, type ResolvedGitHubAuth } from './auth/github.js';
import { run, which } from './exec.js';
import type { PendingComment, PullRequestInfo, ReviewEvent } from '../shared/types.js';

export const AGENT_FOOTER = '\n\n<sub>🤖 drafted with backcourt-duo</sub>';

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly details: string[] = []) {
    super(message);
  }
}

interface RawPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  draft?: boolean;
  user?: { login?: string };
  base: { ref: string };
  head: { ref: string; sha: string };
}

function toInfo(p: RawPull): PullRequestInfo {
  return {
    number: p.number,
    url: p.html_url,
    title: p.title,
    body: p.body ?? '',
    baseRef: p.base.ref,
    headRef: p.head.ref,
    headSha: p.head.sha,
    author: p.user?.login ?? '',
    draft: p.draft ?? false,
  };
}

async function gh<T>(auth: ResolvedGitHubAuth, method: string, path: string, body?: unknown): Promise<T> {
  if (!auth.token) throw new GitHubError('not authenticated with GitHub', 401);
  const init: RequestInit = { method, headers: { ...ghHeaders(auth.token), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${auth.apiBase}${path}`, init);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const j = (json ?? {}) as { message?: string; errors?: Array<string | { message?: string; code?: string; field?: string }> };
    const details = (j.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message ?? [e.field, e.code].filter(Boolean).join(': ')));
    throw new GitHubError(j.message ?? `GitHub API ${res.status}`, res.status, details);
  }
  return json as T;
}

export async function getPull(auth: ResolvedGitHubAuth, owner: string, repo: string, number: number): Promise<PullRequestInfo> {
  return toInfo(await gh<RawPull>(auth, 'GET', `/repos/${owner}/${repo}/pulls/${number}`));
}

export async function findPullForBranch(auth: ResolvedGitHubAuth, owner: string, repo: string, branch: string, cwd: string): Promise<PullRequestInfo | null> {
  const q = new URLSearchParams({ head: `${owner}:${branch}`, state: 'open', per_page: '5' });
  const pulls = await gh<RawPull[]>(auth, 'GET', `/repos/${owner}/${repo}/pulls?${q}`);
  if (pulls[0]) return toInfo(pulls[0]);
  // Fork PRs: let gh figure out the head repository.
  if (await which('gh')) {
    const r = await run('gh', ['pr', 'view', '--json', 'number', '-q', '.number'], { cwd, timeoutMs: 15_000 });
    const n = Number(r.stdout.trim());
    if (r.code === 0 && Number.isInteger(n) && n > 0) return getPull(auth, owner, repo, n);
  }
  return null;
}

export interface SubmitInput {
  event: ReviewEvent;
  body: string;
  comments: PendingComment[];
  commitId: string;
}

export function buildReviewPayload(input: SubmitInput) {
  return {
    commit_id: input.commitId,
    event: input.event,
    body: input.body,
    comments: input.comments.map((c) => {
      const body = c.author === 'agent' ? `${c.body}${AGENT_FOOTER}` : c.body;
      const out: Record<string, unknown> = { path: c.path, line: c.line, side: c.side, body };
      if (c.startLine !== undefined && c.startLine !== c.line) {
        out['start_line'] = c.startLine;
        out['start_side'] = c.side;
      }
      return out;
    }),
  };
}

export async function submitReview(auth: ResolvedGitHubAuth, owner: string, repo: string, number: number, input: SubmitInput): Promise<{ url: string }> {
  if ((input.event === 'REQUEST_CHANGES' || input.event === 'COMMENT') && input.comments.length === 0 && !input.body.trim()) {
    throw new GitHubError('A review body is required when there are no comments.', 422);
  }
  const res = await gh<{ html_url: string }>(auth, 'POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, buildReviewPayload(input));
  return { url: res.html_url };
}
