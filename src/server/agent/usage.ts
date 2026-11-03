// Usage accounting: the per-turn token log for BACKCOURT_DUO_DEBUG (specs/sessions/agent-session.md#トークン計測デバッグ用),
// which goes to stderr only, and the rate-limit window merge behind the UI's usage meter (#残量の表示).
import type { ModelUsage, SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { RateLimitWindow } from '../../shared/types.js';
import { shortToolName } from './tools.js';

/**
 * Replace (or append) the window a `rate_limit_event` reports; the SDK sends one window per event.
 * Returns `windows` itself when the event has no utilization or repeats the stored values, so callers can skip the update.
 */
export function mergeRateLimit(windows: RateLimitWindow[], info: SDKRateLimitInfo): RateLimitWindow[] {
  if (info.utilization === undefined) return windows;
  const next: RateLimitWindow = {
    kind: info.rateLimitType ?? 'limit',
    status: info.status,
    utilization: info.utilization,
    resetsAt: info.resetsAt === undefined ? undefined : info.resetsAt * 1000,
  };
  const i = windows.findIndex((w) => w.kind === next.kind);
  const cur = windows[i];
  if (cur && cur.status === next.status && cur.utilization === next.utilization && cur.resetsAt === next.resetsAt) return windows;
  return i < 0 ? [...windows, next] : windows.with(i, next);
}

/** Log label → summed ModelUsage field, in output order (`thinking` is left out when 0). */
const FIELDS = [
  ['in', 'inputTokens'],
  ['cache_read', 'cacheReadInputTokens'],
  ['cache_write', 'cacheCreationInputTokens'],
  ['out', 'outputTokens'],
  ['thinking', 'thinkingTokens'],
  ['cost', 'costUSD'],
] as const;
type Key = (typeof FIELDS)[number][1];
type Totals = Record<Key, number>;

function sum(modelUsage: Record<string, ModelUsage>): Totals {
  const t = Object.fromEntries(FIELDS.map(([, k]) => [k, 0])) as Totals;
  for (const u of Object.values(modelUsage)) for (const [, k] of FIELDS) t[k] += u[k] ?? 0;
  return t;
}

/** 12400 → "12.4k", 180000 → "180k", 950 → "950". */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

/** Length of a tool_result's content: a string, or text blocks (images and the like count as 0). */
export function toolResultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) if (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string') n += b.text.length;
  return n;
}

/**
 * Watches the SDK message stream and returns one log line per `result`.
 * `modelUsage` is cumulative per query(), so each turn is the difference from the previous result.
 * Make a new meter per query(): the first turn after a (resumed) start is the running total as the SDK reports it.
 */
export class TokenMeter {
  private turn = 0;
  private prev: Totals | null = null;
  /** tool_use id → tool name, for the current turn */
  private toolNames = new Map<string, string>();
  /** tool name → [calls, result chars], for the current turn (insertion order = first use) */
  private tools = new Map<string, [number, number]>();

  /** Feed every SDK message; returns the turn's line on `result`, e.g. `[tokens] turn=3 in=12.4k … tools=get_file_diff×2:8.1k`. */
  observe(m: SDKMessage): string | undefined {
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      for (const b of m.message.content) if (b.type === 'tool_use') this.toolNames.set(b.id, shortToolName(b.name));
    } else if (m.type === 'user' && typeof m.message.content !== 'string') {
      for (const b of m.message.content) {
        if (b.type !== 'tool_result') continue;
        const name = this.toolNames.get(b.tool_use_id);
        if (!name) continue;
        const [calls, chars] = this.tools.get(name) ?? [0, 0];
        this.tools.set(name, [calls + 1, chars + toolResultChars(b.content)]);
      }
    } else if (m.type === 'result') {
      return this.endTurn(m.modelUsage);
    }
    return undefined;
  }

  private endTurn(modelUsage: Record<string, ModelUsage>): string {
    const now = sum(modelUsage);
    const prev = this.prev;
    this.prev = now;
    this.turn++;
    const parts = [`turn=${this.turn}`];
    for (const [label, k] of FIELDS) {
      const d = now[k] - (prev?.[k] ?? 0);
      if (k === 'costUSD') parts.push(`${label}=$${d.toFixed(3)}`);
      else if (k !== 'thinkingTokens' || d > 0) parts.push(`${label}=${compact(d)}`);
    }
    if (this.tools.size) {
      const tools = [...this.tools].map(([name, [calls, chars]]) => `${name}×${calls}:${compact(chars)}`);
      parts.push(`tools=${tools.join(',')}`);
    }
    this.toolNames.clear();
    this.tools.clear();
    return `[tokens] ${parts.join(' ')}`;
  }
}
