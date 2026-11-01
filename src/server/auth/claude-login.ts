// Subscription sign-in from the UI — specs/sessions/agent-claude-code.md "サインイン（サブスク）"
import { spawn } from 'node:child_process';
import { findClaudeBinary } from './agent.js';

let inFlight: Promise<number> | null = null;

export function claudeLoginInProgress(): boolean {
  return inFlight !== null;
}

/**
 * Spawn `claude auth login --claudeai`. Output is NOT forwarded anywhere (it may contain URLs/codes);
 * Claude Code opens the browser itself. Resolves with the exit code.
 */
export async function startClaudeLogin(): Promise<{ done: Promise<number> }> {
  if (inFlight) throw new LoginBusyError();
  const binary = await findClaudeBinary();
  if (!binary) throw new Error('Claude Code (`claude`) is not installed; install it, then run `backcourt-duo auth login`.');
  const env = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  inFlight = new Promise<number>((resolve) => {
    const child = spawn(binary, ['auth', 'login', '--claudeai'], { stdio: ['ignore', 'ignore', 'ignore'], env });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000);
    child.on('error', () => resolve(1));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  }).finally(() => {
    inFlight = null;
  });
  return { done: inFlight };
}

export class LoginBusyError extends Error {
  constructor() {
    super('a Claude sign-in is already in progress');
  }
}
