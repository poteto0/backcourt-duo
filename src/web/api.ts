import type { ChangeProposal, ChatEvent, ChatMessage, DiffFile, HelloEvent, PendingComment, ReviewEvent, ReviewState, ReviewStateSnapshot, Side } from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details: string[] = []) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const payload = body !== undefined ? JSON.stringify(body) : method === 'GET' ? undefined : '{}';
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (payload !== undefined) {
    init.body = payload;
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; details?: string[] };
    throw new ApiError(j.error ?? `HTTP ${res.status}`, res.status, j.details ?? []);
  }
  return json as T;
}

export const api = {
  state: () => call<ReviewStateSnapshot>('GET', '/api/state'),
  diff: () => call<DiffFile[]>('GET', '/api/diff'),
  chat: () => call<ChatMessage[]>('GET', '/api/chat'),
  send: (text: string) => call<ChatMessage>('POST', '/api/chat', { text }),
  interrupt: () => call<{ ok: true }>('POST', '/api/agent/interrupt'),
  setModel: (model: string) => call<{ ok: true }>('PUT', '/api/agent/model', { model }),
  restart: () => call<{ ok: true }>('POST', '/api/agent/restart'),
  presence: (c: { path: string; startLine?: number | undefined; endLine?: number | undefined; side?: Side | undefined } | null) => call<{ ok: true }>('PUT', '/api/presence', c),
  follow: (followAgent: boolean) => call<{ ok: true }>('PUT', '/api/follow', { followAgent }),
  reviewState: (path: string, reviewState: ReviewState) => call<{ ok: true }>('PUT', '/api/files/review-state', { path, reviewState }),
  addPending: (c: { path: string; line: number; startLine?: number | undefined; side: Side; body: string }) => call<PendingComment>('POST', '/api/pending', c),
  editPending: (id: string, body: string) => call<PendingComment>('PATCH', `/api/pending/${encodeURIComponent(id)}`, { body }),
  deletePending: (id: string) => call<PendingComment>('DELETE', `/api/pending/${encodeURIComponent(id)}`),
  stageProposal: (id: string) => call<PendingComment>('POST', `/api/proposals/${encodeURIComponent(id)}/stage`),
  dismissProposal: (id: string) => call<ChangeProposal>('DELETE', `/api/proposals/${encodeURIComponent(id)}`),
  submit: (event: ReviewEvent, body: string) => call<{ ok: true; url: string }>('POST', '/api/submit', { event, body }),
  claudeLogin: () => call<{ ok: true }>('POST', '/api/auth/claude/login'),
};

export interface EventHandlers {
  hello: (e: HelloEvent) => void;
  state: (s: ReviewStateSnapshot) => void;
  chat: (e: ChatEvent) => void;
  connection: (connected: boolean) => void;
}

/** SSE with exponential-backoff reconnect (specs/sessions/local-server.md). */
export function connectEvents(h: EventHandlers): () => void {
  let es: EventSource | null = null;
  let delay = 500;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('open', () => {
      delay = 500;
      h.connection(true);
    });
    es.addEventListener('hello', (e) => h.hello(JSON.parse((e as MessageEvent<string>).data) as HelloEvent));
    es.addEventListener('state', (e) => h.state(JSON.parse((e as MessageEvent<string>).data) as ReviewStateSnapshot));
    es.addEventListener('chat', (e) => h.chat(JSON.parse((e as MessageEvent<string>).data) as ChatEvent));
    es.addEventListener('error', () => {
      h.connection(false);
      es?.close();
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    });
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    es?.close();
  };
}
