// Local server session — specs/sessions/local-server.md
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'bd_session';

export class LocalSession {
  readonly token = randomBytes(32).toString('base64url');
  readonly allowedHosts: Set<string>;
  readonly allowedOrigins: Set<string>;

  constructor(readonly port: number) {
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
    this.allowedHosts = new Set(hosts);
    this.allowedOrigins = new Set(hosts.map((h) => `http://${h}`));
  }

  matches(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  launchUrl(): string {
    return `http://localhost:${this.port}/?token=${this.token}`;
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
