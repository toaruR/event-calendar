import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';
import { defaultConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { systemClock } from '../clock.ts';
import type { Clock } from '../clock.ts';
import { validateInput } from '../validate.ts';

export interface ApprovalOpts {
  clock?: Clock;
  config?: Pick<Config, 'approval_token_ttl' | 'require_approval'>;
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS approval (
    token TEXT PRIMARY KEY, action TEXT NOT NULL, source_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`);
}

/** Issue a single-use token (TTL approval_token_ttl s) for source_remove / enable_browser. */
export function issueApproval(
  db: DatabaseSync, input: { action: string; source_id: string }, opts: ApprovalOpts = {},
): { approval_token: string; expires_at: string } {
  const cfg = opts.config ?? defaultConfig();
  const clock = opts.clock ?? systemClock;
  validateInput('approval_issue', input);
  if (!cfg.require_approval.includes(input.action)) {
    throw new AppError('INVALID_ARGUMENT', `action does not require approval: ${input.action}`, { action: input.action });
  }
  const src = db.prepare('SELECT id FROM source WHERE id = ?').get(input.source_id);
  if (!src) throw new AppError('NOT_FOUND', `source not found: ${input.source_id}`, { source_id: input.source_id });
  ensureTable(db);
  const token = randomBytes(24).toString('hex');
  const expires = clock.now() + cfg.approval_token_ttl * 1000;
  db.prepare('INSERT INTO approval(token,action,source_id,expires_at) VALUES(?,?,?,?)')
    .run(token, input.action, input.source_id, expires);
  return { approval_token: token, expires_at: new Date(expires).toISOString() };
}

/**
 * Consume a token atomically. true only if it exists, is unused, unexpired (now <= expires_at),
 * and (when given) matches action/source_id. A token is single use: any matching call marks it used.
 */
export function consumeApproval(
  db: DatabaseSync, token: string,
  opts: ApprovalOpts & { action?: string; source_id?: string } = {},
): boolean {
  const clock = opts.clock ?? systemClock;
  ensureTable(db);
  const row = db.prepare('SELECT action,source_id,expires_at FROM approval WHERE token = ?').get(token) as
    { action: string; source_id: string; expires_at: number } | undefined;
  if (!row) return false;
  if (opts.action !== undefined && opts.action !== row.action) return false;
  if (opts.source_id !== undefined && opts.source_id !== row.source_id) return false;
  const r = db.prepare('UPDATE approval SET used = 1 WHERE token = ? AND used = 0 AND expires_at >= ?')
    .run(token, clock.now());
  return Number(r.changes) === 1;
}
