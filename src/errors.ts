/**
 * Every failure the API reports has a stable code. Clients can rely on the code;
 * the message is for people and may change.
 */
export type ErrorCode =
  | "BAD_INPUT"
  | "PAGE_NOT_ARCHIVED"
  | "TRACKS_NOT_ARCHIVED"
  | "ARCHIVE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "BUSY"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "URI_TOO_LONG"
  | "INTERNAL";

export const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  BAD_INPUT: 400,
  PAGE_NOT_ARCHIVED: 404,
  TRACKS_NOT_ARCHIVED: 404,
  ARCHIVE_UNAVAILABLE: 502,
  RATE_LIMITED: 429,
  BUSY: 503,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  URI_TOO_LONG: 414,
  INTERNAL: 500,
};

/** Results that mean "the archive doesn't have it". Safe to remember for a while. */
export const CACHEABLE_ERRORS: ReadonlySet<ErrorCode> = new Set(["PAGE_NOT_ARCHIVED", "TRACKS_NOT_ARCHIVED"]);

/**
 * An error that is safe to show to clients. `details` must only ever contain
 * values this service produced or validated, never raw upstream error text.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** Internal-only context for logs. Never sent to clients. */
  readonly internal: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryAfterSeconds?: number; internal?: string } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.internal = options.internal;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toJSON(): { code: ErrorCode; message: string } & Record<string, unknown> {
    // Details go first so they can never overwrite the code or message.
    return { ...(this.details ?? {}), code: this.code, message: this.message };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
