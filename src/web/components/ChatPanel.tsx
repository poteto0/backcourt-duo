import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from 'solid-js';
import type { ChatMessage } from '../../shared/types';
import { api, ApiError } from '../api';
import { renderMarkdown } from '../markdown';
import { chat, composerInsert, hereRef, openFile, snap } from '../store';
import { onRefClick } from './refs';

const STATUS_LABEL: Record<string, string> = {
  disabled: 'Agent disabled',
  starting: 'Starting…',
  thinking: 'Thinking…',
  waiting: 'Your turn',
  error: 'Error',
  stopped: 'Stopped',
  'signed-out': 'Signed out',
};

const QUICK = [
  { label: 'Next file', text: 'Looks good — let’s move on to the next file.' },
  { label: 'Explain this', text: 'Can you explain what this part does and why it changed?' },
  { label: 'Risks?', text: 'What could break here? Think about edge cases and callers.' },
  { label: 'Stage it', text: 'Agreed — please stage that as a pending comment.' },
  { label: 'Wrap up', text: 'Let’s wrap up: summarise the pending comments and draft the overall review.' },
];

export function ChatPanel() {
  const s = () => snap()!;
  const [text, setText] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  let list: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  let stick = true;

  const status = () => s().agent.status;
  const canSend = () => status() === 'waiting' || status() === 'thinking';

  // Auto-scroll while the user is at the bottom.
  createEffect(
    on(
      () => {
        const m = chat.messages;
        return [m.length, m[m.length - 1]?.text.length];
      },
      () => {
        if (stick && list) requestAnimationFrame(() => list!.scrollTo({ top: list!.scrollHeight }));
      },
    ),
  );

  createEffect(
    on(composerInsert, (ins) => {
      if (!ins || !input) return;
      const cur = text();
      const next = cur && !cur.endsWith(' ') && !cur.endsWith('\n') ? `${cur} ${ins.text}` : `${cur}${ins.text}`;
      setText(next);
      input.focus();
      requestAnimationFrame(() => input!.setSelectionRange(next.length, next.length));
    }),
  );

  const send = async (override?: string) => {
    const t = (override ?? text()).trim();
    if (!t) return;
    setError(null);
    try {
      await api.send(t);
      if (override === undefined) setText('');
      stick = true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <aside class="chat">
      <div class="pane-head">
        <span class="who agent big">🤖</span>
        <div class="agent-meta">
          <strong>Review agent</strong>
          <span class="sub">
            {s().agent.auth ? `${s().agent.auth!.mode}${s().agent.auth!.account ? ` · ${s().agent.auth!.account}` : ''}${s().agent.auth!.subscription ? ` · ${s().agent.auth!.subscription}` : ''}` : ''}
            <Show when={!s().agent.models?.length && s().agent.model}> · {s().agent.model}</Show>
          </span>
        </div>
        <Show when={s().agent.models?.length}>
          <ModelPicker onError={setError} />
        </Show>
        <div class="spacer" />
        <span class={`status st-${status()}`}>
          <span class="pulse" />
          {STATUS_LABEL[status()] ?? status()}
        </span>
      </div>

      <Show when={s().warnings.length}>
        <div class="warnings">
          <For each={s().warnings}>{(w) => <div class="warning">⚠️ {w.message}</div>}</For>
        </div>
      </Show>

      <div
        class="messages"
        ref={list}
        onScroll={() => {
          if (list) stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        }}
        onClick={onRefClick}
      >
        <For each={chat.messages}>{(m) => <Message m={m} />}</For>
        <Show when={status() === 'thinking'}>
          <div class="typing">
            <span />
            <span />
            <span />
          </div>
        </Show>
      </div>

      <Switch>
        <Match when={status() === 'signed-out'}>
          <div class="signin">
            <p>{s().agent.error ?? s().agent.auth?.hint ?? 'Sign in to Claude to start the agent.'}</p>
            <button class="btn primary" disabled={s().agent.loginInProgress} onClick={() => void api.claudeLogin().catch((e: Error) => setError(e.message))}>
              {s().agent.loginInProgress ? 'Waiting for browser sign-in…' : 'Sign in with Claude'}
            </button>
            <p class="muted small">
              Uses your Claude subscription through Claude Code. Or run <code>backcourt-duo auth login</code>, or restart with <code>--auth api-key</code>.
            </p>
          </div>
        </Match>
        <Match when={status() === 'error' || status() === 'stopped'}>
          <div class="signin">
            <p>{s().agent.error ?? 'The agent stopped.'}</p>
            <button class="btn" onClick={() => void api.restart()}>
              Restart agent
            </button>
          </div>
        </Match>
      </Switch>

      <div class="composer">
        <div class="quick">
          <For each={QUICK}>
            {(q) => (
              <button class="chip" disabled={!canSend()} onClick={() => void send(q.text)}>
                {q.label}
              </button>
            )}
          </For>
        </div>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
        <div class="box">
          <textarea
            ref={input}
            rows="3"
            placeholder={canSend() ? 'Ask the agent… (Enter to send, Shift+Enter for newline, @path#L10 to reference)' : 'Agent not available'}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div class="box-actions">
            <button class="btn ghost xs" disabled={!hereRef()} title="Insert a reference to what you're looking at" onClick={() => setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${hereRef()} `)}>
              📎 {hereRef() ?? 'here'}
            </button>
            <div class="spacer" />
            <Show when={status() === 'thinking'}>
              <button class="btn ghost xs" onClick={() => void api.interrupt()}>
                ■ Stop
              </button>
            </Show>
            <button class="btn primary xs" disabled={!canSend() || !text().trim()} onClick={() => void send()}>
              Send
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Switches the agent's model for the next turns (PUT /api/agent/model). */
function ModelPicker(props: { onError: (message: string) => void }) {
  const agent = () => snap()!.agent;
  // The server keeps `agent.model` as one of the option values (or a raw id the list doesn't cover).
  const selected = () => agent().model ?? '';
  const known = () => agent().models?.some((m) => m.value === selected()) ?? false;
  return (
    <select
      class="model-select"
      title="Model for the next turns"
      value={selected()}
      disabled={agent().status !== 'waiting' && agent().status !== 'thinking'}
      onChange={(e) => {
        const el = e.currentTarget;
        void api.setModel(el.value).catch((err: Error) => {
          el.value = selected();
          props.onError(err.message);
        });
      }}
    >
      <Show when={!known() && selected()}>
        <option value={selected()}>{selected()}</option>
      </Show>
      <For each={agent().models}>{(m) => <option value={m.value} title={m.description}>{m.displayName}</option>}</For>
    </select>
  );
}

function Message(props: { m: ChatMessage }) {
  return (
    <Switch>
      <Match when={props.m.role === 'tool'}>
        <div classList={{ toolrow: true, error: !!props.m.tool?.isError }}>
          <Show when={props.m.tool?.ref} fallback={<span>{props.m.tool?.summary}</span>}>
            {(ref) => (
              <button class="linklike" onClick={() => openFile(ref().path, { line: ref().startLine, endLine: ref().endLine, select: false })}>
                {props.m.tool?.summary}
              </button>
            )}
          </Show>
        </div>
      </Match>
      <Match when={props.m.role === 'system'}>
        <div class="sysrow md" innerHTML={renderMarkdown(props.m.text)} />
      </Match>
      <Match when={props.m.role === 'human'}>
        <div class="msg human">
          <div class="bubble md" innerHTML={renderMarkdown(props.m.text)} />
        </div>
      </Match>
      <Match when={props.m.role === 'agent'}>
        <div classList={{ msg: true, agent: true, streaming: !!props.m.streaming }}>
          <span class="who agent">🤖</span>
          <div class="bubble md" innerHTML={streamedMarkdown(() => props.m.text)()} />
        </div>
      </Match>
    </Switch>
  );
}

/**
 * Markdown for a message that grows token by token: re-render at most once per animation frame instead of
 * re-parsing the whole message on every delta.
 */
function streamedMarkdown(text: () => string): () => string {
  const [html, setHtml] = createSignal(renderMarkdown(text()));
  let frame = 0;
  createEffect(
    on(text, () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setHtml(renderMarkdown(text()));
      });
    }, { defer: true }),
  );
  onCleanup(() => cancelAnimationFrame(frame));
  return html;
}
