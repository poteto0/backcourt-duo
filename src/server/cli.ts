// CLI dispatch — specs/commands/README.md
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { VERSION } from './version.js';

const HELP = `🏀 backcourt-duo v${VERSION} — pair-review a PR with a Claude agent, locally.

Usage
  backcourt-duo [start] [options]      start the review server (http://localhost:1200)
  backcourt-duo auth status [--json] [--show-account]
                                       show Claude + GitHub auth
  backcourt-duo auth login [--github] [--console]
                                       sign in (default: Claude subscription via Claude Code)
  backcourt-duo auth logout --claude   log Claude Code out
  backcourt-duo doctor [--json]        preflight checks

Start options
  --base <ref>         compare against (default: the default branch)
  --head <ref>         head ref (default: HEAD)
  --pr <number>        review this PR: fetch its head from origin, diff against its
                       base (default: the current branch and its PR)
  --uncommitted        include working-tree changes
  --port <n>           default 1200 (BACKCOURT_DUO_PORT)
  --host <addr>        loopback only (default 127.0.0.1)
  --auth <mode>        claude-code (default) | api-key   (BACKCOURT_DUO_AUTH)
  --model <id>         agent model (BACKCOURT_DUO_MODEL, config agent.model);
                       switchable from the chat header
  --no-open            do not open the browser
  --no-agent           diff + comments only
  --fresh              discard saved state for this branch
  -C, --cwd <dir>      repository directory

Settings (~/.backcourt-duo/config.json)
  privacy.account      Claude account email: hide (default) | mask | show
                       (BACKCOURT_DUO_ACCOUNT)
  agent.model          default agent model, e.g. "sonnet" (--model / BACKCOURT_DUO_MODEL win)
`;

const OPTIONS = {
  base: { type: 'string' },
  head: { type: 'string' },
  pr: { type: 'string' },
  uncommitted: { type: 'boolean', default: false },
  port: { type: 'string' },
  host: { type: 'string', default: '127.0.0.1' },
  auth: { type: 'string' },
  model: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
  'no-agent': { type: 'boolean', default: false },
  fresh: { type: 'boolean', default: false },
  cwd: { type: 'string', short: 'C' },
  json: { type: 'boolean', default: false },
  claude: { type: 'boolean', default: false },
  github: { type: 'boolean', default: false },
  console: { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  'show-account': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

function intOption(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`${(err as Error).message}\n\nRun \`backcourt-duo --help\`.`);
    return 64;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    console.log(VERSION);
    return 0;
  }
  if (v.help) {
    console.log(HELP);
    return 0;
  }
  const cwd = resolve(v.cwd ?? process.cwd());
  const [command = 'start', sub] = positionals;

  try {
    const port = intOption('port', v.port ?? process.env['BACKCOURT_DUO_PORT']) ?? 1200;
    switch (command) {
      case 'start': {
        const { startCommand } = await import('./commands/start.js');
        return await startCommand({
          cwd,
          base: v.base,
          head: v.head,
          pr: intOption('pr', v.pr),
          uncommitted: v.uncommitted,
          port,
          host: v.host,
          auth: v.auth,
          model: v.model,
          open: !v['no-open'],
          agent: !v['no-agent'],
          fresh: v.fresh,
        });
      }
      case 'auth': {
        const auth = await import('./commands/auth.js');
        const opts = { cwd, json: v.json, auth: v.auth, claude: v.claude, github: v.github, console: v.console, yes: v.yes, showAccount: v['show-account'] };
        if (sub === undefined || sub === 'status') return await auth.authStatus(opts);
        if (sub === 'login') return await auth.authLogin(opts);
        if (sub === 'logout') return await auth.authLogout(opts);
        throw new UsageError(`unknown auth subcommand "${sub}"`);
      }
      case 'doctor': {
        const { doctorCommand } = await import('./commands/doctor.js');
        return await doctorCommand({ cwd, base: v.base, pr: intOption('pr', v.pr), port, auth: v.auth, json: v.json });
      }
      case 'help':
        console.log(HELP);
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || (err instanceof Error && err.message.startsWith('unknown --auth'))) {
      console.error(`${err.message}\n\nRun \`backcourt-duo --help\`.`);
      return 64;
    }
    throw err;
  }
}
