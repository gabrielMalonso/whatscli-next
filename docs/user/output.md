# JSON output contract

Every CLI invocation writes one minified JSON object to stdout; diagnostics go to stderr. `--output full` is the default safe public projection. `--output compact` reduces agent input without changing text, pagination, errors, exit codes, or operation behavior. Neither mode exposes raw SDK objects, credentials, cryptographic material, or private deletion audit data.

```sh
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 10
node dist/src/cli.js --output full request --key 'example-message-001'
```

Formatting happens after the response is produced, without database or network access. The socket payload is unchanged. [Command results and retry rules](evidence.md) covers evidence, durable keys, and interrupted operations.

## Projections and inheritance

Both modes preserve `ok`, correlation `id` when available, errors/codes, `running`/`pid`/`connection`, `source`/`coverage`/`appState`, `receivedPendingNotifications`, `receiveContinuity`, and the [`linkedPeer`](identity.md#linked-peer-hint) envelope field of `chat`, `messages` and `incoming`, unchanged. Compact output omits a steady `recovery` and summarizes inactive issues; see [compact envelope defaults](#compact-envelope-defaults). Errors are never compacted.

| Command                             | Compact differences                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chats`, `chat`                     | Omit metadata `observedAt`, null name, and empty `pending`. Retain exact JID, activity timestamp/source, archived/unread/count, `latestIncoming`, nonempty pending keys/values with any `superseded` marker, and `sdkReported` with its explicit source, request key, and local capture time. In `chats --include contact`, labels omit `observedAt`, and `jid` when it is the row's JID; `contact: null` and `lastMessage: null` are kept. |
| `messages`, `search`                | `data` stays an array of message rows, as in full output, in the same order. Every row keeps its exact `jid`, `id`, and `fromMe`, plus timestamp and text/type. Apply the message defaults below.                                                                                                                                                                                                                                           |
| `incoming`                          | `data` keeps its listing fields; `data.messages` stays an array of message rows, oldest first, as in full output. Every row keeps its exact `jid`, `id`, `fromMe` and `available`, plus timestamp and text/type. Apply the message defaults below.                                                                                                                                                                                          |
| `contact`, nested `resolve.contact` | Omit contact source when it matches the envelope source. Metadata `{value}` inherits source and observation time from its exact enclosing `contacts` record only when both match. Otherwise, retain all three. Mappings, conflicts, null phone, verification, and historical evidence remain complete.                                                                                                                                      |
| `contacts`                          | `data` stays an array of results in the same order. Each keeps `jid`, `observedChat`, `matchedFields`, `phone` and `mapping`; labels omit `observedAt`, and `jid` when it is the result's JID.                                                                                                                                                                                                                                              |
| `status`, `start`                   | `data.observability` becomes a summary (see below) and `data.issueHistory` is omitted. Build, credentials, account, allowed JID, network and QR fields are unchanged.                                                                                                                                                                                                                                                                       |
| Chat mutations                      | Apply the chat projection to `data.localChat`; preserve the complete request and note separating SDK state from independent observation.                                                                                                                                                                                                                                                                                                    |
| Other commands                      | `data` unchanged, including send/file/card/request intents, explicit card content, quote snapshots, routes, IDs, attempts, receipts, and error evidence.                                                                                                                                                                                                                                                                                    |

### Compact message defaults

Compact rows omit a field only when its full value is the documented default below. Missing fields expand back to that default; every other value, including unfamiliar fields, stays as in full output. A missing `participant` expands to `null`, although full output may show `""` for the same no-participant key; both identify the same message.

| Omitted field                            | Full value                                            | Meaning of absence                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `participant`                            | `null` or `""`                                        | The message key carried no participant. This does not prove the chat is 1:1 and does not identify a group sender.                                                                                                                                      |
| `status`                                 | `null`                                                | The SDK reported no message status. Status `0` and every other number are kept. Acceptance, delivery, read, and phone confirmation stay separate evidence.                                                                                             |
| `deletion`                               | `{status: "unknown", source: null, observedAt: null}` | No local deletion or deletion-boundary evidence. Remote availability is still unknown. `deleted` rows and `unknown` rows with a source or time (such as `chat-delete-boundary`) keep the full object, and their bodies are withheld before formatting. |
| `quote`, `contacts`, `media`, `stubType` | `null`                                                | No component in the public projection. Missing media does not prove remote media is unavailable; a missing quote means no local quote evidence. Present components keep all public fields.                                                             |

Read optional fields with a default (for example, `row.get("status")` in Python or `row.status ?? null` in JavaScript) rather than indexing them directly.

There is no general omission of false, zero, null, or unknown values. Null chat states/counts, pending values, `status: 0`, unknown receipts, and `request.data: null` retain their meanings. An omitted chat observation time does not establish freshness, and full output cannot recover redacted content.

Quotes and cards remain snapshots or shared content, not verified identity. Check [contact identity](identity.md) separately.

### Compact envelope defaults

Successful compact responses omit these envelope fields only at the exact values below. Every other value, including unfamiliar fields, stays as in full output.

| Omitted field  | Full value                                                                                                                                | Meaning of absence                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recovery`     | `{state, reason: null, code: null, attempt: 0, nextRetryAt: null, since}` where `state` equals `connection`, which is `open` or `offline` | No retry, intervention or cleanup is in progress. The entry time `since` is only in full output. Any other state, reason, code, attempt, retry time, or extra field keeps the whole object. |
| `issues`       | Codes array, when `activeIssues` is present and consistent                                                                                | Replaced by `activeIssues` and `inactiveIssues`. The inactive codes and their timing are in full output (`issues`, and `status` `data.issueHistory`).                                       |
| `activeIssues` | `[]`                                                                                                                                      | No issue is active (see [issue activity](#issue-history-and-activity)).                                                                                                                     |

Compact output adds `inactiveIssues: <count>` when recorded issue codes are not active; it is absent when the count is 0. With no `recovery`, `issues`, `activeIssues` or `inactiveIssues`, the runtime is steady and has no recorded issues. A response from an older daemon has no `activeIssues`: compact output then keeps `issues` unchanged and omits it only when it is `[]`. An `activeIssues` value that is malformed or names a code missing from `issues` leaves both fields unchanged.

### Compact status

`data.observability` keeps `configured`, `enabled`, `effective`, `degraded`, `dropped`, `uncertain`, and `captureCompleteness`. It adds `cleanupFailures`, `hashingFailures`, and `preferenceWatchDegraded` only when they differ from `0`/`0`/`false`. Component flags, session, generation, retention counters, limits, directory, scope, buffer counters and sampler state are only in full output and in `observability status` (which is never compacted). `degraded` already aggregates the component flags. `data.issueHistory` is omitted; active issues remain in the envelope. This is a fixed list: fields a newer daemon adds to observability status are not passed through in compact `status`; read `observability status` for the complete set.

### Issue history and activity

`issues` keeps every issue code this data directory has recorded, in first-recorded order, across restarts. It is never cleared, so a code does not mean the problem is current. Each response also carries `activeIssues`, one entry per active code:

```json
{
  "code": "decryption-or-integrity-failure",
  "count": 3,
  "firstAt": 1700000000000,
  "lastAt": 1700000060000
}
```

`status` adds `data.issueHistory`, the same entries for every code in `issues`, each with `active: true|false`.

- `count` is the number of observations recorded with timestamps, and `firstAt`/`lastAt` are the first and latest such observations (local Unix ms). These persist across restarts.
- A code recorded before timing was kept has `firstAt: null`; its true first time and total are unknown, and `count` covers only later observations. Until it recurs, `count` and `lastAt` are also null.
- `connection-stopped-review-required` is active exactly while `recovery.state` is `intervention-required`.
- Every other code (`decryption-or-integrity-failure`, `app-state-sync-incomplete`, `initial-sync-timed-out`, `history-completion-not-explicit`) is active once this runtime process (the envelope `pid`) has observed it. Nothing reports that these conditions ended, so they stay active until the process exits and are never cleared by elapsed time. Use `lastAt` to judge recency.

An inactive code may still affect older local data, and an active code does not prove a current failure. Running an older daemon on the same data directory records codes without updating their history, so after re-upgrading `count` and `lastAt` can be low for those codes. Neither replaces the evidence in [command results](evidence.md).

### Compact envelope and status change

Breaking for compact consumers: compact responses used to repeat the full envelope. They now omit a steady `recovery`, replace `issues` with `activeIssues`/`inactiveIssues` when the daemon reports activity, and summarize `status.data.observability`. Read `recovery` and `activeIssues` with a default, as for message rows. Full output gains two additive fields from the daemon, `activeIssues` on every response and `data.issueHistory` on `status`; existing fields are unchanged. The compact envelope needs a daemon that reports `activeIssues`; with an older daemon a new CLI only omits steady `recovery` and empty `issues`.

### Compact message shape change (PR #53)

Breaking for compact consumers: `messages` used to return `data` as `{jid, messages: [...]}` when every row matched `--jid`, and an array otherwise. It now returns an array in both modes, and every row keeps its `jid`. Compact rows also now omit the unknown `deletion` default (previously `{status: "unknown"}`), a null or empty `participant`, and a null `status`. Full output is unchanged. Formatting happens in the CLI client, so the compact shape follows the CLI build a consumer runs, not the daemon's build: a new CLI talking to an older daemon already emits the new shape.

### Build identity

`status.data.build: {fingerprint: "sha256:…" | null}` remains unchanged, including status returned by `start`/`alreadyRunning` and the probe.

The fingerprint is the responding process's embedded build label, never the client's build. An absent legacy field remains absent, and stopped status does not invent build information. See [build identity](../operations/release.md#identify-startup-and-upgrade-without-losing-the-session).

### Backup output

Backup data is identical in full, compact, and JSONL output. Completion, SQLite-only sensitivity, artifact paths/bytes/hash/schema/integrity, timestamps, and exclusions describe the backup artifact, not the envelope's current runtime state. See [backup completion and recovery](../operations/backup.md).

## Command errors and safe next steps

Failures return `ok: false`, a safe human-readable `error`, and a string `code`. Some failures add a structured `details` object with the same disclosure rules, such as `details.latestIncoming` for a failed [incoming-message guard](chat-state.md#guard-against-new-incoming-messages). Branch on the code rather than English text. Codes describe the reporting boundary, not a remote outcome or permission to retry; see [failure handling](evidence.md#timeouts-and-failures) for next steps.

CLI commands exit 0 on success and 1 on failure. The probe continues after individual error responses and may exit 0. Socket/probe correlation is preserved when parsed, otherwise null; local CLI errors do not invent an RPC ID.

| Code                  | Reporting boundary                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`    | Invalid options, identity/card/key input, request/file size or shape, or socket path.                                                          |
| `KEY_CONFLICT`        | A durable key was reused with a different exact recipient, kind, content, or arguments.                                                        |
| `PRECONDITION_FAILED` | Unsatisfied connection, pairing/recovery, target/restriction, identity/message/media, privacy, configuration, or shutdown precondition.        |
| `ACCOUNT_MISMATCH`    | `--expect-account` differs from the daemon's linked account, or no account is linked. No chat state, request key or WhatsApp call was touched. |
| `LOCAL_STATE`         | Classified local persistence, configuration, or backup failure; other I/O errors may remain `UNKNOWN`.                                         |
| `NOT_RUNNING`         | RPC connection returned ENOENT/ECONNREFUSED. This alone does not prove the old process finished cleanup.                                       |
| `TIMEOUT`             | Response wait expired without cancelling runtime work.                                                                                         |
| `PROTOCOL`            | Invalid, mismatched, oversized, or incomplete RPC response, or a daemon that predates `--expect-account` refused it.                           |
| `UNKNOWN`             | No classified cause at this boundary, including unclassified SDK, filesystem, or startup failures.                                             |

### Error disclosure and compatibility

Responses exclude arbitrary exception text, parser excerpts, supplied option values, causes, and stacks. Failed downloads preserve a safe partial-file notice without exposing its path or underlying error; inspect the originally selected output locally.

Unsafe state or socket paths fail before RPC bytes are sent, including for `status` and `stop`, without repairing permissions. Missing endpoints under trusted paths retain normal stopped behavior.

An absent or unfamiliar code from an older or newer daemon remains unclassified. The CLI forwards it unchanged rather than guessing from error text. Treat it as unclassified, following the same failure rules.

`status` and `stop` with no socket return `ok: true, running: false`. `start` may return an existing process without upgrading it.

## Bound response size

Use `--limit`, `--offset`, chat filters, and exact-JID/search filters to bound responses. Neither mode silently shortens lists or truncates Unicode text, captions, IDs, keys, or phone numbers. Pages read changing, partial local state; deduplicate by exact identity. Compact formatting does not reduce the socket payload.
