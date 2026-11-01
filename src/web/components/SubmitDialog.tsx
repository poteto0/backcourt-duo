import { createMemo, createSignal, For, Show } from 'solid-js';
import type { PendingComment, ReviewEvent } from '../../shared/types';
import { api, ApiError } from '../api';
import { openFile, snap } from '../store';
import { renderMarkdown } from '../markdown';

const EVENTS: Array<{ id: ReviewEvent; label: string; help: string }> = [
  { id: 'COMMENT', label: 'Comment', help: 'Submit general feedback without explicit approval.' },
  { id: 'APPROVE', label: 'Approve', help: 'Submit feedback and approve merging these changes.' },
  { id: 'REQUEST_CHANGES', label: 'Request changes', help: 'Submit feedback that must be addressed before merging.' },
];

export function SubmitDialog(props: { onClose: () => void }) {
  const s = () => snap()!;
  const [event, setEvent] = createSignal<ReviewEvent>('COMMENT');
  const [body, setBody] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ message: string; details: string[] } | null>(null);
  const [done, setDone] = createSignal<string | null>(null);

  const grouped = createMemo(() => {
    const m = new Map<string, PendingComment[]>();
    for (const c of s().pending) m.set(c.path, [...(m.get(c.path) ?? []), c]);
    return [...m.entries()];
  });
  const needsBody = () => event() !== 'APPROVE' && s().pending.length === 0;
  const headMismatch = () => s().warnings.find((w) => w.code === 'head-mismatch');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.submit(event(), body());
      setDone(r.url);
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, details: err.details } : { message: String(err), details: [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Submit review">
        <Show
          when={!done()}
          fallback={
            <div class="done">
              <h2>🚀 Review submitted</h2>
              <p>
                <a href={done()!} target="_blank" rel="noreferrer">
                  {done()}
                </a>
              </p>
              <button class="btn primary" onClick={() => props.onClose()}>
                Close
              </button>
            </div>
          }
        >
          <h2>
            Finish your review
            <Show when={s().pr}>{(pr) => <span class="muted"> · #{pr().number}</span>}</Show>
          </h2>
          <Show when={headMismatch()}>{(w) => <div class="warning">⚠️ {w().message}</div>}</Show>
          <textarea rows="6" placeholder="Leave a summary (Markdown). Tip: ask the agent to “wrap up” for a draft." value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
          <div class="events">
            <For each={EVENTS}>
              {(ev) => (
                <label classList={{ ev: true, on: event() === ev.id, [ev.id.toLowerCase()]: true }}>
                  <input type="radio" name="event" checked={event() === ev.id} onChange={() => setEvent(ev.id)} />
                  <span>
                    <strong>{ev.label}</strong>
                    <small>{ev.help}</small>
                  </span>
                </label>
              )}
            </For>
          </div>
          <h3>
            {s().pending.length} pending comment{s().pending.length === 1 ? '' : 's'}
          </h3>
          <div class="pending-list">
            <For each={grouped()} fallback={<p class="muted">No inline comments.</p>}>
              {([path, cs]) => (
                <div class="pg">
                  <div class="pg-path">{path}</div>
                  <For each={cs}>
                    {(c) => (
                      <button
                        class="pg-item"
                        onClick={() => {
                          props.onClose();
                          openFile(c.path, { line: c.startLine ?? c.line, endLine: c.line, side: c.side });
                        }}
                      >
                        <span class={`who ${c.author}`}>{c.author === 'agent' ? '🤖' : '👤'}</span>
                        <span class="ln">L{c.startLine !== undefined ? `${c.startLine}–${c.line}` : c.line}</span>
                        <span class="md" innerHTML={renderMarkdown(c.body.split('\n')[0] ?? '')} />
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
          <Show when={error()}>
            {(e) => (
              <div class="error">
                {e().message}
                <For each={e().details}>{(d) => <div class="small">• {d}</div>}</For>
              </div>
            )}
          </Show>
          <div class="cf-actions">
            <button class="btn ghost" onClick={() => props.onClose()}>
              Cancel
            </button>
            <button class="btn primary" disabled={busy() || !s().pr || (needsBody() && !body().trim())} onClick={() => void submit()}>
              {busy() ? 'Submitting…' : `Submit to GitHub${s().pending.length ? ` (${s().pending.length})` : ''}`}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
