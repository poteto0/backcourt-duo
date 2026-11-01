import { diff, openFile } from '../store';

/** Delegated click handler for `.ref` chips rendered by markdown.ts. */
export function onRefClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.ref');
  if (!el) return;
  e.preventDefault();
  let path = el.dataset['path'] ?? '';
  const files = diff();
  if (!files.some((f) => f.path === path)) {
    // Tolerate refs with a leading ./ or partial paths (e.g. "store.ts").
    const clean = path.replace(/^\.\//, '');
    const hit = files.find((f) => f.path === clean) ?? files.find((f) => f.path.endsWith(`/${clean}`));
    if (!hit) {
      el.classList.add('missing');
      el.title = 'Not part of this diff';
      return;
    }
    path = hit.path;
  }
  const start = el.dataset['start'] ? Number(el.dataset['start']) : undefined;
  const end = el.dataset['end'] ? Number(el.dataset['end']) : undefined;
  openFile(path, start !== undefined ? { line: start, ...(end !== undefined ? { endLine: end } : {}) } : {});
}
