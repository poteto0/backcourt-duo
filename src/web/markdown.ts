// Tiny, safe Markdown → HTML for chat. Everything is escaped first; only a fixed set of tags is produced.
import { formatRef, parseRefs, type Ref } from '../shared/types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function refChip(ref: Ref): string {
  const data = `${ref.startLine !== undefined ? ` data-start="${ref.startLine}"` : ''}${ref.endLine !== undefined ? ` data-end="${ref.endLine}"` : ''}`;
  return `<button type="button" class="ref" data-path="${esc(ref.path)}"${data}>${esc(formatRef(ref).slice(1))}</button>`;
}

/** Inline formatting on raw (unescaped) text. */
function inline(raw: string): string {
  // Split out inline code first so its content is not formatted.
  const parts = raw.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
        const code = part.slice(1, -1);
        const refs = parseRefs(code);
        if (refs.length === 1 && refs[0]!.index === 0 && refs[0]!.length === code.length) {
          return refChip(refs[0]!.ref);
        }
        return `<code>${esc(code)}</code>`;
      }
      let out = '';
      let last = 0;
      for (const r of parseRefs(part)) {
        out += fmt(part.slice(last, r.index));
        out += refChip(r.ref);
        last = r.index + r.length;
      }
      out += fmt(part.slice(last));
      return out;
    })
    .join('');
}

function fmt(raw: string): string {
  let s = esc(raw);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return s;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      flushPara();
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      const lang = fence[1] ?? '';
      const cls = lang === 'suggestion' || lang === 'diff' ? ` class="lang-${esc(lang)}"` : '';
      out.push(`<pre${cls}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      const level = Math.min(h[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const kind = li[1] ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      const text = li[3]!.replace(/^\[( |x)\]\s+/, (_m, x: string) => (x === 'x' ? '☑ ' : '☐ '));
      out.push(`<li>${inline(text)}</li>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      i++;
      continue;
    }
    closeList();
    para.push(line);
    i++;
  }
  flushPara();
  closeList();
  return out.join('');
}
