import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.ts';

/** gui_token: 32 random bytes (64 hex chars), regenerated at every start. */
export function generateGuiToken(): string { return randomBytes(32).toString('hex'); }

/** Paths exempt from the token check: calendar export (.ics) and static serving. */
export function isAuthExempt(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (path.startsWith('/calendar/') && path.endsWith('.ics')) return true;
  return path === '/' || path.startsWith('/gui/') || path.startsWith('/static/') || path.startsWith('/assets/');
}

/**
 * Only GUI requests (those carrying X-GUI-Token) are checked. A wrong value -> INVALID_ARGUMENT (no new code).
 * Requests without the header (CLI) are not checked.
 */
export function checkGuiToken(header: string | string[] | undefined, token: string): void {
  if (header === undefined) return;
  const v = Array.isArray(header) ? (header[0] ?? '') : header;
  const a = Buffer.from(v);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('INVALID_ARGUMENT', 'invalid X-GUI-Token', {});
  }
}
