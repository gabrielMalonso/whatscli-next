# JSON output contract

Use `--output compact` explicitly for agents. The default and `--output full` preserve the existing safe public projection. Both emit one minified JSON object, with the same exit codes. Full never means SDK objects, credentials, cryptographic material or private audit data.

```sh
node dist/src/cli.js --output compact chats --unread true --archived false --limit 20 --offset 0
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 10 --offset 0
node dist/src/cli.js --output full contact --jid '123450001@lid'
node dist/src/cli.js --output full request --key 'example-message-001'
```

Formatting runs in the CLI after the original response. It cannot re-execute an operation, contact WhatsApp, read/write SQLite or affect idempotency. It reduces stdout consumed by an agent; the private socket response is unchanged. Do not repeat a send or mutation solely to change format: inspect the original key with `request --output full`.

## Projections and inheritance

The envelope retains `ok`, errors/codes, RPC correlation `id`, running/connection state, local source, partial coverage, unknown app state, pending notifications and historical issues. The additive `recovery` and `receiveContinuity` fields are retained verbatim in both modes; see [the recovery contract](../README.md#recovery). Formatting preserves errors verbatim, including the additive codes below. A successful command can still describe an uncertain result.

`status.data.build: {fingerprint: "sha256:…" | null}` is retained verbatim in full/compact, including status returned by `start`/`alreadyRunning` and the JSONL probe. It belongs only to status data; message/send/request projections and envelopes gain no repeated build metadata. It is the responding process's embedded build label, never supplied by the client. An absent field from an older daemon stays absent; a missing connection still returns `running: false` without inventing build information. See [provenance limits](release.md#identify-startup-and-upgrade-without-losing-the-session).

`backup` data is unchanged in full/compact and JSONL: completion, SQLite-only scope, sensitivity, artifact/manifest paths, actual verified bytes/hash/schema/integrity, local operation times and excluded categories. No per-message metadata is added. The flat wire request is `{"id":"fictional-backup-rpc","command":"backup","path":"/absolute/private/NEW-directory"}`; `id` remains correlation only. Existing 128 KiB request and 8 MiB response bounds apply. Errors use the same correlated envelope/codes/exit status; an older runtime can reject the unknown command without client-side fallback copying. On backup `TIMEOUT`/`PROTOCOL`, work can continue: inspect/verify the requested directory's `backup.json`; never reuse existing output. [Scope and recovery limits](backup.md) distinguish artifact evidence from the response envelope's current runtime state.

| Command | Compact differences from full |
| --- | --- |
| `chats`, `chat` | Omit metadata `observedAt`, null `name` and empty `pending`. Keep exact JID, archived/unread states, unread count and activity timestamp/source. Nonempty pending intents retain exact keys and boolean values. |
| `messages` | `data` becomes `{jid, messages: [...]}`. Every row inherits that exact `data.jid`, without PN/LID equivalence. Keep ID, direction, participant (including null), timestamp, text/type and SDK status. |
| `search` | Keep the original array order and each row's exact JID, even with `--jid`. Never combine identities or colliding IDs. Uses the message component omissions below. |
| `contact`, nested `resolve.contact` | Omit contact `source` when equal to the envelope source. A metadata field `{value}` inherits both `source` and `observedAt` from its exact enclosing `contacts` record, only when both originally match. Otherwise retain all three fields. Keep every mapping edge and its source/time, conflicts, null phone, historical flag and verification. |
| `archive`, `unarchive`, `read`, `unread` | Apply the chat projection to `data.localChat`. Keep the complete request and pending verification. |
| Others | Unchanged. In particular, `send`, `send-file`, `send-contact` and `request` retain immutable operation (including the card's explicit name/phone/vCard), key, message ID, attempt, acceptance, delivery, read and error evidence. |

[Text replies](quoted-replies.md) add optional `operation.quote: {id, fromMe, participant?}` and request-level `quote: {reference: {jid, id, fromMe, participant}, author, contentType, text}`. Full/compact preserve both identically. The request snapshot is original intent evidence and remains queryable after deletion; current message quotes still follow deletion visibility. Legacy sends omit both fields. This does not change search indexing or the one-level public embedded quote projection.

Message component defaults are explicit:

- Missing `quote`, `contacts`, `media` or `stubType` means the full field was null. Present components retain every public field. Missing quote means no local quote evidence; missing media does not prove there is no unavailable media.
- `deletion: {status: "unknown"}` expands to `{status: "unknown", source: null, observedAt: null}`: no deletion observation, not proof of remote availability. Deleted/uncertain boundaries retain source/time and withhold bodies.

There is no general removal of false, zero, null or unknown. Null chat states/counts, pending values, `status: 0`, unknown receipts and missing request (`data: null`) retain their meanings. Absent chat `pending` means an empty local map, without establishing remote state. Omitted chat `observedAt` is a projection choice, not a freshness claim. Activity remains observed activity, not metadata arrival time.

Embedded quotes keep their exact available references and embedded/unknown/deleted state. Shared cards keep `source: shared-content`. Neither becomes verified identity. Deleted/withheld bodies and private fields are excluded before either format is applied; full cannot recover deleted content.

Use full to inspect metadata observation times, consume the original history array, or inspect public fields without applying these defaults. Use `contact`/`resolve` for identity evidence, never cards or names.

## Command errors and safe next steps

Current CLI errors and command failures from the daemon socket/JSONL probe have `ok: false`, human-readable `error`, and an additive string `code`. Branch on `code`, never on English text. Socket/probe responses preserve the request correlation `id` when parsed, or null if unavailable; a local CLI error has no invented ID. CLI failure exits 1, success exits 0. The probe reports each command failure on stdout and continues; its process can still exit 0. Diagnostics remain on stderr.

Unsafe data-directory ancestors or an unowned/public/symlink control endpoint return `PRECONDITION_FAILED` before RPC connection/request bytes, including status/stop. Missing endpoints under trusted paths retain their stopped behavior. See [the private-state boundary](privacy.md); refusal preserves existing content and modes.

These categories describe the cause known at the reporting boundary, **not a remote outcome or permission to retry**. No `retryable` flag or automatic next action exists.

| Code | Origin and limit | Safe next step |
| --- | --- | --- |
| `INVALID_ARGUMENT` | CLI options, request/command parsing, explicit identity/card/key validation, file shape/size, request size or socket path limit. Does not inspect past or concurrent operations. | Correct the named input. If the operation has a key, inspect that original key before deciding whether anything else is needed. |
| `KEY_CONFLICT` | A stored key exists with different operation arguments, including exact recipient/kind/content. Covers text, file, card and chat mutations. | Query the original key and inspect its immutable intent. Correct the caller's arguments; never substitute PN/LID or create a new key to bypass the conflict. |
| `PRECONDITION_FAILED` | Explicit runtime checks: connection/pairing/reconnect state, exact allowed recipient, missing observed/verified target or last message, conflicting identity, offline download/media limit, changed file, or missing/ambiguous/deleted stored media target. Also startup configuration/privacy checks and unfinished shutdown. Other failures can remain unclassified. | Inspect status and the exact target's local evidence/configuration; coordinate any intervention. Do not infer send authority from an alias/card or automatically restart, reconnect, pair or resend. |
| `LOCAL_STATE` | The operation intent transaction or completion transaction failed locally. It is not an SDK failure classification; other storage/I/O failures may be `UNKNOWN`. | Preserve state and inspect the original key/receipts. A completion failure can follow an SDK return and an independent delivery receipt. Investigate local persistence; do not resend or erase state. |
| `NOT_RUNNING` | Existing RPC code: connecting to the control socket failed with ENOENT/ECONNREFUSED. It is not proof that an older process finished cleanup. | Check the selected data directory and known process ownership. Coordinate normal startup only after the previous writer has exited; preserve locks/session. |
| `TIMEOUT` | Existing RPC response timeout. The pending command is not cancelled. | Inspect the original key; wait/investigate the pending operation. Never automatically repeat an SDK attempt or generate a replacement key. |
| `PROTOCOL` | Existing RPC code: invalid/mismatched/oversized response or connection ended before a result. | Treat the command's outcome as unknown; inspect the original key and investigate transport/version/response size. No automatic retry. |
| `UNKNOWN` | Current boundary has no explicit classified cause (including unclassified SDK, filesystem, storage or startup failures). Public text is safe and generic. | Inspect the original key and available status/evidence; escalate diagnosis without claiming failure to send. |

The list is deliberately bounded; it does not classify every throw or interpret SDK messages/statuses. Explicit safe validation/precondition/conflict and RPC messages remain human-readable. Arbitrary exception messages, JSON syntax excerpts and option-parser values can contain bodies, SDK material or private paths: these use safe public messages instead. Unknown-command/startup failure text also avoids echoing supplied command names/private paths. A failed download preserves the safe partial-file notice but omits the private path and inner SDK/stream exception; inspect the originally requested output path locally. Causes and stacks are never added to command JSON or logs.

For **any** error involving a key, query `request` with the **original** key. `data: null` means no intent was recorded at that observation; it neither cancels work nor proves a command still in flight will never persist. An error/timeout/closed socket does not prove absence of remote effects or intent. A recorded key with the original arguments returns its evidence without target validation, identity lookup, file reading or sending, even offline/after restart or identity changes. Correcting a conflict is not authorization for a new send.

`ok: true` means a valid local result. `attempt: uncertain` stays successful command data, possibly with `errorObserved: true`, and never becomes proof of nondelivery. SDK return, server ACK, delivery, read and phone confirmation remain separate; retain earlier independently observed receipts even after `LOCAL_STATE`.

Fictional examples, with the same error projection in both formats:

```sh
node dist/src/cli.js --output compact send --jid '123450001@lid' --key 'example-message-001' --text 'Different intent'
node dist/src/cli.js --output full send --jid '123450001@lid' --key 'example-message-001' --text 'Different intent'
```

Each fails with its own correlation ID (illustrated as `fictional-rpc-id`):

```json
{"id":"fictional-rpc-id","ok":false,"error":"Idempotency key already used with different arguments","code":"KEY_CONFLICT"}
```

Inspect the original intent in either format with `request --key 'example-message-001'`. A full or compact local validation error has no RPC ID, for example `{"ok":false,"error":"--text is required","code":"INVALID_ARGUMENT"}`. A local completion error can be `{"id":"fictional-rpc-id","ok":false,"error":"Local operation completion could not be persisted; inspect the original idempotency key","code":"LOCAL_STATE"}`; this does not contradict previously observed delivery.

Legacy/future compatibility: an older daemon can return `{"id":"fictional-rpc-id","ok":false,"error":"Idempotency key already used with different arguments"}`. The new CLI preserves that absence of `code`; it cannot prove `KEY_CONFLICT` from the text. Treat absent or unfamiliar codes as unclassified, with the same conservative next steps as `UNKNOWN`. Existing unfamiliar daemon codes are forwarded unchanged in full/compact. `status` and `stop` with no socket remain `ok: true, running: false`; `start`/`alreadyRunning` returns the existing daemon without upgrading it or synthesizing codes.

## Volume and benchmark

Neither mode truncates text. Unicode, quotes, line breaks, bodies, captions, IDs, phones, keys and codes remain complete. No list is silently shortened. Use existing `--limit`, `--offset`, chat state filters and search query/JID filters. Pagination and limits are unchanged: pages read a changing partial local set, not a WhatsApp snapshot. Advance by the requested limit and deduplicate exact JIDs.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm benchmark:output
```

The offline benchmark uses `test/fixtures/responses.ts`: four chats with known/unknown/manual/pending states; five history rows with quote/card/deletion/boundary; three search hits across PN/LID/group JIDs; a conflicting contact with two mapping edges; one uncertain send request. Bodies are short fictional examples without artificial repetition. Message fixtures pass through the existing public projection. The report prints counts, never SDK objects or bodies.

Both sides use `JSON.stringify` without indentation, excluding the final newline. Bytes are UTF-8 bytes. Tokens use **js-tiktoken 1.0.21, `o200k_base`** on that same payload; special-token-looking strings are ordinary text. This pinned devDependency provides pure JavaScript and bundled ranks ([package/source](https://www.npmjs.com/package/js-tiktoken?activeTab=versions)), avoiding encoding downloads, native runtime or API/model calls. There is no new runtime dependency. Tokenization exists only in the benchmark; `pnpm test` stays offline.

These counts describe that encoding, not exact GPT-6.1 billing or tool/chat framing, nor a guarantee for other models or real conversations. Long text dominates both formats. Byte reduction is not token reduction. No truncation variant exists.

Recorded results (regenerate after changing fixtures/projections):

| Scenario | Full bytes | Compact bytes | Byte reduction | Full tokens | Compact tokens | Token reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chats with states/pending | 1267 | 1084 | 14.44% | 368 | 304 | 17.39% |
| History with quote/card/deletions | 2349 | 1865 | 20.6% | 644 | 499 | 22.52% |
| Search across exact JIDs | 1307 | 1037 | 20.66% | 356 | 278 | 21.91% |
| Contact conflict | 1172 | 1047 | 10.67% | 331 | 297 | 10.27% |
| Uncertain send request | 651 | 651 | 0% | 172 | 172 | 0% |

The recovery/continuity envelope adds 154 UTF-8 bytes and 41 tokens to each of these offline fixtures in both formats, compared with the previous recorded baseline; it introduces no new output reduction. An actual interruption/retry carries additional evidence and can be larger.

The unchanged request is intentional: it retains evidence and immutable intent needed to avoid duplicate sends.

New direct PN send requests also retain their entire `route` in both modes: status, actual destination, SDK query source, local observation time, limit and any unproven reason. This adds per-request evidence and payload; the legacy fictional benchmark above has no route and does not measure that addition. An absent route never inherits a later contact mapping. See the [send contract](../README.md#agent-commands) for current server-association versus exact-original-destination limits.
