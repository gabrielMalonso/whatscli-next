# Runtime and recovery

Use `status` to inspect the responding daemon. Each data directory belongs to one runtime. Never start a second connection against an active session.

## Inspect the connection

```sh
node dist/src/cli.js status
```

To inspect events or request recovery:

```sh
node dist/src/cli.js events --after 0
node dist/src/cli.js reconnect
node dist/src/cli.js resync
```

Events are paginated by sequence, with 100 events per request.

The diagnostic `drop-connection` command closes only this daemon's WebSocket and lets its normal reconnect handler recover.

A successful `resync` does not prove that the app state is complete. The SDK can log and skip failed collections.

## Recovery states

`status` and successful daemon/probe responses include `recovery` and `receiveContinuity` in the existing response envelope. Both fields have the same structure in full and compact output.

The existing `connection` field retains its coarse connection status. Use `recovery.state` to determine the current runtime state and next action.

| `recovery.state`        | Meaning and next step                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `offline`               | Intentionally offline. Local queries work. To enable network access, stop normally and restart without `--offline`.  |
| `connecting`            | Initial connection, retry, or replacement/cleanup in progress. Wait for the outcome.                                 |
| `open`                  | The SDK reported an open connection. Check independent observations and receipts for receiving or delivery evidence. |
| `waiting-retry`         | A retry is scheduled at `nextRetryAt`. Allow automatic recovery to proceed.                                          |
| `intervention-required` | Automatic recovery stopped. Investigate `reason` and `code` before reconnecting or restarting.                       |
| `stopping`              | Cleanup is in progress. Wait for successful shutdown and process exit before starting new code.                      |

### Recovery fields

`recovery` always includes:

- `reason` and `code` — the current recovery reason and code, or null when unknown or inapplicable.
- `attempt` — the automatic retry count since the last open or manual reconnect.
- `nextRetryAt` — the scheduled retry time, or null when not waiting.

For `attempt`:

- While waiting, it identifies the upcoming retry.
- While connecting, it identifies the retry in progress.
- Initial and manual connection attempts use zero.

`nextRetryAt` is a local Unix timestamp in milliseconds and is present only while waiting.

An open connection resets current recovery state. The `issues` field retains historical entries, including possible `connection-stopped-review-required` entries from earlier failures.

## Automatic retries

For pinned rc14, these disconnect codes trigger automatic retries:

| Code | Meaning                      |
| ---- | ---------------------------- |
| 408  | Lost or timed-out connection |
| 428  | Closed connection            |
| 503  | Service unavailable          |
| 515  | Restart required             |

Retry delays are 1, 2, 4, 8, 16, then 30 seconds, capped at 30 seconds without an attempt limit.

Code 515 can complete the SDK's pairing restart. It also waits at least one second to prevent repeated-restart spin.

Automatic retries do not reset credentials or request new pairing.

### Disconnects requiring intervention

These codes stop automatic retries:

| Code | Reported reason        |
| ---- | ---------------------- |
| 401  | `logged-out`           |
| 403  | `forbidden`            |
| 411  | `multidevice-mismatch` |
| 440  | `session-replaced`     |
| 500  | `bad-session`          |

Unknown or missing codes report `unknown-disconnect` and stop retries. The runtime does not assume an unknown disconnect is transient.

## Reconnect explicitly

Use `reconnect` after investigating a failure. It retries with the same credentials or replaces an active connection.

Concurrent reconnect calls share one replacement. A reconnect cancels any pending retry and waits for SDK cleanup and actual transport closure.

### Transport cleanup

In rc14, another `end()` call can return before cleanup finishes. The SDK close event can also arrive before physical closure if the transport is already `CLOSING`.

Explicit reconnect, automatic recovery, and shutdown all use the same closure checks.

Each socket receives an isolated copy of credentials. Only credential updates from the current socket owner are copied into durable authentication state.

`reconnect` cannot enable an offline or stopping runtime.

### Reconnect failures

- `socket-creation-failed` — a synchronous socket factory exception. The SDK may have allocated resources without returning a cleanup handle, so further reconnects are refused until runtime restart.
- `socket-end-failed` — manual cleanup failed. Investigate and restart the runtime.
- Persistence failures — fail closed rather than entering an outage retry loop.

Restarting is an explicit new attempt using the same data directory. Intervention decisions belong to the current process; they are not a persisted lockout.

Preserve the directory and diagnose terminal or authentication failures before retrying.

## Receive continuity

The runtime retains one small local observation across restarts:

```text
receiveContinuity: {status: "unproven", lastInterruption: {at, reason} | null}
```

Possible `reason` values are:

- `runtime-start`
- `runtime-stop`
- `connection-closed`
- `manual-reconnect`

`at` records the local observation time in milliseconds. It is not a remote gap boundary.

Each interruption replaces the previous observation. This is not an interval ledger.

A null observation means this version recorded no interruption, including for a fresh, offline, or upgraded directory.

### What continuity does not establish

Network startup records interruption risk before creating a socket. Even an abrupt exit therefore leaves evidence for a later offline restart.

Neither an open connection nor `receivedPendingNotifications: true` clears this risk or proves that every message arrived and was decrypted.

The runtime provides no lost-message counts, catch-up verdicts, or automatic resync claims.

During outages:

- Local queries and existing request keys remain usable.
- New sends fail the connection precondition.
- Uncertain send intents are never resent automatically.

## Shutdown and upgrades

`stop` keeps the control socket available with `recovery.state: stopping` until SDK cleanup and database closure release the writer lock.

A successful stop allows the next runtime to start.

If shutdown exceeds the CLI's 10-second wait, the command returns an error without killing the process. Inspect `status` and wait for cleanup.

### Upgrading a running daemon

Older daemons may close their control socket before cleanup finishes. During an upgrade, confirm that the previously reported PID has exited normally before starting new code.

`start` with `alreadyRunning: true` returns the existing daemon. It does not replace or upgrade it.

Compare `status.data.build.fingerprint` with the intended build. See [builds and upgrades](release.md).

### Preserve session data

Stopping preserves credentials.

Keep the entire data directory private. Do not delete credentials, remove locks, or kill unfamiliar processes as recovery shortcuts.

See [Privacy](privacy.md) and [Backup and recovery](backup.md).
