// Subscription sign-in from the UI — specs/sessions/agent-claude-code.md "サインイン（サブスク）"
import { claudeCodeEnv, findClaudeBinary } from './agent.js';
import { run } from '../exec.js';

let inFlight = false;

/**
 * Start `claude auth login --claudeai` (Claude Code opens the browser itself). Its output is discarded — it may
 * contain URLs/codes. Rejects right away if a sign-in is running or claude is missing; `done` resolves with the exit code.
 */
export async function startClaudeLogin(): Promise<{ done: Promise<number> }> {
  if (inFlight) throw new LoginBusyError();
  const binary = await findClaudeBinary();
  if (!binary) throw new Error('Claude Code (`claude`) is not installed; install it, then run `backcourt-duo auth login`.');
  inFlight = true;
  const done = run(binary, ['auth', 'login', '--claudeai'], { env: claudeCodeEnv(), timeoutMs: 10 * 60_000 })
    .then((r) => r.code)
    .finally(() => {
      inFlight = false;
    });
  return { done };
}

export class LoginBusyError extends Error {
  constructor() {
    super('a Claude sign-in is already in progress');
  }
}
