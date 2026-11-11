// Shared notes (論点メモ) — the human's view of what the agent keeps across context resets (specs/architecture.md#論点メモ).
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { Actor, ReviewNote } from '../../shared/types';
import { api, errorMessage } from '../api';
import { refChip, renderMarkdown } from '../markdown';
import { snap } from '../store';
import { onRefClick } from './refs';

const WHO: Record<Actor, { icon: string; title: string }> = { agent: { icon: '🤖', title: 'agent' }, human: { icon: '👤', title: 'you' } };

export function NotesPanel() {
  const notes = () => snap()!.notes;
  const open = createMemo(() => notes().filter((n) => !n.resolved));
  const resolved = createMemo(() => notes().filter((n) => n.resolved));
  const [showResolved, setShowResolved] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const add = () => {
    const text = draft().trim();
    if (text) void run(() => api.addNote(text).then(() => setDraft('')));
  };

  return (
    <details class="notes">
      <summary title="Discussion points and memos the agent keeps when its conversation is cleared">
        📝 Notes <span class="tag">{open().length}</span>
        <Show when={resolved().length}>
          <span class="sub"> · {resolved().length} resolved</span>
        </Show>
      </summary>
      <div class="notes-body" onClick={onRefClick}>
        <For each={open()}>{(n) => <Note n={n} run={run} />}</For>
        <Show when={resolved().length}>
          <button class="btn ghost xs" onClick={() => setShowResolved(!showResolved())}>
            {showResolved() ? 'Hide' : 'Show'} resolved ({resolved().length})
          </button>
          <Show when={showResolved()}>
            <For each={resolved()}>{(n) => <Note n={n} run={run} />}</For>
          </Show>
        </Show>
        <div class="note-add">
          <input
            placeholder="Add a note (e.g. “X is intentional”, @path#L10)…"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.isComposing) add();
            }}
          />
          <button class="btn xs" disabled={!draft().trim()} onClick={add}>
            Add
          </button>
        </div>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
      </div>
    </details>
  );
}

function Note(props: { n: ReviewNote; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = createSignal<string | null>(null);
  const save = () => {
    const text = editing()?.trim();
    if (text) void props.run(() => api.editNote(props.n.id, { text }).then(() => setEditing(null)));
  };
  return (
    <div classList={{ note: true, resolved: props.n.resolved }}>
      <span class={`who ${props.n.author}`} title={WHO[props.n.author].title}>
        {WHO[props.n.author].icon}
      </span>
      <div class="note-main">
        <Show when={props.n.ref}>{(ref) => <span innerHTML={refChip(ref())} />}</Show>
        <Show when={editing() !== null} fallback={<div class="md" innerHTML={renderMarkdown(props.n.text)} />}>
          <textarea
            rows={3}
            value={editing()!}
            onInput={(e) => setEditing(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
              if (e.key === 'Escape') setEditing(null);
            }}
          />
          <div class="cf-actions">
            <button class="btn xs primary" onClick={save}>
              Save
            </button>
            <button class="btn ghost xs" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </Show>
      </div>
      <Show when={editing() === null}>
        <div class="note-actions">
          <button class="btn ghost xs" title={props.n.resolved ? 'Reopen' : 'Resolve'} onClick={() => void props.run(() => api.editNote(props.n.id, { resolved: !props.n.resolved }))}>
            {props.n.resolved ? '↺' : '✓'}
          </button>
          <button class="btn ghost xs" title="Edit" onClick={() => setEditing(props.n.text)}>
            ✎
          </button>
          <button class="btn ghost xs danger" title="Delete" onClick={() => void props.run(() => api.deleteNote(props.n.id))}>
            🗑
          </button>
        </div>
      </Show>
    </div>
  );
}
