import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from 'solid-js';
import type { AgentUsage, ChatMessage, EffortLevel } from '../../shared/types';
import { api, ApiError } from '../api';
import { renderMarkdown } from '../markdown';
import { chat, composerInsert, hereRef, openFile, snap } from '../store';
import { onRefClick } from './refs';
import { chatMode, drag, floatRect, setChatMode, setFloatRect, type ChatMode } from '../layout';
import { describeLanguage, languageName } from '../../shared/language';

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
    <aside
      classList={{ chat: true, floating: chatMode() === 'floating' }}
      style={chatMode() === 'floating' ? { left: `${floatRect().x}px`, top: `${floatRect().y}px`, width: `${floatRect().w}px`, height: `${floatRect().h}px` } : {}}
    >
      <div
        class="pane-head"
        onPointerDown={(e) => {
          // The header is the floating window's title bar; leave its controls clickable.
          if (chatMode() !== 'floating' || (e.target as Element).closest('button, select')) return;
          const r0 = floatRect();
          drag(e, (dx, dy) => setFloatRect({ ...r0, x: r0.x + dx, y: r0.y + dy }));
        }}
      >
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
          <EffortPicker onError={setError} />
        </Show>
        <LanguagePicker onError={setError} />
        <div class="spacer" />
        <span class={`status st-${status()}`}>
          <span class="pulse" />
          {STATUS_LABEL[status()] ?? status()}
        </span>
        <LayoutButtons />
      </div>

      <UsageMeter usage={s().agent.usage} />

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

      <Show when={chatMode() === 'floating'}>
        <div
          class="resize-grip"
          title="Drag to resize"
          onPointerDown={(e) => {
            const r0 = floatRect();
            drag(e, (dx, dy) => setFloatRect({ ...r0, w: r0.w + dx, h: r0.h + dy }));
          }}
        />
      </Show>
    </aside>
  );
}

const LAYOUTS: { mode: ChatMode; icon: string; title: string }[] = [
  { mode: 'maximized', icon: '⤢', title: 'Maximize the chat (hide the diff)' },
  { mode: 'floating', icon: '⧉', title: 'Float the chat in a movable window' },
];

/** Toggles between the docked pane and the maximized / floating layouts. */
function LayoutButtons() {
  return (
    <div class="layout-btns">
      <For each={LAYOUTS}>
        {(l) => (
          <button
            class="btn ghost xs"
            classList={{ on: chatMode() === l.mode }}
            title={chatMode() === l.mode ? 'Dock the chat back into its pane' : l.title}
            onClick={() => setChatMode(chatMode() === l.mode ? 'docked' : l.mode)}
          >
            {chatMode() === l.mode ? '⇥' : l.icon}
          </button>
        )}
      </For>
    </div>
  );
}

type SelectOption = { value: string; label: string; title?: string };

/** A header select that switches a setting; reverts and reports when the server refuses. */
function HeaderSelect(props: { title: string; value: string; options: SelectOption[]; apply: (value: string) => Promise<unknown>; onError: (message: string) => void; disabled?: boolean }) {
  return (
    <select
      class="model-select"
      title={props.title}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        const el = e.currentTarget;
        void props.apply(el.value).catch((err: Error) => {
          el.value = props.value;
          props.onError(err.message);
        });
      }}
    >
      {/* Keep a value the list doesn't cover (e.g. a raw model id) selectable. */}
      <Show when={props.value && !props.options.some((o) => o.value === props.value)}>
        <option value={props.value}>{props.value}</option>
      </Show>
      <For each={props.options}>{(o) => <option value={o.value} title={o.title}>{o.label}</option>}</For>
    </select>
  );
}

/** Model and effort can only be switched on a running agent. */
const agentDown = () => {
  const status = snap()!.agent.status;
  return status !== 'waiting' && status !== 'thinking';
};

/** Switches the agent's model for the next turns (PUT /api/agent/model). */
function ModelPicker(props: { onError: (message: string) => void }) {
  const agent = () => snap()!.agent;
  // The server keeps `agent.model` as one of the option values (or a raw id the list doesn't cover).
  return (
    <HeaderSelect
      disabled={agentDown()}
      title="Model for the next turns"
      value={agent().model ?? ''}
      options={(agent().models ?? []).map((m) => ({ value: m.value, label: m.displayName, title: m.description }))}
      apply={api.setModel}
      onError={props.onError}
    />
  );
}

/** Switches the reasoning effort for the next turns (PUT /api/agent/effort); hidden when the model has no effort control. */
function EffortPicker(props: { onError: (message: string) => void }) {
  const agent = () => snap()!.agent;
  const levels = createMemo(() => agent().models?.find((m) => m.value === agent().model)?.supportedEffortLevels ?? []);
  return (
    <Show when={levels().length}>
      <HeaderSelect
        disabled={agentDown()}
        title="Reasoning effort for the next turns"
        value={agent().effort ?? ''}
        options={[{ value: '', label: 'effort: default' }, ...levels().map((l) => ({ value: l, label: `effort: ${l}` }))]}
        apply={(v) => api.setEffort((v || null) as EffortLevel | null)}
        onError={props.onError}
      />
    </Show>
  );
}

const LANGUAGES = ['en', 'ja', 'zh-Hans', 'zh-Hant', 'ko', 'es', 'fr', 'de', 'pt', 'it', 'ru', 'vi', 'id'];
const languageOptions = (icon: string, auto: string): SelectOption[] => [
  { value: '', label: `${icon} auto`, title: auto },
  ...LANGUAGES.map((t) => ({ value: t, label: `${icon} ${t}`, title: languageName(t) })),
];
const CHAT_LANGUAGE_OPTIONS = languageOptions('💬', 'Follows the language you write in');
const REVIEW_LANGUAGE_OPTIONS = languageOptions('📝', 'Follows the chat language, else the PR’s');

/** Chat (💬) and review (📝) languages (PUT /api/language, one side at a time); saved to the user config. */
function LanguagePicker(props: { onError: (message: string) => void }) {
  const language = () => snap()!.language;
  // A review that only follows chat shows as auto.
  const reviewTag = () => (language().review?.source === 'chat' ? '' : (language().review?.tag ?? ''));
  const title = (what: string) => `${what}\n${describeLanguage(language())}\nSaved to ~/.backcourt-duo/config.json (--lang / env / .backcourt-duo.json still win at startup)`;
  return (
    <>
      <HeaderSelect
        title={title('Chat language')}
        value={language().conversation?.tag ?? ''}
        options={CHAT_LANGUAGE_OPTIONS}
        apply={(v) => api.setLanguage({ conversation: v || null })}
        onError={props.onError}
      />
      <HeaderSelect
        title={title('Review language (what is posted to GitHub)')}
        value={reviewTag()}
        options={REVIEW_LANGUAGE_OPTIONS}
        apply={(v) => api.setLanguage({ review: v || null })}
        onError={props.onError}
      />
    </>
  );
}

const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
  seven_day_overage_included: '7d',
  overage: 'extra',
};
/** Below this share left, a meter turns to the warning colour. */
const LOW_LEFT = 0.2;

/** Share as a whole percent, clamped to 0–100%. */
const pct = (fraction: number) => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

function resetLabel(at: number): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** What the agent has left: context window, plan limits (subscription) and cost (API key). Always on once known. */
function UsageMeter(props: { usage: AgentUsage }) {
  // A window whose reset time has passed says nothing about now.
  const limits = () => props.usage.limits.filter((w) => w.resetsAt === undefined || w.resetsAt > Date.now());
  return (
    <Show when={props.usage.context || limits().length || props.usage.costUSD !== undefined}>
      <div class="usage">
        <Show when={props.usage.context}>
          {(c) => <Meter label="context" left={1 - c().used / c().max} title={`Context window: ${c().used.toLocaleString()} / ${c().max.toLocaleString()} tokens used`} />}
        </Show>
        <For each={limits()}>
          {(w) => (
            <Meter
              label={LIMIT_LABEL[w.kind] ?? w.kind}
              left={w.status === 'rejected' ? 0 : 1 - w.utilization}
              title={`Plan limit (${w.kind}): ${pct(w.utilization)} used`}
              suffix={w.resetsAt === undefined ? '' : ` · resets ${resetLabel(w.resetsAt)}`}
            />
          )}
        </For>
        <Show when={props.usage.costUSD !== undefined}>
          <span class="meter" title="Cost of this agent session so far">${props.usage.costUSD!.toFixed(2)}</span>
        </Show>
      </div>
    </Show>
  );
}

function Meter(props: { label: string; left: number; title: string; suffix?: string }) {
  return (
    <span classList={{ meter: true, low: props.left < LOW_LEFT }} title={props.title}>
      {props.label} <span class="bar"><span class="fill" style={{ width: pct(props.left) }} /></span> {pct(props.left)} left{props.suffix ?? ''}
    </span>
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
