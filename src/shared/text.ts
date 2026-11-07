/** One line, at most `n` characters. */
export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
