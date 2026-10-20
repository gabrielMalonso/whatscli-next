# JSON output contract

Every CLI invocation writes one minified JSON object to stdout; diagnostics go to stderr. `--output full` is the default safe public projection. `--output compact` reduces agent input without changing text, pagination, errors, exit codes, or operation behavior. Neither mode exposes raw SDK objects, credentials, cryptographic material, or private deletion audit data.

```sh
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 10
node dist/src/cli.js --output full request --key 'example-message-001'
```

Formatting happens after the response is produced, without database or network access. The socket payload is unchanged. [Command results and retry rules](evidence.md) covers evidence, durable keys, and interrupted operations.

## Projections and inheritance

Both modes preserve the response envelope: `ok`, correlation `id` when available, errors/codes, running/connection state, source/coverage/appState, notifications/issues, and `recovery`/`receiveContinuity`.

| Command                             | Compact differences                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chats`, `chat`                     | Omit metadata `observedAt`, null name, and empty `pending`. Retain exact JID, activity timestamp/source, archived/unread/count, and nonempty pending keys/values.                                                                                                                                      |
| `messages`                          | `data` becomes `{jid, messages: [...]}`. Rows inherit only that exact JID and retain ID, direction, participant (including null), timestamp, text/type, and SDK status.                                                                                                                                |
| `search`                            | Preserve array order and each row's exact JID, even when filtering by JID. Apply the message-component defaults below.                                                                                                                                                                                 |
| `contact`, nested `resolve.contact` | Omit contact source when it matches the envelope source. Metadata `{value}` inherits source and observation time from its exact enclosing `contacts` record only when both match. Otherwise, retain all three. Mappings, conflicts, null phone, verification, and historical evidence remain complete. |
| Chat mutations                      | Apply the chat projection to `data.localChat`; preserve the complete request and pending verification.                                                                                                                                                                                                 |
| Other commands                      | Unchanged, including send/file/card/request intents, explicit card content, quote snapshots, routes, IDs, attempts, receipts, and error evidence.                                                                                                                                                      |

### Compact message defaults

- Omitted `quote`, `contacts`, `media`, or `stubType` means the full value was null. Present components retain all public fields. Missing media does not prove remote media is unavailable; a missing quote means no local quote evidence.
- `deletion: {status: "unknown"}` expands to `{status: "unknown", source: null, observedAt: null}`. No deletion was observed; remote availability remains unknown. Deleted or uncertain boundaries retain source/time and withhold bodies before formatting.

There is no general omission of false, zero, null, or unknown values. Null chat states/counts, pending values, `status: 0`, unknown receipts, and `request.data: null` retain their meanings. An omitted chat observation time does not establish freshness, and full output cannot recover redacted content.

Quotes and cards remain snapshots or shared content, not verified identity. Check [contact identity](identity.md) separately.

### Build identity

`status.data.build: {fingerprint: "sha256:…" | null}` remains unchanged, including status returned by `start`/`alreadyRunning` and the probe.

The fingerprint is the responding process's embedded build label, never the client's build. An absent legacy field remains absent, and stopped status does not invent build information. See [build identity](../operations/release.md#identify-startup-and-upgrade-without-losing-the-session).

### Backup output

Backup data is identical in full, compact, and JSONL output. Completion, SQLite-only sensitivity, artifact paths/bytes/hash/schema/integrity, timestamps, and exclusions describe the backup artifact, not the envelope's current runtime state. See [backup completion and recovery](../operations/backup.md).

## Command errors and safe next steps

Failures return `ok: false`, a safe human-readable `error`, and a string `code`. Branch on the code rather than English text. Codes describe the reporting boundary, not a remote outcome or permission to retry; see [failure handling](evidence.md#timeouts-and-failures) for next steps.

CLI commands exit 0 on success and 1 on failure. The probe continues after individual error responses and may exit 0. Socket/probe correlation is preserved when parsed, otherwise null; local CLI errors do not invent an RPC ID.

| Code                  | Reporting boundary                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`    | Invalid options, identity/card/key input, request/file size or shape, or socket path.                                                   |
| `KEY_CONFLICT`        | A durable key was reused with a different exact recipient, kind, content, or arguments.                                                 |
| `PRECONDITION_FAILED` | Unsatisfied connection, pairing/recovery, target/restriction, identity/message/media, privacy, configuration, or shutdown precondition. |
| `LOCAL_STATE`         | Classified local persistence, configuration, or backup failure; other I/O errors may remain `UNKNOWN`.                                  |
| `NOT_RUNNING`         | RPC connection returned ENOENT/ECONNREFUSED. This alone does not prove the old process finished cleanup.                                |
| `TIMEOUT`             | Response wait expired without cancelling runtime work.                                                                                  |
| `PROTOCOL`            | Invalid, mismatched, oversized, or incomplete RPC response.                                                                             |
| `UNKNOWN`             | No classified cause at this boundary, including unclassified SDK, filesystem, or startup failures.                                      |

### Error disclosure and compatibility

Responses exclude arbitrary exception text, parser excerpts, supplied option values, causes, and stacks. Failed downloads preserve a safe partial-file notice without exposing its path or underlying error; inspect the originally selected output locally.

Unsafe state or socket paths fail before RPC bytes are sent, including for `status` and `stop`, without repairing permissions. Missing endpoints under trusted paths retain normal stopped behavior.

An absent or unfamiliar code from an older or newer daemon remains unclassified. The CLI forwards it unchanged rather than guessing from error text. Treat it as unclassified, following the same failure rules.

`status` and `stop` with no socket return `ok: true, running: false`. `start` may return an existing process without upgrading it.

## Bound response size

Use `--limit`, `--offset`, chat filters, and exact-JID/search filters to bound responses. Neither mode silently shortens lists or truncates Unicode text, captions, IDs, keys, or phone numbers. Pages read changing, partial local state; deduplicate by exact identity. Compact formatting does not reduce the socket payload.
