// Exact static messages from the pinned libsignal. Other arguments and dynamic strings
// can contain sessions, identifiers or interpolated exceptions; never forward them.
const consoleMessages = new Set([
  'Closing session:', 'Opening session:', 'Session already closed', 'Session already open',
  'Removing old closed session:', 'Closing open session in favor of incoming prekey bundle',
  'Failed to decrypt message with any known session...', 'Decrypted message with closed session.',
]);

/** Project dependency console calls to known labels, never arbitrary strings/objects. */
export function installConsoleDiagnostics(observe?: () => void): void {
  const diagnostic = (first: unknown): void => {
    const message = typeof first === 'string' && consoleMessages.has(first) ? first
      : typeof first === 'string' && first.startsWith('Session error:') ? 'Session decryption error'
      : 'Dependency diagnostic';
    try { observe?.(); } catch { /* Optional telemetry never changes diagnostics. */ }
    process.stderr.write(JSON.stringify({ level: 'diagnostic', message }) + '\n');
  };
  console.log = console.info = console.debug = console.warn = console.error = diagnostic;
}

const sdkMessages = new Set([
  'failed to decrypt message', 'failed to process sender key distribution message',
  'stream errored out', 'error in validating connection', 'error in socket end handler',
  'error in sending keep alive', 'keep alive called when WS not open',
  'Failed to upload pre-keys to server', 'Failed to check/upload pre-keys during initialization',
  'failed to run digest after login', 'failed to send initial passive iq',
  'error in handling message', 'error in handling call', 'failed to ack message after error',
  'Buffer timeout reached, auto-flushing', 'transaction failed, rolling back',
]);

/** An exact static SDK label or a fixed issue category; msg itself is not public data. */
export function sdkDiagnostic(message: string, issue: string | undefined): string {
  return issue ?? (sdkMessages.has(message) ? message : 'SDK diagnostic');
}
