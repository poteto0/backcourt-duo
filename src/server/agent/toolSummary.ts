// One-line chat summaries for tool calls, shared by the Claude and OpenCode backends.
import type { ChatMessage, Ref } from '../../shared/types.js';
import { formatRef } from '../../shared/types.js';
import { truncate } from '../../shared/text.js';
import { shortToolName } from './tools.js';

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** One-line chat summary of a tool call, linking to the location it touches. */
export function describeTool(name: string, input: Record<string, unknown>, root: string): NonNullable<ChatMessage['tool']> {
  const short = shortToolName(name);
  const path = str(input['path']) ?? str(input['file_path']);
  const ref: Ref | undefined = path === undefined ? undefined : { path, startLine: num(input['startLine']) ?? num(input['line']), endLine: num(input['endLine']) ?? num(input['line']) };
  const at = ref ? formatRef(ref) : '';
  const summaries: Record<string, () => string> = {
    focus: () => `📍 focus ${at}${str(input['note']) ? ` — ${str(input['note'])}` : ''}`,
    get_review_context: () => '🗂️ read review context',
    get_file_diff: () => `🧾 read diff ${at}`,
    set_review_plan: () => `🗺️ set review plan (${Array.isArray(input['files']) ? input['files'].length : 0} files)`,
    get_human_focus: () => '👀 checked where you are',
    add_pending_comment: () => `💬 staged comment on ${at}`,
    update_pending_comment: () => `✏️ edited pending ${str(input['id']) ?? ''}`,
    delete_pending_comment: () => `🗑️ deleted pending ${str(input['id']) ?? ''}`,
    propose_change: () => `💡 proposed a change on ${at}`,
    withdraw_proposal: () => `↩️ withdrew proposal ${str(input['id']) ?? ''}`,
    save_note: () => `📝 noted${at ? ` on ${at}` : ''}: ${truncate(str(input['text']) ?? '', 80)}`,
    update_note: () => `📝 ${input['resolved'] === true ? 'resolved' : input['resolved'] === false ? 'reopened' : 'edited'} note ${str(input['id']) ?? ''}`,
    delete_note: () => `🗑️ deleted note ${str(input['id']) ?? ''}`,
    mark_file_reviewed: () => `✅ marked ${at} reviewed`,
    set_phase: () => `🏁 phase → ${str(input['phase']) ?? ''}`,
    recommend_review: () => `🧭 suggested ${str(input['event']) ?? 'a verdict'}`,
    // Claude Code spells built-ins in TitleCase, OpenCode in lower case.
    Read: () => `📖 Read ${(str(input['file_path']) ?? '').replace(`${root}/`, '')}`,
    read: () => `📖 Read ${(str(input['file_path']) ?? str(input['path']) ?? '').replace(`${root}/`, '')}`,
    Grep: () => `🔎 Grep ${JSON.stringify(str(input['pattern']) ?? '')}${path ? ` in ${path}` : ''}`,
    grep: () => `🔎 Grep ${JSON.stringify(str(input['pattern']) ?? '')}${path ? ` in ${path}` : ''}`,
    Glob: () => `🔎 Glob ${str(input['pattern']) ?? ''}`,
    glob: () => `🔎 Glob ${str(input['pattern']) ?? ''}`,
  };
  return { summary: summaries[short]?.() ?? `🔧 ${short}`, ref: short === 'Grep' || short === 'grep' ? undefined : ref };
}
