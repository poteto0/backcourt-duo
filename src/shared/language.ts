// Language settings shared by the server and the UI (specs/commands/start.md#言語).
// Pure helpers only: no runtime dependencies beyond the built-in Intl.
import { REF_PATTERN } from './types.js';

/** One resolved language: the BCP 47 tag, its English name (for prompts), and where it was set. */
export interface LanguageSetting {
  tag: string;
  name: string;
  /** e.g. `--review-lang`, `BACKCOURT_DUO_LANG`, `.backcourt-duo.json`, `config`, `chat` (review follows chat). */
  source: string;
}

/** `null` = unset: chat follows the human; review follows chat, else the PR's language. */
export interface LanguageSettings {
  conversation: LanguageSetting | null;
  review: LanguageSetting | null;
}

/** Appended to every "invalid tag" message (CLI, env, config). */
export const LANGUAGE_TAG_HINT = 'not a BCP 47 language tag (e.g. ja, en, zh-Hans)';

/** Canonical BCP 47 tag (`zh-hans` → `zh-Hans`), or null when it is not a valid tag. */
export function canonicalLanguageTag(raw: string): string | null {
  try {
    return Intl.getCanonicalLocales(raw.trim())[0] ?? null;
  } catch {
    return null;
  }
}

let displayNames: Intl.DisplayNames | undefined;
/** Human-readable English name for prompts: `ja` → `Japanese`. */
export function languageName(tag: string): string {
  try {
    return (displayNames ??= new Intl.DisplayNames(['en'], { type: 'language' })).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** `chat ja (config) · review en (--review-lang)` — terminal, doctor and the UI's tooltip. */
export function describeLanguage({ conversation: c, review: r }: LanguageSettings): string {
  return `chat ${c ? `${c.tag} (${c.source})` : 'auto (follows you)'} · review ${r ? `${r.tag} (${r.source})` : 'auto (PR language)'}`;
}

/** ISO 15924 scripts written by a locale's likely script, as Unicode `Script` values. */
const SCRIPT_SETS: Record<string, string[]> = {
  Jpan: ['Han', 'Hiragana', 'Katakana'],
  Kore: ['Hangul', 'Han'],
  Hans: ['Han'],
  Hant: ['Han'],
};

const scriptCache = new Map<string, RegExp | null>();
/** One character class matching the tag's likely script(s), cached per tag. */
function scriptPattern(tag: string): RegExp | null {
  let re = scriptCache.get(tag);
  if (re !== undefined) return re;
  try {
    const script = new Intl.Locale(tag).maximize().script;
    re = script ? new RegExp(`[${(SCRIPT_SETS[script] ?? [script]).map((s) => `\\p{Script=${s}}`).join('')}]`, 'u') : null;
  } catch {
    re = null;
  }
  scriptCache.set(tag, re);
  return re;
}

const LATIN = /\p{Script=Latin}/u;

/**
 * Heuristic: is `text` evidently written in a different language than `tag`? Judged by writing script only
 * (code, inline code and `@path` references are ignored), so it cannot tell e.g. English from French.
 * Latin text is normal inside CJK prose (identifiers), but other scripts inside Latin prose are not.
 */
export function looksLikeOtherLanguage(text: string, tag: string): boolean {
  const expected = scriptPattern(tag);
  if (!expected) return false;
  const prose = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(REF_PATTERN, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  let own = 0;
  let latin = 0;
  let foreign = 0;
  for (const ch of prose.match(/\p{L}/gu) ?? []) {
    if (expected.test(ch)) own++;
    else if (LATIN.test(ch)) latin++;
    else foreign++;
  }
  return foreign >= 2 || (own === 0 && latin >= 12);
}
