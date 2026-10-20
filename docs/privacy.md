# Local private-state boundary

WhatsCLI protects local state and control traffic from another local UID through filesystem ownership and permissions. The runtime user and root remain trusted: processes running as either already control these files and credentials. There is no multi-user service, socket authentication protocol or same-UID isolation. Credentials, messages, immutable intents, deletion audit and backups remain **unencrypted at rest**.

## Paths

Choose a canonical data directory. Every existing ancestor must be a directory owned by the runtime user or root, without symlinks or group/world write permission. Root-owned sticky temporary directories such as Linux `/tmp` are permitted. A foreign-owned `0755` ancestor is unsafe because its owner can replace its children, even with a private final directory.

The final directory and existing entries must belong to the runtime user with private permissions (normally directory 0700, file/socket 0600), without symlinks. Database/log paths must be regular files; the control endpoint must be a socket. Startup checks ancestry before creating missing directories or opening SQLite/log output. RPC checks ancestry, directory and endpoint before connecting or sending any command, including start's initial status request. Writer locking, stale-socket recovery and shutdown retain their lifecycle.

Unsafe paths return `PRECONDITION_FAILED`, including for `status`/`stop`; this does not mean an absent daemon. Missing endpoints under trusted paths retain `NOT_RUNNING` and the CLI's successful stopped/status behavior. Refusal preserves existing content and modes without chmod, chown, deletion, relocation or replacement. Have the owner choose a trusted path and investigate existing permissions separately. Never bypass rejection by removing locks or starting another live runtime. Timeout/protocol errors still describe unknown outcomes and never authorize resending.

A 0700 `.private/session` inside a group-writable source worktree is insufficient; choose a separate trusted path. Source-directory permissions are never repaired automatically. On macOS, system aliases such as `/tmp` and `/var` may be symlinks: use the actual canonical path (`fs.realpathSync` can report an existing chosen directory). Aliases are rejected instead of silently followed. Only Linux was exercised; macOS operation/default paths remain unvalidated on a Mac.

[Backup](backup.md) shares the ancestor rule with an existing 0700 parent and a NEW destination. QR files are exclusively created inside validated state. Explicit `send-file` inputs retain existing behavior; there is no general file sandbox. Downloads retain exclusive creation, 0600 and preserved partials.

## Diagnostics

SDK structured fields, arbitrary strings, raw objects, error causes and stacks stay out of ordinary diagnostics. SDK `msg` is untrusted too: rc14 interpolates identifiers into some warnings. Logs retain known exact static labels, fixed existing issue categories (app-state sync, initial-sync timeout, decryption/integrity) and numeric level. Other SDK strings become `SDK diagnostic`. Console calls retain a small set of exact session labels or a fixed decryption-error label, discarding extra arguments/dynamic strings. Unknown messages lose detail intentionally; no secret/identity regex scrubber or verbose fallback exists.

Daemon/probe startup and shutdown use the command `errorResponse` boundary. Known public messages/codes stay actionable; arbitrary exception/parser text becomes `Command failed` / `UNKNOWN`. JSON results remain on stdout, diagnostics on stderr (private `daemon.log` for CLI starts). Full/compact share this boundary. Stored logs/data still must not be published.

## Offline evidence

On exact base `507827e22f9a4f8f71e6c2f387ee2d748bf52254`, all seven initial `test/privacy.test.ts` scenarios failed before production changes:

| Controlled trigger | Base observation | Correction |
| --- | --- | --- |
| Writable, injected foreign-owned 0755, or symlink ancestor over a private Store | SQLite opened; missing nested state was created through replaceable ancestry | Refuse before mkdir/open; preserve existing DB bytes/modes |
| Own fictional socket changed to 0666 | RPC delivered the fictional send body and accepted the response | Refuse before connection/bytes; secure owned endpoint works |
| Pinned `LIDMappingStore` pure handler with fictional invalid identifiers; injected logger errors and libsignal console error-string pattern | Interpolated identifiers/error text reached stderr | Fixed labels/categories; private markers absent from stderr/public snapshot |
| Daemon/probe parser with a fictional private option | Supplied option reached stderr | Safe generic startup error |

Additional tests cover injected endpoint/directory/ancestor ownership, symlink endpoints, trusted user/root/sticky-root ancestry, CLI full/compact and offline daemon/probe rejection, and log preservation. Existing transport correlation/error forwarding/size limits, build fingerprint, backup, locking, shutdown and durable idempotency tests continue to run. No chown, elevation, other UID/process, actual multi-user attack or real WhatsApp connection was used.

The first full baseline run was 154/155: the backup fixture issued a second stop in `finally` after confirmed stop while releasing its gated copy. Eight new offline children confirmed the first stop, rejection of the second during `stopping`, and normal exit. The fixture now awaits its own child's exit after confirmed stop; otherwise it still requests normal shutdown. This corrects fixture synchronization without changing production shutdown or hiding errors.

Metadata reads cost O(path depth) per RPC and at Store/startup, without per-request DB reading/hashing. Affected fictional state moves from group-writable worktree ancestors to new short OS temporary directories; artifacts are retained. The Store benchmark retains source/build scratch in `.tmp` and records a separate OS temporary SQLite root as `retainedState`. Broad benchmarks, real-account data, live upgrade/backup/recovery, hardware failures, macOS and same-UID isolation were not tested or claimed.
