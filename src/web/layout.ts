import { createSignal } from 'solid-js';

/**
 * How the chat pane is laid out. Display-only state: it lives in the browser
 * (localStorage), never in the ReviewStore.
 */
export type ChatMode = 'docked' | 'maximized' | 'floating';
type Rect = { x: number; y: number; w: number; h: number };
type Saved = { mode: ChatMode; width: number; float: Rect };

const KEY = 'backcourt-duo.layout';
const MIN_W = 300;
const MIN_H = 240;
const MAX_W_RATIO = 0.7;

// A fresh floating window starts against the right edge.
const DEFAULTS: Saved = { mode: 'docked', width: 400, float: { w: 480, h: 640, x: Math.max(0, window.innerWidth - 504), y: 64 } };

function load(): Saved {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>) };
  } catch {
    return DEFAULTS; // storage unavailable or corrupt
  }
}

const initial = load();
const [chatMode, setMode] = createSignal<ChatMode>(initial.mode);
const [chatWidth, setWidth] = createSignal(initial.width);
const [floatRect, setFloat] = createSignal<Rect>(initial.float, {
  equals: (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h,
});
export { chatMode, chatWidth, floatRect };

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ mode: chatMode(), width: chatWidth(), float: floatRect() } satisfies Saved));
  } catch {
    // Not persisting is fine.
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function setChatMode(mode: ChatMode) {
  setMode(mode);
  save();
}

// The geometry setters run on every pointermove, so they only update signals; `drag` saves once on release.
export function setChatWidth(px: number) {
  setWidth(Math.round(clamp(px, MIN_W, window.innerWidth * MAX_W_RATIO)));
}

/** Keeps the floating window on screen and above its minimum size. */
export function setFloatRect(r: Rect) {
  const w = clamp(r.w, MIN_W, window.innerWidth);
  const h = clamp(r.h, MIN_H, window.innerHeight);
  setFloat({ w, h, x: clamp(r.x, 0, window.innerWidth - w), y: clamp(r.y, 0, window.innerHeight - h) });
}

/** Tracks a pointer drag from `e`, calling `move` with the offset from where it started, and saves the layout at the end. */
export function drag(e: PointerEvent, move: (dx: number, dy: number) => void) {
  e.preventDefault();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const stop = new AbortController();
  const end = () => {
    stop.abort();
    document.body.classList.remove('dragging');
    save();
  };
  document.body.classList.add('dragging');
  window.addEventListener('pointermove', (ev) => move(ev.clientX - x0, ev.clientY - y0), { signal: stop.signal });
  window.addEventListener('pointerup', end, { signal: stop.signal });
  window.addEventListener('pointercancel', end, { signal: stop.signal });
}

// Re-clamp after the browser window shrinks so the chat never outgrows or leaves the screen.
window.addEventListener('resize', () => {
  setChatWidth(chatWidth());
  setFloatRect(floatRect());
});
