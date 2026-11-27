# Runtime and recovery

Use `status` to inspect the responding daemon. Each data directory belongs to one runtime. Never start a second connection against an active session.

## Inspect the connection

```sh
node dist/src/cli.js status
```

To inspect events or request recovery:

```sh
node dist/src/cli.js events --after 0
node dist/src/cli.js events --tail 20
node dist/src/cli.js events --tail 5 --kind connection
node dist/src/cli.js reconnect
node dist/src/cli.js resync
```

Events are paginated by sequence, with up to 100 events per request, and are always returned in ascending `sequence` order:

- `--after SEQUENCE` (default `0`) returns the first 100 events after that sequence. Continue from the last returned `sequence`.
- `--tail N` (1 to 100) returns the latest N events instead of the first page. They are still emitted oldest first, so the last entry is the newest. Combined with `--after`, it returns the latest N events after that sequence.
- `--kind KIND` keeps only events of one kind, such as `connection`, `history-status`, `messages.upsert` or `app-state.chat-action`. It combines with `--after` and `--tail`.

Invalid values fail with `INVALID_ARGUMENT` before contacting the daemon. Use these options instead of opening the SQLite database directly; only the runtime reads and writes it.

The diagnostic `drop-connection` command closes only this daemon's WebSocket and lets its normal reconnect handler recover.

A successful `resync` does not prove that the app state is complete. The SDK can log and skip failed collections.

## Recovery states

`status` and successful daemon/probe responses include `recovery` and `receiveContinuity` in the existing response envelope. Both fields have the same structure in full and compact output.

The existing `connection` field retains its coarse connection status. Use `recovery.state` to determine the current runtime state and next action.

| `recovery.state`        | Meaning and next step                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `offline`               | Intentionally offline. Local queries work. To enable network access, stop normally and restart without `--offline`.  |
| `connecting`            | Initial connection, retry, or replacement/cleanup in progress. Wait for the outcome; a stalled handshake times out.  |
| `open`                  | The SDK reported an open connection. Check independent observations and receipts for receiving or delivery evidence. |
| `waiting-retry`         | A retry is scheduled at `nextRetryAt`. Allow automatic recovery to proceed.                                          |
| `intervention-required` | Automatic recovery stopped. Investigate `reason` and `code` before reconnecting or restarting.                       |
| `stopping`              | Cleanup is in progress. Wait for successful shutdown and process exit before starting new code.                      |

### Recovery fields

`recovery` always includes:

- `reason` and `code` — the current recovery reason and code, or null when unknown or inapplicable.
- `attempt` — the automatic retry count since the last open or manual reconnect.
- `nextRetryAt` — the scheduled retry time, or null when not waiting.
- `since` — when the runtime entered the current recovery state.

For `attempt`:

- While waiting, it identifies the upcoming retry.
- While connecting, it identifies the retry in progress.
- Initial and manual connection attempts use zero.

`nextRetryAt` is a local Unix timestamp in milliseconds and is present only while waiting.

`since` is a local Unix timestamp in milliseconds. It changes on every recovery transition, including each new retry attempt and a manual reconnect, so a stale `since` shows how long the runtime has been in one state.

An open connection resets current recovery state. The `issues` field retains historical entries, including possible `connection-stopped-review-required` entries from earlier failures. `activeIssues` lists only the codes that are active now, with their counts and observation times; see [issue history and activity](../user/output.md#issue-history-and-activity).

## Automatic retries

For pinned rc14, these disconnect codes trigger automatic retries:

| Code | Meaning                      |
| ---- | ---------------------------- |
| 408  | Lost or timed-out connection |
| 428  | Closed connection            |
| 503  | Service unavailable          |
| 515  | Restart required             |

Retry delays are 1, 2, 4, 8, 16, then 30 seconds, capped at 30 seconds without an attempt limit.

### Handshake timeout

Every new socket (startup, automatic retry, or manual reconnect) must report open, close, or a pairing QR within 4 minutes. The bound sits above the SDK's own worst case before open (connect timeout plus post-login queries that still end in open), so a slow login is never cut short. Otherwise the runtime ends that socket and handles it like an observed close with reason `handshake-timeout` and code null: `attempt` increases and the next retry uses the same backoff. This prevents a socket that never reports an outcome from leaving recovery in `connecting` indefinitely.

Open, close, a pairing QR, stop, manual reconnect, and a disconnect requiring intervention cancel the timeout. It applies only to the socket that started it; it never ends a replacement. Waiting for a QR scan or pairing code is not bounded by this timeout. Cleanup of a previous socket during replacement is also not bounded.

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

## Daemon log

A background `start` appends the daemon's stderr to the private `daemon.log` in the data directory. Each line is one JSON object whose first field, `at`, is an ISO-8601 UTC timestamp. Lifecycle lines carry `level: "lifecycle"` and one `event`:

| `event`             | Fields                                                     | Meaning                                                                                                                                           |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup`           | `pid`, `build` (fingerprint or null), `network`            | The process holds the writer lock for this data directory.                                                                                        |
| `ready`             | `pid`                                                      | The control socket is listening and the runtime has started.                                                                                      |
| `connection`        | `state`, `recovery`, `reason`, `disconnectCode`, `attempt` | The SDK reported a connection state change, or the runtime timed out a stalled handshake (`reason: handshake-timeout`), with the recovery result. |
| `signal`            | `signal` (`SIGINT` or `SIGTERM`)                           | A termination signal was received; shutdown follows.                                                                                              |
| `shutdown-started`  | `reason` (`stop-command`, a signal, or `startup-failed`)   | Cleanup began.                                                                                                                                    |
| `shutdown-complete` | `reason`                                                   | SDK cleanup, database closure and socket removal finished.                                                                                        |
| `shutdown-failed`   | `code`                                                     | Cleanup failed; the process exits with code 1.                                                                                                    |
| `exit`              | `pid`, `code`                                              | The process is exiting with that code.                                                                                                            |

Lines without `level: "lifecycle"` are the existing diagnostics and errors described in [Privacy](privacy.md#diagnostics). A log that ends without an `exit` line means the process was killed without running its exit handlers, for example by `SIGKILL` or an out-of-memory or cgroup kill. A `signal` line followed by `shutdown-complete` and `exit` shows an orderly signal-driven stop rather than a crash.

```sh
tail -n 20 "$DATA_DIR/daemon.log"
```

`daemon.log` has no rotation or size cap. Lifecycle lines contain no message content, SDK objects, credentials or JIDs.

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
