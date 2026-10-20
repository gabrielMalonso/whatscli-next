# Private state and diagnostics

Credentials, messages, immutable intents, deleted-body audit data, quoted-send snapshots, and backups are **not encrypted at rest**. Filesystem checks protect against other local UIDs; the runtime user and root remain trusted. There is no same-UID isolation or separate socket authentication service. Keep private state out of Git, packages, and public reports.

## Trusted paths

Every data-directory ancestor must be a directory owned by the runtime user or root, without symlinks or group/world write permission. Root-owned sticky temporary directories are allowed. A foreign-owned 0755 ancestor is unsafe because its owner can replace children.

Owner write permission is allowed. A private leaf directory must still meet the ancestry rules above.

The final directory and existing entries must belong to the runtime user and have private permissions: normally 0700 for directories and 0600 for files and sockets. Database and log entries must be regular files; the endpoint must be a socket.

Use a canonical path. macOS `/tmp` and `/var` aliases may be symlinks and are rejected rather than silently followed.

### Path validation

Startup validates ancestry, creates missing components one at a time with revalidation, and checks the complete path before accessing SQLite or logs. RPC validates paths before connecting or sending request bytes, including for `status` and `stop`.

If ancestry is missing during admission, the request returns `NOT_RUNNING` rather than trusting a path that appears during the check.

Unsafe paths return `PRECONDITION_FAILED`, not a "daemon absent" result. Refusal preserves existing content and permissions; it does not chmod, chown, relocate, remove locks, or reset sessions. Investigate the path with its owner. A later explicit start validates it again.

See [error handling](../user/output.md#command-errors-and-safe-next-steps).

### Files and backups

[Backups](backup.md) require an existing private parent and a new destination under the same ancestry rules. QR files are created exclusively within validated state. Downloads create 0600 output files without overwriting existing files and preserve partial output.

Explicit `send-file` inputs are not subject to a general file sandbox.

Deletion hides current public message bodies but does not erase immutable outgoing intents or original quoted-send snapshots. See [Quoted replies](../user/quoted-replies.md) for this private retention boundary.

## Diagnostics

JSON responses use stdout; diagnostics use stderr, captured in private `daemon.log` for background starts.

Diagnostics exclude arbitrary SDK objects, interpolated strings, exception causes and stacks, and parser excerpts. Only allowlisted static labels, numeric levels, and bounded sync/decryption issue categories are retained.

Unknown SDK strings become `SDK diagnostic`. Console session objects and dynamic arguments are discarded. There is no verbose raw fallback.

Known public errors retain actionable codes and messages; arbitrary failures become safe `Command failed` / `UNKNOWN` responses. Sanitization does not make stored logs or databases safe to publish.

[Observability](observability.md) adds opt-in technical metadata with selected HMAC digests, not original message bodies or identifiers, and makes no remote uploads. Its secret survives restarts and re-enabling, so copied digests remain linkable. Its retention limits do not apply to SQLite or `daemon.log`.
