import { For, Show } from 'solid-js';
import type { Phase } from '../../shared/types';
import { connected, snap } from '../store';

const PHASES: Array<{ id: Phase; label: string }> = [
  { id: 'preparing', label: 'Prepare' },
  { id: 'walkthrough', label: 'Walkthrough' },
  { id: 'wrapup', label: 'Wrap-up' },
  { id: 'idle', label: 'Submitted' },
];

export function Header(props: { onSubmit: () => void }) {
  const s = () => snap()!;
  const reviewed = () => s().files.filter((f) => f.reviewState === 'reviewed').length;
  const phaseIndex = () => PHASES.findIndex((p) => p.id === s().phase);
  return (
    <header class="topbar">
      <div class="brand" title="backcourt-duo">
        <span class="ball">🏀</span>
        <span class="brand-name">backcourt-duo</span>
      </div>
      <div class="target">
        <span class="repo">{s().github.owner ? `${s().github.owner}/${s().github.repo}` : s().target.repoName}</span>
        <span class="refs">
          <code>{s().target.base}</code>
          <span class="dots">…</span>
          <code>{s().target.branch ?? s().target.head}</code>
        </span>
        <Show when={s().pr} fallback={<span class="pr none">no PR</span>}>
          {(pr) => (
            <a class="pr" href={pr().url} target="_blank" rel="noreferrer" title={pr().title}>
              #{pr().number} {pr().title}
            </a>
          )}
        </Show>
      </div>
      <ol class="phases" aria-label="Review phase">
        <For each={PHASES}>
          {(p, i) => (
            <li classList={{ done: i() < phaseIndex(), current: i() === phaseIndex() }}>
              <span class="dot" />
              {p.label}
            </li>
          )}
        </For>
      </ol>
      <div class="spacer" />
      <div class="progress" title="Files reviewed">
        <div class="bar">
          <div class="fill" style={{ width: `${s().files.length ? (reviewed() / s().files.length) * 100 : 0}%` }} />
        </div>
        <span>
          {reviewed()}/{s().files.length} viewed
        </span>
      </div>
      <Show when={!connected()}>
        <span class="offline">reconnecting…</span>
      </Show>
      <button class="btn primary submit" onClick={() => props.onSubmit()} disabled={!s().pr}>
        Submit review
        <span class="count">{s().pending.length}</span>
      </button>
    </header>
  );
}
