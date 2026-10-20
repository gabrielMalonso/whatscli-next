# Architecture overview

```text
agent → CLI → private Unix socket → daemon → Baileys
                                      ↓
                                     SQLite
```

## Runtime ownership

Only the daemon owns the WhatsApp connection and writes to SQLite.

The retained JSONL probe uses the same runtime and must not run against an active daemon's data directory.

A lifetime SQLite lock enforces one writer. The OS releases this lock after a crash.

At startup, the runtime recovers an owned, private stale socket. It preserves active sockets and unfamiliar files.

The complete Unix socket path must fit within 100 bytes. Use a shorter data-directory path if necessary.

## Transport

The private socket and JSONL probe use a flat request format. The `id` field is reserved for request/response correlation.

### Download requests

A download requires a separate `messageId` field:

```json
{"id":"rpc-example","command":"download","jid":"12025550101@s.whatsapp.net","messageId":"EXAMPLE_MESSAGE_ID","path":"/private/example-download.txt","fromMe":true}
```

A missing `messageId` is rejected. The correlation `id` is never used as a media target or fallback.

CLI `download --id MESSAGE_ID` and public message projection IDs remain unchanged.

Low-level callers must supply the explicit `messageId` field.

Rebuild and gracefully restart the daemon alongside the updated CLI. An older daemon cannot interpret this download request correctly.

## Private storage

### Directory and file permissions

The data directory must belong to the current user and have private permissions (0700).

Credentials, databases, logs, the socket, QR images, and downloaded files use 0600.

All data-directory ancestors must:

- Belong to the runtime user or root.
- Contain no symlinks.
- Have no group/world write permission.

Root-owned sticky temporary directories are allowed.

Use a canonical path. A private directory inside a group-writable worktree is insufficient.

Startup and RPC reject unsafe paths before opening state or sending requests, preserving existing content and permissions.

See [the local privacy boundary, diagnostics and macOS path limits](../operations/privacy.md).

### Database and authentication

The database file is `probe.sqlite`, a name retained from the validation program.

[Store schema, substring search and offline benchmarks](storage.md) covers the additive query projection/index upgrade and its limits.

Authentication uses the SDK's binary serializer and atomic key batches, with durable SQLite commits.

### Query performance

[CLI startup and RPC measurements](cli-performance.md) separates process/import cost from local transport and describes the response-assembly improvement for large pages.

Use smaller pages when full message bodies dominate.

Compact output preserves complete text and does not reduce socket payloads.

## Backups and recovery

Credentials and messages are **not encrypted at rest**.

Keep the entire data directory, WAL/SHM files, QR images, logs, and backups private and out of version control.

### Full-directory backup

For a manual full-directory backup, stop the daemon normally and confirm that the recorded PID has exited before copying.

### SQLite-only backup

Alternatively, run `backup --out NEW_DIRECTORY` to request a verified, consistent SQLite-only snapshot from the runtime.

The snapshot includes sensitive authentication data and send intents. It excludes logs, QR images, execution locks, and external media/files.

The destination must meet these requirements:

- Its parent already exists and is owned/private (0700).
- The path contains no symlinks or unsafe writable ancestors.
- The output directory is new; existing output is never reused.

See [backup scope, completion/timeout rules and NEW-directory offline recovery](../operations/backup.md).

### Repository boundaries

The repository ignores `.private/`, `.tmp/`, databases, and logs. The package file allowlist excludes state.

The runtime does not automatically delete credentials, log out, install OS services, or interrupt the network more broadly.

## Source map

| Area                          | Entry points                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CLI and daemon lifecycle      | [cli.ts](../../src/cli.ts), [daemon.ts](../../src/daemon.ts)                                               |
| Runtime and operations        | [runtime.ts](../../src/runtime.ts), [operations.ts](../../src/operations.ts)                               |
| Socket requests and responses | [rpc.ts](../../src/rpc.ts), [protocol.ts](../../src/protocol.ts), [response.ts](../../src/response.ts)     |
| Storage and authentication    | [store.ts](../../src/store.ts), [store-schema.ts](../../src/store-schema.ts), [auth.ts](../../src/auth.ts) |
| Identity and send routing     | [identity.ts](../../src/identity.ts), [send-route.ts](../../src/send-route.ts)                             |

## Further reading

See [Contributing](../../CONTRIBUTING.md) for development setup and checks.

[Validation](validation.md) records historical live evidence. [Reliability](reliability.md) documents offline fault-injection findings.

Neither report establishes complete history, delivery, or platform support beyond its stated limits.
