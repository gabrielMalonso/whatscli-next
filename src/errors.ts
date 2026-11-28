export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'KEY_CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'ACCOUNT_MISMATCH'
  | 'LOCAL_STATE'
  | 'UNKNOWN'
  | 'NOT_RUNNING'
  | 'TIMEOUT'
  | 'PROTOCOL';

/** A cause known locally, with a message safe for public JSON. Never classify SDK text. */
export class CommandError extends Error {
  /** Optional structured context; it must be as safe for public JSON as the message. */
  readonly details?: Record<string, unknown>;
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions & { details?: Record<string, unknown> },
  ) {
    super(message, options);
    if (options?.details) this.details = options.details;
  }
}

/** Only explicitly public errors cross the boundary; causes/stacks and arbitrary messages stay private. */
export function errorResponse(error: unknown): {
  ok: false;
  error: string;
  code: ErrorCode;
  details?: Record<string, unknown>;
} {
  return error instanceof CommandError
    ? {
        ok: false,
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      }
    : { ok: false, error: 'Command failed', code: 'UNKNOWN' };
}

/** Diagnostics keep only the code and safe message; structured details stay in responses. */
export function errorSummary(error: unknown): {
  ok: false;
  error: string;
  code: ErrorCode;
} {
  const { ok, error: message, code } = errorResponse(error);
  return { ok, error: message, code };
}

/** Runtime process exit statuses. Only 1 marks a failure where a supervisor restart can help. */
export const runtimeExit = {
  stopped: 0,
  failed: 1,
  usage: 64,
  inUse: 69,
  intervention: 77,
} as const;

/** Classify a runtime startup or shutdown failure for supervisors such as systemd. */
export function runtimeExitCode(error: unknown): number {
  if (!(error instanceof CommandError)) return runtimeExit.failed;
  if (error.code === 'INVALID_ARGUMENT') return runtimeExit.usage;
  if (error.details?.reason === 'data-directory-in-use')
    return runtimeExit.inUse;
  if (error.code === 'PRECONDITION_FAILED') return runtimeExit.intervention;
  return runtimeExit.failed;
}
