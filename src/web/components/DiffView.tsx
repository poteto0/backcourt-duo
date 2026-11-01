import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import type { DiffFile, DiffLine, PendingComment, Side } from '../../shared/types';
import { formatRef } from '../../shared/types';
import { api, ApiError } from '../api';
import { renderMarkdown } from '../markdown';
import { diff, insertIntoComposer, openFile, scrollRequest, selection, setFollow, setSelection, snap, viewPath } from '../store';
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
    const sel = selection();
    return !!sel && sel.path === viewPath() && sel.side === k.side && k.line >= sel.start && k.line <= sel.end;
  };
  const commentsAt = (k: LineKey): PendingComment[] => s().pending.filter((c) => c.path === viewPath() && c.side === k.side && c.line === k.line);

  // Scroll on navigation requests (human clicks, follow-agent).
  createEffect(
    on(scrollRequest, (req) => {
      if (!req || req.path !== viewPath()) return;
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
  createEffect(on(viewPath, () => setDraft(null)));

  const clickLine = (k: LineKey, e: MouseEvent) => {
    const path = viewPath();
    if (!path) return;
    const sel = selection();
    if (e.shiftKey && sel && sel.path === path && sel.side === k.side) {
      setSelection({ path, side: k.side, start: Math.min(sel.start, k.line), end: Math.max(sel.end, k.line) });
    } else if (sel && sel.path === path && sel.side === k.side && sel.start === k.line && sel.end === k.line) {
      setSelection(null);
    } else {
      setSelection({ path, side: k.side, start: k.line, end: k.line });
    }
  };

  const startComment = (k: LineKey) => {
    const sel = selection();
    if (sel && sel.path === viewPath() && sel.side === k.side && k.line >= sel.start && k.line <= sel.end) setDraft({ side: k.side, start: sel.start, end: sel.end });
    else setDraft({ side: k.side, start: k.line, end: k.line });
  };

  const selectionRef = () => {
    const sel = selection();
    const path = viewPath();
    if (!path) return '';
    if (!sel || sel.path !== path) return formatRef({ path });
    return formatRef({ path, startLine: sel.start, endLine: sel.end });
  };

  const idx = () => order().indexOf(viewPath() ?? '');
  const go = (d: number) => {
    const next = order()[idx() + d];
    if (next) openFile(next);
  };

  return (
    <section class="diffpane">
      <div class="presence-bar">
        <Show
          when={s().presence.agent}
          fallback={<span class="muted">🤖 The agent hasn’t opened a file yet</span>}
        >
          {(a) => (
            <button class="agent-loc" onClick={() => openFile(a().path, { ...(a().startLine !== undefined ? { line: a().startLine!, select: false } : {}), fromAgent: true })}>
              <span class="who agent">🤖</span> Agent is on <code>{formatRef({ path: a().path, ...(a().startLine !== undefined ? { startLine: a().startLine! } : {}), ...(a().endLine !== undefined ? { endLine: a().endLine! } : {}) })}</code>
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
              <button class="btn" onClick={() => insertIntoComposer(`${selectionRef()} `)} title="Reference the current file/selection in the chat">
                Ask agent about {selection()?.path === f().path ? 'selection' : 'file'}
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
                        {(h) => (
                          <>
                            <tr class="hunk">
                              <td colspan="3">
                                <span>{h.header.replace(/ @@.*$/, ' @@')}</span>
                                <span class="section">{h.section}</span>
                              </td>
                            </tr>
                            <For each={h.lines}>
                              {(l) => {
                                const k = keyOf(l);
                                return (
                                  <>
                                    <tr
                                      data-key={keyStr(k)}
                                      classList={{ line: true, [l.kind]: true, sel: inSelection(k), agent: inAgentRange(k) }}
                                    >
                                      <td class="ln" onClick={(e) => clickLine(k, e)}>
                                        {l.oldLine ?? ''}
                                      </td>
                                      <td class="ln" onClick={(e) => clickLine(k, e)}>
                                        {l.newLine ?? ''}
                                      </td>
                                      <td class="code">
                                        <button class="add-comment" title="Add a comment (shift-click line numbers to select a range)" onClick={() => startComment(k)}>
                                          +
                                        </button>
                                        <span class="marker">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
                                        <span class="text">{l.text}</span>
                                        <Show when={l.noNewline}>
                                          <span class="nonl" title="No newline at end of file">⏎̸</span>
                                        </Show>
                                      </td>
                                    </tr>
                                    <Show when={commentsAt(k).length || (draft()?.side === k.side && draft()?.end === k.line)}>
                                      <tr class="thread-row">
                                        <td colspan="3">
                                          <For each={commentsAt(k)}>{(c) => <Comment c={c} />}</For>
                                          <Show when={draft()?.side === k.side && draft()?.end === k.line}>
                                            <CommentForm draft={draft()!} path={f().path} onDone={() => setDraft(null)} />
                                          </Show>
                                        </td>
                                      </tr>
                                    </Show>
                                  </>
                                );
                              }}
                            </For>
                          </>
                        )}
                      </For>
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
        ...(props.draft.start !== props.draft.end ? { startLine: props.draft.start } : {}),
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

export function Comment(props: { c: PendingComment; compact?: boolean }) {
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
