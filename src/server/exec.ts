import { execFile, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/** Run a command without a shell. Never throws on non-zero exit; throws only when the binary is missing. */
export function run(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        env: opts.env ?? process.env,
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new CommandNotFoundError(cmd));
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`command not found: ${command}`);
  }
}

/** Run a command with inherited stdio (interactive login flows). */
export function runInteractive(cmd: string, args: readonly string[], opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: opts.cwd });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new CommandNotFoundError(cmd) : err);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const whichCache = new Map<string, Promise<string | null>>();

/** Locate an executable on PATH (no shell). Memoised for the life of the process. */
export function which(name: string): Promise<string | null> {
  let hit = whichCache.get(name);
  if (!hit) {
    hit = findOnPath(name);
    whichCache.set(name, hit);
  }
  return hit;
}

async function findOnPath(name: string): Promise<string | null> {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
