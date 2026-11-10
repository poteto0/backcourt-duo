import { createSignal, onMount, Show } from 'solid-js';
import { boot, snap } from './store';
import { Header } from './components/Header';
import { FileTree } from './components/FileTree';
import { DiffView } from './components/DiffView';
import { ChatPanel } from './components/ChatPanel';
import { SubmitDialog } from './components/SubmitDialog';
import { chatMode, chatWidth, drag, setChatWidth } from './layout';

export function App() {
  const [error, setError] = createSignal<string | null>(null);
  const [submitOpen, setSubmitOpen] = createSignal(false);
  const [order, setOrder] = createSignal<'plan' | 'path'>('plan');

  onMount(() => {
    boot().catch((e: Error) => setError(e.message));
  });

  return (
    <Show when={snap()} fallback={<div class="splash">{error() ? `⚠️ ${error()}` : '🏀 Loading…'}</div>}>
      <div class="app">
        <Header onSubmit={() => setSubmitOpen(true)} />
        <main class={`panes chat-${chatMode()}`} style={{ '--chat-w': `${chatWidth()}px` }}>
          <FileTree order={snap()!.plan ? order() : 'path'} onOrder={setOrder} />
          <DiffView />
          <div
            class="splitter"
            title="Drag to resize the chat"
            onPointerDown={(e) => {
              const w0 = chatWidth();
              drag(e, (dx) => setChatWidth(w0 - dx));
            }}
          />
          <ChatPanel />
        </main>
        <Show when={submitOpen()}>
          <SubmitDialog onClose={() => setSubmitOpen(false)} />
        </Show>
      </div>
    </Show>
  );
}
