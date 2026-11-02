// User settings: ~/.backcourt-duo/config.json — specs/commands/start.md#設定ファイル
// Never holds credentials (AGENTS.md principle 6).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AccountDisplay } from '../shared/types.js';
import { AccountDisplaySchema } from './schemas.js';

/** Unknown keys are kept, so settings added by other features don't make the file invalid. */
const ConfigSchema = z.looseObject({
  privacy: z.looseObject({ account: AccountDisplaySchema.optional() }).optional(),
});
type Config = z.infer<typeof ConfigSchema>;

/** Problems are returned as `warnings` (surfaced via `AgentAuthSummary.warnings`), never thrown. */
interface Loaded<T> {
  value: T;
  warnings: string[];
}

/** A missing file is an empty config; a broken one is ignored with a warning. */
export function loadConfig(path = join(homedir(), '.backcourt-duo', 'config.json')): Loaded<Config> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { value: {}, warnings: [] };
  }
  try {
    return { value: ConfigSchema.parse(JSON.parse(text)), warnings: [] };
  } catch (err) {
    const why = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    return { value: {}, warnings: [`ignoring ${path}: ${why}`] };
  }
}

let cached: Loaded<Config> | undefined;
function userConfig(): Loaded<Config> {
  return (cached ??= loadConfig());
}

/** BACKCOURT_DUO_ACCOUNT > config `privacy.account` > 'hide'. */
export function resolveAccountDisplay(env: NodeJS.ProcessEnv = process.env, config: Loaded<Config> = userConfig()): Loaded<AccountDisplay> {
  const warnings = [...config.warnings];
  const raw = env['BACKCOURT_DUO_ACCOUNT'];
  if (raw) {
    const parsed = AccountDisplaySchema.safeParse(raw);
    if (parsed.success) return { value: parsed.data, warnings };
    warnings.push(`ignoring BACKCOURT_DUO_ACCOUNT="${raw}" (expected hide, mask or show)`);
  }
  return { value: config.value.privacy?.account ?? 'hide', warnings };
}
