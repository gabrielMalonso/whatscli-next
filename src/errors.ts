export type ErrorCode =
  | 'INVALID_ARGUMENT' | 'KEY_CONFLICT' | 'PRECONDITION_FAILED' | 'LOCAL_STATE' | 'UNKNOWN'
  | 'NOT_RUNNING' | 'TIMEOUT' | 'PROTOCOL';

/** A cause known locally, with a message safe for public JSON. Never classify SDK text. */
export class CommandError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) { super(message, options); }
}

/** Only explicitly public errors cross the boundary; causes/stacks and arbitrary messages stay private. */
export function errorResponse(error: unknown): { ok: false; error: string; code: ErrorCode } {
  return error instanceof CommandError
    ? { ok: false, error: error.message, code: error.code }
    : { ok: false, error: 'Command failed', code: 'UNKNOWN' };
}
