// GitHub authentication — specs/sessions/github.md
import { run, which } from '../exec.js';
import type { GitHubAuthSummary } from '../../shared/types.js';

export interface ResolvedGitHubAuth {
  summary: GitHubAuthSummary;
  /** Secret. Never log or send to clients. */
  token: string | null;
  apiBase: string;
}

function apiBaseFor(host: string): string {
  const override = process.env['BACKCOURT_DUO_GITHUB_API_URL'];
  if (override) return override.replace(/\/$/, '');
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

export async function resolveGitHubAuth(host: string): Promise<ResolvedGitHubAuth> {
  const apiBase = apiBaseFor(host);
  let token: string | null = null;
  let source: GitHubAuthSummary['source'];
  if (process.env['GH_TOKEN']) {
    token = process.env['GH_TOKEN']!;
    source = 'GH_TOKEN';
  } else if (process.env['GITHUB_TOKEN']) {
    token = process.env['GITHUB_TOKEN']!;
    source = 'GITHUB_TOKEN';
  } else if (await which('gh')) {
    const r = await run('gh', ['auth', 'token', '--hostname', host], { timeoutMs: 10_000 });
    if (r.code === 0 && r.stdout.trim()) {
      token = r.stdout.trim();
      source = 'gh';
    }
  }
  if (!token) {
    return {
      token: null,
      apiBase,
      summary: { ready: false, host, hint: 'Run `gh auth login` (or `backcourt-duo auth login --github`), or set GH_TOKEN.' },
    };
  }
  const summary: GitHubAuthSummary = { ready: true, host };
  if (source) summary.source = source;
  {
    try {
      const res = await fetch(`${apiBase}/user`, { headers: ghHeaders(token), signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const user = (await res.json()) as { login?: string };
        if (user.login) summary.login = user.login;
      } else if (res.status === 401) {
        return { token: null, apiBase, summary: { ready: false, host, ...(source ? { source } : {}), hint: `GitHub token from ${source} was rejected (401). Re-run \`gh auth login\`.` } };
      }
    } catch {
      // offline: keep ready=true, login unknown
    }
  }
  return { token, apiBase, summary };
}

export function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'backcourt-duo',
  };
}
