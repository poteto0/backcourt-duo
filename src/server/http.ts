// Hono app: REST + SSE + static UI (specs/architecture.md, specs/sessions/local-server.md)
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SESSION_COOKIE, type LocalSession } from './auth/local.js';
import { StoreError, type ReviewStore } from './store.js';
import type { AgentSession } from './agent/session.js';
import { LoginBusyError } from './auth/claude-login.js';
import { GitHubError, submitReview } from './github.js';
import type { ResolvedGitHubAuth } from './auth/github.js';
import type { AgentAuthMode, HelloEvent } from '../shared/types.js';
import { CursorSchema, PendingCreateSchema, ReviewEventSchema, ReviewStateSchema } from './schemas.js';
import { VERSION } from './version.js';

export interface AppDeps {
  store: ReviewStore;
  session: LocalSession;
  agent: AgentSession | null;
  github: ResolvedGitHubAuth | null;
  authMode: AgentAuthMode;
  webRoot: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function createApp(deps: AppDeps): Hono {
  const { store, session } = deps;
  const app = new Hono();
  const bootId = randomUUID();

  // --- DNS-rebinding guard (all routes)
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!session.allowedHosts.has(host)) return c.text('Misdirected request', 421);
    await next();
  });

  // --- launch URL: exchange ?token= for a cookie, then strip it from the URL
  app.get('/', async (c, next) => {
    const t = c.req.query('token');
    if (t !== undefined) {
      if (!session.matches(t)) return c.html(lockedPage('That link has expired. Use the URL printed in the terminal.'), 401);
      setCookie(c, SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'Strict', path: '/' });
      return c.redirect('/', 302);
    }
    if (!session.matches(getCookie(c, SESSION_COOKIE))) return c.html(lockedPage('Open the URL printed in the terminal (it contains a one-time session token).'), 401);
    await next();
  });

  // --- API auth + CSRF guard
  app.use('/api/*', async (c, next) => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!session.matches(getCookie(c, SESSION_COOKIE)) && !session.matches(bearer)) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (!origin || !session.allowedOrigins.has(origin)) return c.json({ error: 'bad origin' }, 403);
      if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return c.json({ error: 'content-type must be application/json' }, 415);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof StoreError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => schema.parse(await c.req.json());

  // ------------------------------------------------------------ read
  app.get('/api/state', (c) => c.json(store.snapshot()));
  app.get('/api/diff', (c) => c.json(store.diff));
  app.get('/api/chat', (c) => c.json(store.chat));

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const hello: HelloEvent = { version: VERSION, bootId };
      await stream.writeSSE({ event: 'hello', data: JSON.stringify(hello) });
      await stream.writeSSE({ event: 'state', data: JSON.stringify(store.snapshot()) });
      const onState = (data: string) => void stream.writeSSE({ event: 'state', data });
      const onChat = (data: string) => void stream.writeSSE({ event: 'chat', data });
      store.on('state', onState);
      store.on('chat', onChat);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n'), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      store.off('state', onState);
      store.off('chat', onChat);
    }),
  );

  // ------------------------------------------------------------ chat / agent
  app.post('/api/chat', async (c) => {
    const { text } = await body(c, z.object({ text: z.string().min(1).max(20_000) }));
    if (!deps.agent?.running) return c.json({ error: 'the agent is not running' }, 409);
    return c.json(deps.agent.sendHuman(text));
  });
  app.post('/api/agent/interrupt', async (c) => {
    await deps.agent?.interrupt();
    return c.json({ ok: true });
  });
  app.put('/api/agent/model', async (c) => {
    const { model } = await body(c, z.object({ model: z.string().min(1).max(200) }));
    if (!deps.agent?.running) return c.json({ error: 'the agent is not running' }, 409);
    await deps.agent.setModel(model);
    return c.json({ ok: true });
  });
  app.post('/api/agent/restart', async (c) => {
    if (!deps.agent) return c.json({ error: 'agent disabled (--no-agent)' }, 409);
    await deps.agent.restart();
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ presence / files
  app.put('/api/presence', async (c) => {
    store.setCursor('human', await body(c, CursorSchema.nullable()));
    return c.json({ ok: true });
  });
  app.put('/api/follow', async (c) => {
    const { followAgent } = await body(c, z.object({ followAgent: z.boolean() }));
    store.setFollowAgent(followAgent);
    return c.json({ ok: true });
  });
  app.put('/api/files/review-state', async (c) => {
    const { path, reviewState } = await body(c, z.object({ path: z.string(), reviewState: ReviewStateSchema }));
    store.setReviewState(path, reviewState, 'human');
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ pending
  app.post('/api/pending', async (c) => {
    const input = await body(c, PendingCreateSchema);
    return c.json(store.addPending({ ...input, author: 'human' }));
  });
  app.patch('/api/pending/:id', async (c) => {
    const { body: text } = await body(c, z.object({ body: z.string().min(1) }));
    return c.json(store.updatePending(c.req.param('id'), text, 'human'));
  });
  app.delete('/api/pending/:id', (c) => c.json(store.deletePending(c.req.param('id'), 'human')));

  // ------------------------------------------------------------ submit
  app.post('/api/submit', async (c) => {
    const { event, body: reviewBody } = await body(c, z.object({ event: ReviewEventSchema, body: z.string().max(65_000) }));
    const pr = store.pr;
    const { owner, repo } = store.github;
    if (!pr || !owner || !repo) return c.json({ error: 'No pull request to submit to.' }, 409);
    if (!deps.github?.token) return c.json({ error: 'Not authenticated with GitHub. Run `gh auth login` and restart.' }, 409);
    try {
      const count = store.pending.length;
      const { url } = await submitReview(deps.github, owner, repo, pr.number, { event, body: reviewBody, comments: store.pending, commitId: pr.headSha });
      store.clearPendingAfterSubmit({ url, at: new Date().toISOString(), count, event });
      store.appendChat(store.makeMessage('system', `🚀 Review submitted (${event}, ${count} comment${count === 1 ? '' : 's'}): ${url}`));
      return c.json({ ok: true, url });
    } catch (err) {
      if (err instanceof GitHubError) return c.json({ error: err.message, details: err.details }, err.status >= 400 && err.status < 500 ? 422 : 502);
      throw err;
    }
  });

  // ------------------------------------------------------------ auth
  app.post('/api/auth/claude/login', async (c) => {
    if (deps.authMode !== 'claude-code') return c.json({ error: 'sign-in is only used in claude-code mode' }, 409);
    if (!deps.agent) return c.json({ error: 'agent disabled (--no-agent)' }, 409);
    try {
      await deps.agent.signIn();
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof LoginBusyError ? 409 : 500);
    }
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ static UI
  app.get('*', async (c) => {
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const isAsset = rel.startsWith('assets/') || /\.(svg|png|ico)$/.test(rel);
    if (!isAsset && !session.matches(getCookie(c, SESSION_COOKIE))) return c.html(lockedPage('Open the URL printed in the terminal.'), 401);
    const file = join(deps.webRoot, isAsset ? rel : 'index.html');
    if (!file.startsWith(deps.webRoot)) return c.text('not found', 404);
    try {
      const data = await readFile(file);
      return c.body(data, 200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-store' });
    } catch {
      if (!isAsset) return c.html(lockedPage('The web UI is not built. Run `pnpm build`.'), 500);
      return c.text('not found', 404);
    }
  });

  return app;
}

function lockedPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>backcourt-duo</title>
<style>body{font:15px system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}main{max-width:32rem;text-align:center}</style>
</head><body><main><h1>🏀 backcourt-duo</h1><p>${message.replace(/[<>&]/g, '')}</p></main></body></html>`;
}
