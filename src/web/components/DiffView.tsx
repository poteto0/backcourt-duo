import { createEffect, createMemo, createResource, createSignal, For, on, Show, type JSX } from 'solid-js';
import type { ChangeProposal, DiffFile, DiffLine, PendingComment, Side } from '../../shared/types';
import { commentRef, formatRef } from '../../shared/types';
import { collapsedGaps, gapOf, type Gap } from '../../shared/gaps';
import { api, ApiError } from '../api';
import { renderMarkdown } from '../markdown';
import { currentSelection, diff, hereRef, inOtherLanguage, insertIntoComposer, openFile, scrollRequest, setFollow, setSelection, snap, viewPath } from '../store';
import { onRefClick } from './refs';

interface LineKey {
  side: Side;
  line: number;
}

function keyOf(l: DiffLine): LineKey {
  return l.kind === 'del' ? { side: 'LEFT', line: l.oldLine! } : { side: 'RIGHT', line: l.newLine! };
}

const keyStr = (k: LineKey) => `${k.side === 'LEFT' ? 'L' : 'R'}-${k.line}`;

interface Draft {
  side: Side;
  start: number;
  end: number;
}

export function DiffView() {
  const s = () => snap()!;
  const file = createMemo<DiffFile | undefined>(() => diff().find((f) => f.path === viewPath()));
  const entry = createMemo(() => s().files.find((f) => f.path === viewPath()));
  const order = createMemo(() => (s().plan ? s().plan!.files.map((p) => p.path) : s().files.map((f) => f.path)));
  const [draft, setDraft] = createSignal<Draft | null>(null);
  // Full new-side text of the viewed file, to expand the unchanged lines between hunks (the blue rows).
  const [newLines] = createResource(
    () => {
      const f = file();
      return f && !f.binary && f.status !== 'deleted' && f.hunks.length ? f.path : undefined;
    },
    (path) => api.fileLines(path).catch(() => []),
  );
  const gaps = createMemo<Gap[]>(() => {
    const f = file();
    const lines = newLines();
    return f && lines?.length ? collapsedGaps(f.hunks, lines.length) : [];
  });
  /** Indices into gaps() the human has expanded. */
  const [expanded, setExpanded] = createSignal<ReadonlySet<number>>(new Set());
  const expand = (i: number) => setExpanded((prev) => new Set(prev).add(i));
  const hiddenCount = (i: number) => {
    const g = gaps()[i];
    return g && !expanded().has(i) ? Math.max(0, g.end - g.start + 1) : 0;
  };
  const gapLines = (i: number): DiffLine[] => {
    const g = gaps()[i];
    const text = newLines() ?? [];
    if (!g || !expanded().has(i)) return [];
    return Array.from({ length: Math.max(0, g.end - g.start + 1) }, (_, j) => {
      const n = g.start + j;
      return { kind: 'context', oldLine: n + g.offset, newLine: n, text: text[n - 1] ?? '' };
    });
  };
  let scroller: HTMLDivElement | undefined;

  const agentCursor = () => {
    const a = s().presence.agent;
    return a && a.path === viewPath() ? a : null;
  };
  const inAgentRange = (k: LineKey) => {
    const a = agentCursor();
    if (!a || a.startLine === undefined) return false;
    if ((a.side ?? 'RIGHT') !== k.side) return false;
    return k.line >= a.startLine && k.line <= (a.endLine ?? a.startLine);
  };
  const inSelection = (k: LineKey) => {
    const sel = currentSelection();
    return !!sel && sel.side === k.side && k.line >= sel.start && k.line <= sel.end;
  };
  /** Pending comments of the viewed file, grouped by line key — one pass instead of a scan per row. */
  const commentsByKey = createMemo(() => {
    const m = new Map<string, PendingComment[]>();
    for (const c of s().pending) {
      if (c.path !== viewPath()) continue;
      const k = keyStr(c);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  });
  const commentsAt = (k: LineKey): PendingComment[] => commentsByKey().get(keyStr(k)) ?? [];
  /** Change proposals of the viewed file, keyed by their last line (where the card is shown). */
  const proposalsByKey = createMemo(() => {
    const m = new Map<string, ChangeProposal[]>();
    for (const p of s().proposals) {
      if (p.path !== viewPath()) continue;
      const k = keyStr({ side: 'RIGHT', line: p.endLine });
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  });
  const proposalsAt = (k: LineKey): ChangeProposal[] => proposalsByKey().get(keyStr(k)) ?? [];
  /** New-file lines of the viewed file covered by a proposal, so each row checks in O(1). */
  const proposedLines = createMemo(() => {
    const set = new Set<number>();
    for (const list of proposalsByKey().values()) for (const p of list) for (let n = p.startLine; n <= p.endLine; n++) set.add(n);
    return set;
  });
  const inProposal = (k: LineKey) => k.side === 'RIGHT' && proposedLines().has(k.line);

  // Scroll on navigation requests (human clicks, follow-agent).
  createEffect(
    on(scrollRequest, (req) => {
      if (!req || req.path !== viewPath()) return;
      // A reference into collapsed lines expands them so there is a row to scroll to.
      if (req.line !== undefined && (req.side ?? 'RIGHT') === 'RIGHT') {
        const i = gapOf(gaps(), req.line);
        if (i >= 0) expand(i);
      }
      requestAnimationFrame(() => {
        if (!scroller) return;
        if (req.line === undefined) {
          scroller.scrollTo({ top: 0 });
          return;
        }
        const el = scroller.querySelector(`[data-key="${keyStr({ side: req.side ?? 'RIGHT', line: req.line })}"]`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }),
  );
  createEffect(
    on(viewPath, () => {
      setDraft(null);
      setExpanded(new Set<number>());
    }),
  );

  const clickLine = (k: LineKey, e: MouseEvent) => {
    const path = viewPath();
    if (!path) return;
    const sel = currentSelection();
    if (e.shiftKey && sel && sel.side === k.side) {
      setSelection({ path, side: k.side, start: Math.min(sel.start, k.line), end: Math.max(sel.end, k.line) });
    } else if (sel && sel.side === k.side && sel.start === k.line && sel.end === k.line) {
      setSelection(null);
    } else {
      setSelection({ path, side: k.side, start: k.line, end: k.line });
    }
  };

  const startComment = (k: LineKey) => {
    const sel = currentSelection();
    setDraft(sel && inSelection(k) ? { side: k.side, start: sel.start, end: sel.end } : { side: k.side, start: k.line, end: k.line });
  };

  const idx = () => order().indexOf(viewPath() ?? '');
  const go = (d: number) => {
    const next = order()[idx() + d];
    if (next) openFile(next);
  };

  /** One diff line plus its thread. Lines expanded from a collapsed gap are not in the diff, so they take no comments. */
  const Row = (props: { l: DiffLine; commentable?: boolean }) => {
    const l = props.l;
    const k = keyOf(l);
    return (
      <>
        <tr data-key={keyStr(k)} classList={{ line: true, [l.kind]: true, expanded: !props.commentable, sel: inSelection(k), agent: inAgentRange(k), proposed: inProposal(k) }}>
          <td class="ln" onClick={(e) => clickLine(k, e)}>
            {l.oldLine ?? ''}
          </td>
          <td class="ln" onClick={(e) => clickLine(k, e)}>
            {l.newLine ?? ''}
          </td>
          <td class="code">
            <Show when={props.commentable}>
              <button class="add-comment" title="Add a comment (shift-click line numbers to select a range)" onClick={() => startComment(k)}>
                +
              </button>
            </Show>
            <span class="marker">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
            <span class="text">{l.text}</span>
            <Show when={l.noNewline}>
              <span class="nonl" title="No newline at end of file">⏎̸</span>
            </Show>
          </td>
        </tr>
        <Show when={props.commentable && (commentsAt(k).length || proposalsAt(k).length || (draft()?.side === k.side && draft()?.end === k.line))}>
          <tr class="thread-row">
            <td colspan="3">
              <For each={proposalsAt(k)}>{(p) => <Proposal p={p} />}</For>
              <For each={commentsAt(k)}>{(c) => <Comment c={c} />}</For>
              <Show when={draft()?.side === k.side && draft()?.end === k.line}>
                <CommentForm draft={draft()!} path={viewPath()!} onDone={() => setDraft(null)} />
              </Show>
            </td>
          </tr>
        </Show>
      </>
    );
  };

  return (
    <section class="diffpane">
      <div class="presence-bar">
        <Show
          when={s().presence.agent}
          fallback={<span class="muted">🤖 The agent hasn’t opened a file yet</span>}
        >
          {(a) => (
            <button class="agent-loc" onClick={() => openFile(a().path, { line: a().startLine, side: a().side, select: false, fromAgent: true })}>
              <span class="who agent">🤖</span> Agent is on <code>{formatRef(a())}</code>
              <Show when={a().note}>
                <span class="note">— {a().note}</span>
              </Show>
            </button>
          )}
        </Show>
        <div class="spacer" />
        <label class="toggle" title="Scroll to wherever the agent focuses">
          <input type="checkbox" checked={s().followAgent} onChange={(e) => setFollow(e.currentTarget.checked)} />
          <span class="track" />
          Follow agent
        </label>
      </div>

      <Show when={file()} fallback={<div class="empty">Select a file</div>}>
        {(f) => (
          <>
            <div class="file-header">
              <div class="nav">
                <button class="btn ghost" disabled={idx() <= 0} onClick={() => go(-1)} title="Previous file">
                  ‹
                </button>
                <button class="btn ghost" disabled={idx() >= order().length - 1} onClick={() => go(1)} title="Next file">
                  ›
                </button>
              </div>
              <div class="fname">
                <Show when={f().oldPath}>
                  <span class="old">{f().oldPath} →</span>
                </Show>
                <strong>{f().path}</strong>
                <span class="stat">
                  <span class="add">+{f().additions}</span> <span class="del">-{f().deletions}</span>
                </span>
                <Show when={s().plan?.files.find((p) => p.path === f().path)}>
                  {(p) => <span class={`plan-note prio-${p().priority}`} title={p().note}>{p().note}</span>}
                </Show>
              </div>
              <button class="btn" onClick={() => insertIntoComposer(`${hereRef()} `)} title="Reference the current file/selection in the chat">
                Ask agent about {currentSelection() ? 'selection' : 'file'}
              </button>
              <label class="viewed">
                <input
                  type="checkbox"
                  checked={entry()?.reviewState === 'reviewed'}
                  onChange={(e) => void api.reviewState(f().path, e.currentTarget.checked ? 'reviewed' : 'in-progress')}
                />
                Viewed
              </label>
            </div>

            <div class="diff-scroll" ref={scroller}>
              <Show when={!f().binary} fallback={<div class="empty">Binary file not shown</div>}>
                <Show when={f().hunks.length} fallback={<div class="empty">No textual changes (mode change or empty file)</div>}>
                  <table class="diff">
                    <colgroup>
                      <col class="c-ln" />
                      <col class="c-ln" />
                      <col />
                    </colgroup>
                    <tbody>
                      <For each={f().hunks}>
                        {(h, i) => (
                          <>
                            <For each={gapLines(i())}>{(l) => <Row l={l} />}</For>
                            <Show when={!expanded().has(i())}>
                              <HunkRow count={hiddenCount(i())} onExpand={() => expand(i())}>
                                <span>{h.header.replace(/ @@.*$/, ' @@')}</span>
                                <span class="section">{h.section}</span>
                              </HunkRow>
                            </Show>
                            <For each={h.lines}>{(l) => <Row l={l} commentable />}</For>
                          </>
                        )}
                      </For>
                      <For each={gapLines(f().hunks.length)}>{(l) => <Row l={l} />}</For>
                      <Show when={hiddenCount(f().hunks.length)}>
                        <HunkRow count={hiddenCount(f().hunks.length)} onExpand={() => expand(f().hunks.length)} />
                      </Show>
                    </tbody>
                  </table>
                </Show>
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}

/** A blue hunk/gap row; clicking it expands the unchanged lines it hides (when there are any). */
function HunkRow(props: { count: number; onExpand: () => void; children?: JSX.Element }) {
  return (
    <tr classList={{ hunk: true, expandable: props.count > 0 }} onClick={() => props.count > 0 && props.onExpand()} title={props.count > 0 ? `Expand ${props.count} unchanged line${props.count === 1 ? '' : 's'}` : undefined}>
      <td colspan="3">
        <Show when={props.count > 0}>
          <span class="expand-icon">↕</span>
        </Show>
        {props.children ?? <span>{props.count} more line{props.count === 1 ? '' : 's'}</span>}
      </td>
    </tr>
  );
}

function CommentForm(props: { draft: Draft; path: string; onDone: () => void }) {
  const [text, setText] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const save = async () => {
    if (!text().trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addPending({
        path: props.path,
        side: props.draft.side,
        line: props.draft.end,
        startLine: props.draft.start,
        body: text(),
      });
      props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="comment-form">
      <div class="cf-head">
        Comment on {props.draft.start !== props.draft.end ? `lines ${props.draft.start}–${props.draft.end}` : `line ${props.draft.end}`}
        {props.draft.side === 'LEFT' ? ' (old)' : ''}
      </div>
      <textarea
        ref={(el) => requestAnimationFrame(() => el.focus())}
        rows="4"
        placeholder="Leave a comment (Markdown). ⌘/Ctrl+Enter to add."
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === 'Escape') props.onDone();
        }}
      />
      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>
      <div class="cf-actions">
        <button class="btn ghost" onClick={() => props.onDone()}>
          Cancel
        </button>
        <button class="btn primary" disabled={busy() || !text().trim()} onClick={() => void save()}>
          Add to pending
        </button>
      </div>
    </div>
  );
}

function Comment(props: { c: PendingComment }) {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal(props.c.body);
  const save = async () => {
    await api.editPending(props.c.id, text());
    setEditing(false);
  };
  return (
    <div classList={{ comment: true, [props.c.author]: true }}>
      <div class="c-head">
        <span class={`who ${props.c.author}`}>{props.c.author === 'agent' ? '🤖' : '👤'}</span>
        <span class="author">{props.c.author === 'agent' ? 'Agent' : 'You'}</span>
        <Show when={props.c.editedByHuman}>
          <span class="tag">edited by you</span>
        </Show>
        <span class="tag pending">Pending</span>
        <Show when={props.c.startLine !== undefined}>
          <span class="tag">
            L{props.c.startLine}–L{props.c.line}
          </span>
        </Show>
        <div class="spacer" />
        <Show when={props.c.author === 'human' && inOtherLanguage(props.c) && snap()!.language.review}>
          {(review) => (
            <button
              class="btn ghost xs"
              title="Ask the agent for a translation; you confirm it in the chat before the comment changes"
              disabled={snap()!.agent.status !== 'waiting'}
              onClick={() => void api.send(`Please translate my pending comment ${props.c.id} (${formatRef(commentRef(props.c))}) into ${review().name}.`)}
            >
              Translate to {review().name}
            </button>
          )}
        </Show>
        <button class="btn ghost xs" onClick={() => { setText(props.c.body); setEditing(!editing()); }}>
          Edit
        </button>
        <button class="btn ghost xs danger" onClick={() => void api.deletePending(props.c.id)}>
          Delete
        </button>
      </div>
      <Show when={editing()} fallback={<div class="md" innerHTML={renderMarkdown(props.c.body)} onClick={onRefClick} />}>
        <textarea rows="4" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        <div class="cf-actions">
          <button class="btn ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button class="btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </Show>
    </div>
  );
}

function Proposal(props: { p: ChangeProposal }) {
  const [error, setError] = createSignal<string | null>(null);
  const act = (fn: () => Promise<unknown>) => () => fn().catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  return (
    <div class="comment agent proposal">
      <div class="c-head">
        <span class="who agent">🤖</span>
        <span class="author">Proposed change</span>
        <span class="tag">
          L{props.p.startLine}
          {props.p.endLine !== props.p.startLine ? `–L${props.p.endLine}` : ''}
        </span>
        <span class="tag" title="Shown for discussion only; no file was modified">not applied</span>
        <div class="spacer" />
        <button class="btn ghost xs" title="Add as a pending comment with a GitHub suggestion block" onClick={act(() => api.stageProposal(props.p.id))}>
          Stage as suggestion
        </button>
        <button class="btn ghost xs danger" onClick={act(() => api.dismissProposal(props.p.id))}>
          Dismiss
        </button>
      </div>
      <Show when={props.p.note}>
        <div class="md" innerHTML={renderMarkdown(props.p.note)} onClick={onRefClick} />
      </Show>
      <table class="diff proposal-diff">
        <tbody>
          <ProposalLines kind="del" lines={props.p.original} />
          <ProposalLines kind="add" lines={props.p.replacement} />
        </tbody>
      </table>
      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>
    </div>
  );
}

function ProposalLines(props: { kind: 'add' | 'del'; lines: string[] }) {
  return (
    <For each={props.lines}>
      {(t) => (
        <tr class={`line ${props.kind}`}>
          <td class="code">
            <span class="marker">{props.kind === 'add' ? '+' : '-'}</span>
            <span class="text">{t}</span>
          </td>
        </tr>
      )}
    </For>
  );
}
