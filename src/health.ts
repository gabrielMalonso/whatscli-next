import { DisconnectReason } from 'baileys';

export function diagnosticIssue(message: string): string | undefined {
  if (/failed to sync|blocked on missing key/i.test(message))
    return 'app-state-sync-incomplete';
  if (/Timeout in AwaitingInitialSync/i.test(message))
    return 'initial-sync-timed-out';
  if (/decrypt|bad mac|invalid.*mac/i.test(message))
    return 'decryption-or-integrity-failure';
  return undefined;
}

export function reconnectDelay(
  code: number | undefined,
  attempts: number,
): number | undefined {
  // Only rc14's known recoverable reasons authorize retries. Unknown is not transient evidence.
  if (
    code !== DisconnectReason.connectionClosed &&
    code !== DisconnectReason.connectionLost &&
    code !== DisconnectReason.unavailableService &&
    code !== DisconnectReason.restartRequired
  )
    return undefined;
  // Restart-required also waits: repeated 515s must not spin, even across brief opens.
  return Math.min(1_000 * 2 ** Math.min(attempts, 5), 30_000);
}

export function disconnectReason(code: number | undefined) {
  switch (code) {
    case DisconnectReason.connectionClosed:
      return 'connection-closed';
    case DisconnectReason.connectionLost:
      return 'connection-lost-or-timed-out';
    case DisconnectReason.unavailableService:
      return 'service-unavailable';
    case DisconnectReason.restartRequired:
      return 'restart-required';
    case DisconnectReason.loggedOut:
      return 'logged-out';
    case DisconnectReason.forbidden:
      return 'forbidden';
    case DisconnectReason.multideviceMismatch:
      return 'multidevice-mismatch';
    case DisconnectReason.connectionReplaced:
      return 'session-replaced';
    case DisconnectReason.badSession:
      return 'bad-session';
    default:
      return 'unknown-disconnect';
  }
}

type Reason = ReturnType<typeof disconnectReason>;
export type Recovery =
  | {
      state: 'offline' | 'open' | 'stopping';
      reason: null;
      code: null;
      attempt: 0;
      nextRetryAt: null;
    }
  | {
      state: 'connecting';
      reason: Reason | 'startup' | 'manual-reconnect';
      code: number | null;
      attempt: number;
      nextRetryAt: null;
    }
  | {
      state: 'waiting-retry';
      reason: Reason;
      code: number;
      attempt: number;
      nextRetryAt: number;
    }
  | {
      state: 'intervention-required';
      reason: Reason | 'socket-creation-failed' | 'socket-end-failed';
      code: number | null;
      attempt: number;
      nextRetryAt: null;
    };

export type ReceiveInterruption = {
  at: number;
  reason:
    'runtime-start' | 'runtime-stop' | 'connection-closed' | 'manual-reconnect';
};

/** The runtime needs only one cancellable timer; tests inject time without a network or real waits. */
export type RecoveryClock = {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
};
