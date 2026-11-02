// Client-side mirror of the server ReviewStore + local view state.
import { batch, createMemo, createRoot, createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { api, connectEvents } from './api';
import type { ChatEvent, ChatMessage, Cursor, DiffFile, PendingComment, ReviewStateSnapshot, Side } from '../shared/types';
import { formatRef } from '../shared/types';
import { looksLikeOtherLanguage } from '../shared/language';

export interface Selection {
  path: string;
  side: Side;
  start: number;
  end: number;
}

const [state, setState] = createStore<{ s: ReviewStateSnapshot | null }>({ s: null });
const [chat, setChat] = createStore<{ messages: ChatMessage[] }>({ messages: [] });
const [diff, setDiff] = createSignal<DiffFile[]>([]);
const [connected, setConnected] = createSignal(false);
/** File shown in the center pane. */
const [viewPath, setViewPathRaw] = createSignal<string | null>(null);
/** Human line selection (synced to presence). */
const [selection, setSelectionRaw] = createSignal<Selection | null>(null);
/** Increments to ask DiffView to scroll to a line. */
const [scrollRequest, setScrollRequest] = createSignal<{ path: string; line?: number | undefined; side?: Side | undefined; seq: number } | null>(null);
/** Text to insert into the chat composer. */
const [composerInsert, setComposerInsert] = createSignal<{ text: string; seq: number } | null>(null);

export { state, chat, diff, connected, viewPath, selection, scrollRequest, composerInsert };

let bootId: string | null = null;
let seq = 0;
let lastAgentAt: string | null = null;

export const snap = () => state.s;

/** The human selection when it is on the file being viewed, else null. */
export const currentSelection = createRoot(() => createMemo(() => {
  const sel = selection();
  return sel && sel.path === viewPath() ? sel : null;
}));

/** `@path#Lx-Ly` for what the human is looking at (shared by the diff header and the chat composer). */
export const hereRef = createRoot(() => createMemo(() => {
  const path = viewPath();
  if (!path) return null;
  const sel = currentSelection();
  return formatRef(sel ? { path, startLine: sel.start, endLine: sel.end } : { path });
}));

// ------------------------------------------------------------ presence sync (debounced)
let presenceTimer: ReturnType<typeof setTimeout> | undefined;
function pushPresence(): void {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    const path = viewPath();
    if (!path) return void api.presence(null).catch(() => undefined);
    const sel = currentSelection();
    void api.presence(sel ? { path, startLine: sel.start, endLine: sel.end, side: sel.side } : { path }).catch(() => undefined);
    writeHash(path, sel);
  }, 250);
}

function writeHash(path: string, sel: Selection | null): void {
  const h = `#${encodeURI(path)}${sel ? `:${sel.side === 'LEFT' ? 'O' : 'L'}${sel.start}${sel.end !== sel.start ? `-L${sel.end}` : ''}` : ''}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

function readHash(): { path: string; sel: Selection | null } | null {
  const raw = decodeURI(location.hash.slice(1));
  if (!raw) return null;
  const m = /^(.*?)(?::(L|O)(\d+)(?:-L(\d+))?)?$/.exec(raw);
  if (!m || !m[1]) return null;
  const path = m[1];
  if (!m[3]) return { path, sel: null };
  const start = Number(m[3]);
  return { path, sel: { path, side: m[2] === 'O' ? 'LEFT' : 'RIGHT', start, end: m[4] ? Number(m[4]) : start } };
}

/** Human navigates to a file (and optionally a line). Turning off follow mode when diverging from the agent. */
export function openFile(path: string, opts: { line?: number | undefined; endLine?: number | undefined; side?: Side | undefined; fromAgent?: boolean; select?: boolean } = {}): void {
  batch(() => {
    setViewPathRaw(path);
    if (opts.line !== undefined && opts.select !== false) {
      setSelectionRaw({ path, side: opts.side ?? 'RIGHT', start: opts.line, end: opts.endLine ?? opts.line });
    } else if (selection()?.path !== path) {
      setSelectionRaw(null);
    }
    setScrollRequest({ path, line: opts.line, side: opts.side, seq: ++seq });
  });
  const s = state.s;
  if (!opts.fromAgent && s?.followAgent && s.presence.agent && s.presence.agent.path !== path) {
    void api.follow(false);
  }
  pushPresence();
}

export function setSelection(sel: Selection | null): void {
  setSelectionRaw(sel);
  pushPresence();
}

/** A pending comment that seems to be in another language than `language.review` (heuristic, UI hint only). */
export function inOtherLanguage(c: PendingComment): boolean {
  const review = state.s?.language.review;
  return !!review && looksLikeOtherLanguage(c.body, review.tag);
}

export function insertIntoComposer(text: string): void {
  setComposerInsert({ text, seq: ++seq });
}

export function setFollow(v: boolean): void {
  void api.follow(v);
  const a = state.s?.presence.agent;
  if (v && a) followCursor(a);
}

function followCursor(a: Cursor): void {
  openFile(a.path, { line: a.startLine, side: a.side, select: false, fromAgent: true });
}

// ------------------------------------------------------------ server events
function applyState(s: ReviewStateSnapshot): void {
  setState('s', reconcile(s, { key: 'id', merge: true }));
  const a = s.presence.agent;
  if (a && a.at !== lastAgentAt) {
    lastAgentAt = a.at;
    if (s.followAgent) followCursor(a);
  }
  if (!viewPath()) {
    const first = s.plan?.files[0]?.path ?? s.files[0]?.path;
    if (first) openFile(first, { fromAgent: true });
  }
}

/** Streaming targets are almost always the newest messages: search from the end. */
const chatIndex = (id: string) => chat.messages.findLastIndex((m) => m.id === id);

function applyChat(e: ChatEvent): void {
  if (e.type === 'append') {
    setChat('messages', chat.messages.length, e.message);
    return;
  }
  const idx = chatIndex(e.type === 'delta' ? e.id : e.message.id);
  if (idx < 0) return;
  if (e.type === 'delta') setChat('messages', idx, 'text', (t) => t + e.text);
  else setChat('messages', idx, reconcile(e.message));
}

export async function boot(): Promise<void> {
  const [d, c] = await Promise.all([api.diff(), api.chat()]);
  setDiff(d);
  setChat('messages', c);
  const fromHash = readHash();
  if (fromHash && d.some((f) => f.path === fromHash.path)) {
    setViewPathRaw(fromHash.path);
    if (fromHash.sel) setSelectionRaw(fromHash.sel);
    setScrollRequest({ path: fromHash.path, line: fromHash.sel?.start, side: fromHash.sel?.side, seq: ++seq });
  }
  connectEvents({
    hello: (h) => {
      if (bootId && bootId !== h.bootId) location.reload();
      bootId = h.bootId;
    },
    state: applyState,
    chat: applyChat,
    connection: (ok) => {
      setConnected(ok);
      // Resync chat after reconnects (events may have been missed).
      if (ok && bootId) void api.chat().then((m) => setChat('messages', m));
    },
  });
  if (fromHash) pushPresence();
}
