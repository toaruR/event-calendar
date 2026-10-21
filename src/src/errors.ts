export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FETCH_FAILED'
  | 'NOT_FOUND'
  | 'ZERO_ITEMS'
  | 'SSRF_BLOCKED'
  | 'ROBOTS_DISALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'CONFLICT'
  | 'DAEMON_UNAVAILABLE';

export const ERROR_CODES: readonly ErrorCode[] = [
  'INVALID_ARGUMENT', 'FETCH_FAILED', 'NOT_FOUND', 'ZERO_ITEMS', 'SSRF_BLOCKED',
  'ROBOTS_DISALLOWED', 'APPROVAL_REQUIRED', 'CONFLICT', 'DAEMON_UNAVAILABLE',
];

/** http is null when the code has no HTTP representation. */
export const ERROR_TABLE: Readonly<Record<ErrorCode, { http: number | null; exit: number }>> = {
  INVALID_ARGUMENT: { http: 400, exit: 2 },
  FETCH_FAILED: { http: 502, exit: 1 },
  NOT_FOUND: { http: 404, exit: 1 },
  ZERO_ITEMS: { http: 422, exit: 3 },
  SSRF_BLOCKED: { http: 403, exit: 1 },
  ROBOTS_DISALLOWED: { http: 403, exit: 1 },
  APPROVAL_REQUIRED: { http: 403, exit: 1 },
  CONFLICT: { http: 409, exit: 1 },
  DAEMON_UNAVAILABLE: { http: null, exit: 4 },
};

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details: unknown };
}

export function errorEnvelope(code: ErrorCode, message: string, details: unknown = {}): ErrorEnvelope {
  return { error: { code, message, details } };
}

export function httpStatus(code: ErrorCode): number | null { return ERROR_TABLE[code].http; }
export function exitCode(code: ErrorCode): number { return ERROR_TABLE[code].exit; }

export class AppError extends Error {
  code: ErrorCode;
  details: unknown;
  constructor(code: ErrorCode, message: string, details: unknown = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
  toEnvelope(): ErrorEnvelope { return errorEnvelope(this.code, this.message, this.details); }
}
