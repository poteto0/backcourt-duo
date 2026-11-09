import { createSignal } from 'solid-js';

/**
 * How the chat pane is laid out. Display-only state: it lives in the browser
 * (localStorage), never in the ReviewStore.
 */
export type ChatMode = 'docked' | 'maximized' | 'floating';
export type Rect = { x: number; y: number; w: number; h: number };

const KEY = 'backcourt-duo.layout';
const MIN_W = 300;
const MIN_H = 240;

type Saved = { mode: ChatMode; width: number; float: Rect };

const DEFAULTS: Saved = { mode: 'docked', width: 400, float: { x: 0, y: 0, w: 480, h: 640 } };

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Saved>) };
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
  }
  // Start a fresh floating window against the right edge.
  return { ...DEFAULTS, float: { ...DEFAULTS.float, x: Math.max(0, window.innerWidth - DEFAULTS.float.w - 24), y: 64 } };
}

const initial = load();
const [chatMode, setMode] = createSignal<ChatMode>(initial.mode);
const [chatWidth, setWidth] = createSignal(initial.width);
const [floatRect, setFloat] = createSignal<Rect>(initial.float);
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

export function setChatWidth(px: number) {
  setWidth(Math.round(clamp(px, MIN_W, window.innerWidth * 0.7)));
  save();
}

/** Keeps the floating window at least partly on screen and above its minimum size. */
export function setFloatRect(r: Rect) {
  const w = clamp(r.w, MIN_W, window.innerWidth);
  const h = clamp(r.h, MIN_H, window.innerHeight);
  setFloat({ w, h, x: clamp(r.x, 0, window.innerWidth - w), y: clamp(r.y, 0, window.innerHeight - h) });
  save();
}

/** Tracks a pointer drag from `e`, calling `move` with the offset from where it started. */
export function drag(e: PointerEvent, move: (dx: number, dy: number) => void) {
  e.preventDefault();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const onMove = (ev: PointerEvent) => move(ev.clientX - x0, ev.clientY - y0);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.classList.remove('dragging');
  };
  document.body.classList.add('dragging');
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Re-clamp after the browser window shrinks so the floating chat never ends up off screen.
window.addEventListener('resize', () => {
  if (chatMode() === 'floating') setFloatRect(floatRect());
});
