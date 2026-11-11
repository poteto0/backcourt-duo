/** At most `n` characters, line breaks kept; `keep: 'end'` cuts the start instead of the end. */
export function clip(s: string, n: number, keep: 'start' | 'end' = 'start'): string {
  if (s.length <= n) return s;
  return keep === 'start' ? `${s.slice(0, n - 1)}…` : `…${s.slice(s.length - n + 1)}`;
}

/** One line, at most `n` characters. */
export function truncate(s: string, n: number): string {
  return clip(s.replace(/\s+/g, ' '), n);
}
