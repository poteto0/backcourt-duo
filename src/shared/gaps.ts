// Unchanged lines that a diff collapses between hunks (the blue rows), so the UI can expand them.
import type { DiffHunk } from './types.js';

export interface Gap {
  /** First and last hidden line in the new file (empty when start > end). */
  start: number;
  end: number;
  /** Old line number minus new line number for every line in the gap. */
  offset: number;
}

// A hunk with a zero count names the line *before* it (`@@ -5,2 +4,0 @@`), so shift those by one.
const first = (start: number, count: number) => (count === 0 ? start + 1 : start);

/**
 * `gaps[i]` is hidden right before `hunks[i]`; `gaps[hunks.length]` is hidden after the last hunk,
 * up to `newLineCount` (the line count of the new file).
 */
export function collapsedGaps(hunks: readonly DiffHunk[], newLineCount: number): Gap[] {
  const gaps: Gap[] = [];
  let nextNew = 1;
  let offset = 0;
  for (const h of hunks) {
    const newFirst = first(h.newStart, h.newLines);
    gaps.push({ start: nextNew, end: newFirst - 1, offset });
    nextNew = newFirst + h.newLines;
    offset = first(h.oldStart, h.oldLines) + h.oldLines - nextNew;
  }
  gaps.push({ start: nextNew, end: newLineCount, offset });
  return gaps;
}

/** Index into `gaps` of the hidden gap containing `line` (new file), or -1. */
export function gapOf(gaps: readonly Gap[], line: number): number {
  return gaps.findIndex((g) => line >= g.start && line <= g.end);
}
