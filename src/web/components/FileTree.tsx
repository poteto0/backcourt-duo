import { createMemo, For, Show } from 'solid-js';
import type { FileEntry, Priority } from '../../shared/types';
import { api } from '../api';
import { openFile, snap, viewPath } from '../store';

type Order = 'plan' | 'path';

const STATUS_ICON: Record<FileEntry['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C' };

export function FileTree(props: { order: Order; onOrder: (o: Order) => void }) {
  const s = () => snap()!;
  const planInfo = createMemo(() => new Map(s().plan?.files.map((p, i) => [p.path, { ...p, index: i }]) ?? []));
  const files = createMemo(() => {
    const list = [...s().files];
    if (props.order === 'plan' && s().plan) {
      const info = planInfo();
      list.sort((a, b) => (info.get(a.path)?.index ?? 1e9) - (info.get(b.path)?.index ?? 1e9));
    }
    return list;
  });
  const pendingCount = (path: string) => s().pending.filter((c) => c.path === path).length;

  return (
    <nav class="filetree">
      <div class="pane-head">
        <span>Files</span>
        <div class="seg">
          <button classList={{ on: props.order === 'plan' }} disabled={!s().plan} onClick={() => props.onOrder('plan')} title="Agent's reading order">
            Plan
          </button>
          <button classList={{ on: props.order === 'path' }} onClick={() => props.onOrder('path')}>
            A–Z
          </button>
        </div>
      </div>
      <Show when={s().plan}>
        {(plan) => <p class="plan-summary">{plan().summary}</p>}
      </Show>
      <ul>
        <For each={files()}>
          {(f) => {
            const info = () => planInfo().get(f.path);
            const agentHere = () => s().presence.agent?.path === f.path;
            const humanHere = () => viewPath() === f.path;
            const dir = () => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '');
            const base = () => f.path.slice(f.path.lastIndexOf('/') + 1);
            return (
              <li
                classList={{ file: true, active: humanHere(), reviewed: f.reviewState === 'reviewed', agent: agentHere() }}
                title={info()?.note ?? f.path}
              >
                <input
                  type="checkbox"
                  checked={f.reviewState === 'reviewed'}
                  title="Viewed"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => void api.reviewState(f.path, e.currentTarget.checked ? 'reviewed' : 'in-progress')}
                />
                <button class="file-btn" onClick={() => openFile(f.path)}>
                  <span class={`st st-${f.status}`}>{STATUS_ICON[f.status]}</span>
                  <span class="name">
                    <Show when={props.order === 'plan' && info()}>
                      <span class={`prio prio-${info()!.priority as Priority}`}>{info()!.index + 1}</span>
                    </Show>
                    <span class="dir">{dir()}</span>
                    <span class="base">{base()}</span>
                  </span>
                  <span class="badges">
                    <Show when={pendingCount(f.path)}>
                      <span class="pc" title="pending comments">💬{pendingCount(f.path)}</span>
                    </Show>
                    <Show when={agentHere()}>
                      <span class="who agent" title="Agent is here">🤖</span>
                    </Show>
                    <Show when={humanHere()}>
                      <span class="who human" title="You are here">👤</span>
                    </Show>
                  </span>
                </button>
                <span class="stat">
                  <span class="add">+{f.additions}</span> <span class="del">-{f.deletions}</span>
                </span>
              </li>
            );
          }}
        </For>
      </ul>
    </nav>
  );
}
