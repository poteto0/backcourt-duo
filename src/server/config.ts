// User settings: ~/.backcourt-duo/config.json, repository settings: <repo>/.backcourt-duo.json
// — specs/commands/start.md#設定ファイル. Never holds credentials (AGENTS.md principle 6).
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AccountDisplay, EffortLevel } from '../shared/types.js';
import { canonicalLanguageTag, LANGUAGE_TAG_HINT, languageSetting, languageSettings, type LanguageSetting, type LanguageSettings } from '../shared/language.js';
import { AccountDisplaySchema, EffortSchema, LanguageTagSchema } from './schemas.js';
import { writeFileAtomic } from './fs.js';

/** A plain string sets both. */
const LanguageSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { conversation: v, review: v } : v),
  z.looseObject({ conversation: LanguageTagSchema.optional(), review: LanguageTagSchema.optional() }),
);

/** Unknown keys are kept, so settings added by other features don't make the file invalid. */
const ConfigSchema = z.looseObject({
  privacy: z.looseObject({ account: AccountDisplaySchema.optional() }).optional(),
  agent: z.looseObject({ model: z.string().min(1).optional(), effort: EffortSchema.optional() }).optional(),
  language: LanguageSchema.optional(),
});
type Config = z.infer<typeof ConfigSchema>;

/** `<repo>/.backcourt-duo.json` only pins the review language (chat language is personal). */
const RepoConfigSchema = z.looseObject({ language: z.strictObject({ review: LanguageTagSchema.optional() }).optional() });
type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const REPO_CONFIG_FILE = '.backcourt-duo.json';

/** Problems are returned as `warnings` (surfaced via `AgentAuthSummary.warnings`), never thrown. */
interface Loaded<T> {
  value: T;
  warnings: string[];
}

export const USER_CONFIG_PATH = join(homedir(), '.backcourt-duo', 'config.json');

/** A missing file is an empty config; a broken one is ignored with a warning. */
export function loadConfig(path = USER_CONFIG_PATH): Loaded<Config> {
  return loadJson(path, ConfigSchema);
}

function loadJson<T extends object>(path: string, schema: z.ZodType<T>): Loaded<T | Record<string, never>> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { value: {}, warnings: [] };
  }
  try {
    return { value: schema.parse(JSON.parse(text)), warnings: [] };
  } catch (err) {
    const why = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    return { value: {}, warnings: [`ignoring ${path}: ${why}`] };
  }
}

let cached: Loaded<Config> | undefined;
function userConfig(): Loaded<Config> {
  return (cached ??= loadConfig());
}

/** An enum-valued env var; a bad value is skipped with a warning. */
function envEnum<T extends string>(env: NodeJS.ProcessEnv, name: string, schema: z.ZodEnum<{ [K in T]: K }>, warnings: string[]): T | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  warnings.push(`ignoring ${name}="${raw}" (expected ${schema.options.join(', ')})`);
  return undefined;
}

/** BACKCOURT_DUO_ACCOUNT > config `privacy.account` > 'hide'. */
export function resolveAccountDisplay(env: NodeJS.ProcessEnv = process.env, config: Loaded<Config> = userConfig()): Loaded<AccountDisplay> {
  const warnings = [...config.warnings];
  return { value: envEnum(env, 'BACKCOURT_DUO_ACCOUNT', AccountDisplaySchema, warnings) ?? config.value.privacy?.account ?? 'hide', warnings };
}

/** --model > BACKCOURT_DUO_MODEL > config `agent.model` > undefined (Claude Code's default). */
export function resolveModel(cli: string | undefined, env: NodeJS.ProcessEnv = process.env, config: Loaded<Config> = userConfig()): string | undefined {
  return cli || env['BACKCOURT_DUO_MODEL'] || config.value.agent?.model;
}

/** --effort (validated by the CLI) > BACKCOURT_DUO_EFFORT > config `agent.effort` > undefined (the model's default). */
export function resolveEffort(cli: EffortLevel | undefined, env: NodeJS.ProcessEnv = process.env, config: Loaded<Config> = userConfig()): Loaded<EffortLevel | undefined> {
  const warnings: string[] = [];
  const fromEnv = envEnum(env, 'BACKCOURT_DUO_EFFORT', EffortSchema, warnings);
  return { value: cli ?? fromEnv ?? config.value.agent?.effort, warnings };
}

export interface LanguageFlags {
  lang?: string | undefined;
  chatLang?: string | undefined;
  reviewLang?: string | undefined;
}

/**
 * CLI > env > repository config > user config > unset; within a level the specific option beats `--lang`.
 * The repository config only decides `review` (chat language is personal). An unset review follows chat.
 * CLI tags are validated by the CLI (usage error); bad env values are skipped with a warning.
 * The user config's own warnings are not repeated here (they already reach `AgentAuthSummary.warnings`).
 */
export function resolveLanguage(
  flags: LanguageFlags,
  env: NodeJS.ProcessEnv = process.env,
  repo: Loaded<RepoConfig> = { value: {}, warnings: [] },
  config: Loaded<Config> = userConfig(),
): Loaded<LanguageSettings> {
  const warnings = [...repo.warnings];
  /** Env values are the only unvalidated input here: CLI flags and config files arrive canonical. */
  const fromEnv = (name: string): string | undefined => {
    const raw = env[name];
    const tag = raw ? canonicalLanguageTag(raw) : null;
    if (raw && !tag) warnings.push(`ignoring ${name}="${raw}" (${LANGUAGE_TAG_HINT})`);
    return tag ?? undefined;
  };
  const pick = (candidates: Array<[string | undefined, string]>): LanguageSetting | null => {
    const hit = candidates.find(([tag]) => tag);
    return hit ? languageSetting(hit[0]!, hit[1]) : null;
  };
  const user = config.value.language ?? {};
  const envBoth = fromEnv('BACKCOURT_DUO_LANG');
  const conversation = pick([[flags.chatLang, '--chat-lang'], [flags.lang, '--lang'], [fromEnv('BACKCOURT_DUO_CHAT_LANG'), 'BACKCOURT_DUO_CHAT_LANG'], [envBoth, 'BACKCOURT_DUO_LANG'], [user.conversation, 'config']]);
  const review = pick([[flags.reviewLang, '--review-lang'], [flags.lang, '--lang'], [fromEnv('BACKCOURT_DUO_REVIEW_LANG'), 'BACKCOURT_DUO_REVIEW_LANG'], [envBoth, 'BACKCOURT_DUO_LANG'], [repo.value.language?.review, REPO_CONFIG_FILE], [user.review, 'config']]);
  return { value: languageSettings(conversation, review), warnings };
}

/** resolveLanguage with the repository's `.backcourt-duo.json` (when the repo root is known). */
export function loadLanguage(flags: LanguageFlags, repoRoot: string | null): Loaded<LanguageSettings> {
  return resolveLanguage(flags, process.env, repoRoot ? loadJson(join(repoRoot, REPO_CONFIG_FILE), RepoConfigSchema) : undefined);
}

/** Settings the UI changes; `null` removes the key (back to the default). */
export interface SettingsPatch {
  agent?: { model?: string | null | undefined; effort?: EffortLevel | null | undefined };
  language?: { conversation?: string | null | undefined; review?: string | null | undefined };
}

let saving: Promise<void> = Promise.resolve();

/**
 * Write UI-changed settings into the user config (specs/commands/start.md#設定ファイル), keeping every other key.
 * Writes are serialised and atomic. A file that is not a JSON object is left alone (throws) rather than overwritten.
 */
export function saveUserConfig(patch: SettingsPatch, path = USER_CONFIG_PATH): Promise<void> {
  const run = saving.then(async () => {
    let raw: unknown = {};
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`not saving to ${path}: ${(err as Error).message}`);
    }
    if (!isObject(raw)) throw new Error(`not saving to ${path}: not a JSON object`);
    // `"language": "ja"` sets both; expand it so one side can change.
    if (typeof raw['language'] === 'string') raw['language'] = { conversation: raw['language'], review: raw['language'] };
    for (const [section, values] of Object.entries(patch) as Array<[string, Record<string, string | null | undefined>]>) {
      const target = isObject(raw[section]) ? raw[section] : (raw[section] = {});
      for (const [key, value] of Object.entries(values)) {
        if (value === null) delete target[key];
        else if (value !== undefined) target[key] = value;
      }
    }
    await writeFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
    if (path === USER_CONFIG_PATH) cached = undefined;
  });
  saving = run.catch(() => undefined);
  return run;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
