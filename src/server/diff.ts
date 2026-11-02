import type { DiffFile, DiffHunk, Side } from '../shared/types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(p: string): string {
  // git quotes paths with special chars: "a/foo\tbar"
  if (p.startsWith('"') && p.endsWith('"')) {
    const inner = p.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1]!;
        if (/[0-7]/.test(next)) {
          bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
          i += 3;
          continue;
        }
        const map: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92, r: 13 };
        bytes.push(map[next] ?? next.charCodeAt(0));
        i += 1;
        continue;
      }
      bytes.push(...Buffer.from(ch, 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return p;
}

function stripPrefix(p: string): string {
  const u = unquote(p.trim());
  if (u.startsWith('a/') || u.startsWith('b/')) return u.slice(2);
  return u;
}

/** Parse `git diff` unified output (with --no-prefix NOT set; a/ b/ prefixes expected). */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split('\n');
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const finish = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      finish();
      // Best effort from header; refined by ---/+++ and rename lines.
      const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
      const a = m ? stripPrefix(m[1]!) : '';
      const b = m ? stripPrefix(m[2]!) : '';
      file = { path: b || a, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
      if (a && b && a !== b) file.oldPath = a;
      continue;
    }
    if (!file) continue;
    const f: DiffFile = file;

    if (hunk === null) {
      if (line.startsWith('new file mode')) f.status = 'added';
      else if (line.startsWith('deleted file mode')) f.status = 'deleted';
      else if (line.startsWith('rename from ')) { f.oldPath = unquote(line.slice(12)); f.status = 'renamed'; }
      else if (line.startsWith('rename to ')) { f.path = unquote(line.slice(10)); f.status = 'renamed'; }
      else if (line.startsWith('copy from ')) { f.oldPath = unquote(line.slice(10)); f.status = 'copied'; }
      else if (line.startsWith('copy to ')) { f.path = unquote(line.slice(8)); f.status = 'copied'; }
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) f.binary = true;
      else if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') f.oldPath = stripPrefix(p);
        continue;
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') f.path = stripPrefix(p);
        else if (f.oldPath) f.path = f.oldPath;
        continue;
      }
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      const h: DiffHunk = {
        header: line,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        section: hm[5] ?? '',
        lines: [],
      };
      f.hunks.push(h);
      hunk = h;
      oldNo = h.oldStart;
      newNo = h.newStart;
      continue;
    }
    if (!hunk) continue;
    const h: DiffHunk = hunk;
    const first = line[0];
    if (first === '+') {
      h.lines.push({ kind: 'add', newLine: newNo++, text: line.slice(1) });
      f.additions++;
    } else if (first === '-') {
      h.lines.push({ kind: 'del', oldLine: oldNo++, text: line.slice(1) });
      f.deletions++;
    } else if (first === ' ') {
      h.lines.push({ kind: 'context', oldLine: oldNo++, newLine: newNo++, text: line.slice(1) });
    } else if (first === '\\') {
      const last = h.lines[h.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (line === '' && i === lines.length - 1) {
      // trailing newline of the whole output
    } else if (line === '') {
      // Some tools emit empty context lines without the leading space.
      h.lines.push({ kind: 'context', oldLine: oldNo++, newLine: newNo++, text: '' });
    }
  }
  finish();
  for (const f of files) {
    if (f.oldPath === f.path) delete f.oldPath;
    if (f.status === 'modified' && f.oldPath) f.status = 'renamed';
  }
  return files;
}

const hunkHasLine = (h: DiffHunk, side: Side, n: number) =>
  h.lines.some((l) => (side === 'RIGHT' ? l.kind !== 'del' && l.newLine === n : l.kind !== 'add' && l.oldLine === n));

/** Both ends of a (multi-line) comment must be in the same hunk on GitHub. */
export function isCommentableRange(file: DiffFile, side: Side, start: number, end: number): boolean {
  return file.hunks.some((h) => hunkHasLine(h, side, start) && hunkHasLine(h, side, end));
}

/** Is (side,line) inside a hunk, i.e. commentable on GitHub? */
export function isCommentable(file: DiffFile, side: Side, line: number): boolean {
  return isCommentableRange(file, side, line, line);
}

/** Texts of new-file lines start..end (validate the range with isCommentableRange first). */
export function rightLineTexts(file: DiffFile, start: number, end: number): string[] {
  return file.hunks.flatMap((h) => h.lines.filter((l) => l.newLine !== undefined && l.newLine >= start && l.newLine <= end).map((l) => l.text));
}

/** Compact text rendering for the agent: every line annotated with old/new numbers. */
export function renderFileDiffForAgent(file: DiffFile, maxLines = 1500): string {
  const out: string[] = [];
  out.push(`# ${file.path} (${file.status}${file.oldPath ? ` from ${file.oldPath}` : ''}, +${file.additions} -${file.deletions})`);
  if (file.binary) {
    out.push('(binary file — no textual diff)');
    return out.join('\n');
  }
  out.push('# columns: L<old line> R<new line> | marker | text. Comment on RIGHT lines with the R number, on deleted lines with side LEFT and the L number.');
  let count = 0;
  for (const h of file.hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      if (count++ >= maxLines) {
        out.push(`… truncated (${file.additions + file.deletions} changed lines total). Use Read on the file for full context.`);
        return out.join('\n');
      }
      const L = l.oldLine === undefined ? '    ' : String(l.oldLine).padStart(4);
      const R = l.newLine === undefined ? '    ' : String(l.newLine).padStart(4);
      const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      out.push(`L${L} R${R} |${mark}| ${l.text}`);
    }
  }
  return out.join('\n');
}
