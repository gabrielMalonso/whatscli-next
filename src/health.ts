export function diagnosticIssue(message: string): string | undefined {
  if (/failed to sync|blocked on missing key/i.test(message)) return 'app-state-sync-incomplete';
  if (/Timeout in AwaitingInitialSync/i.test(message)) return 'initial-sync-timed-out';
  if (/decrypt|bad mac|invalid.*mac/i.test(message)) return 'decryption-or-integrity-failure';
  return undefined;
}

export function reconnectDelay(code: number | undefined, attempts: number): number | undefined {
  // Logged out, replaced session, bad session, forbidden, multidevice mismatch: require investigation.
  if (code !== undefined && [401, 403, 411, 440, 500].includes(code)) return undefined;
  if (attempts >= 8) return undefined;
  return code === 515 ? 0 : Math.min(1_000 * 2 ** attempts, 30_000);
}
