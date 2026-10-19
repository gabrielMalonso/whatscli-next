# Compact JSON contract

Use `--output compact` explicitly for agents. The default and `--output full` preserve the existing safe public projection. Both emit one minified JSON object, with the same exit codes. Full never means SDK objects, credentials, cryptographic material or private audit data.

```sh
node dist/src/cli.js --output compact chats --unread true --archived false --limit 20 --offset 0
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 10 --offset 0
node dist/src/cli.js --output full contact --jid '123450001@lid'
node dist/src/cli.js --output full request --key 'example-message-001'
```

Formatting runs in the CLI after the original response. It cannot re-execute an operation, contact WhatsApp, read/write SQLite or affect idempotency. It reduces stdout consumed by an agent; the private socket response is unchanged. Do not repeat a send or mutation solely to change format: inspect the original key with `request --output full`.

## Projections and inheritance

The envelope is unchanged: `ok`, errors/codes, RPC correlation `id`, running/connection state, local source, partial coverage, unknown app state, pending notifications and issues. Errors are unchanged. A successful command can still describe an uncertain result.

| Command | Compact differences from full |
| --- | --- |
| `chats`, `chat` | Omit metadata `observedAt`, null `name` and empty `pending`. Keep exact JID, archived/unread states, unread count and activity timestamp/source. Nonempty pending intents retain exact keys and boolean values. |
| `messages` | `data` becomes `{jid, messages: [...]}`. Every row inherits that exact `data.jid`, without PN/LID equivalence. Keep ID, direction, participant (including null), timestamp, text/type and SDK status. |
| `search` | Keep the original array order and each row's exact JID, even with `--jid`. Never combine identities or colliding IDs. Uses the message component omissions below. |
| `contact`, nested `resolve.contact` | Omit contact `source` when equal to the envelope source. A metadata field `{value}` inherits both `source` and `observedAt` from its exact enclosing `contacts` record, only when both originally match. Otherwise retain all three fields. Keep every mapping edge and its source/time, conflicts, null phone, historical flag and verification. |
| `archive`, `unarchive`, `read`, `unread` | Apply the chat projection to `data.localChat`. Keep the complete request and pending verification. |
| Others | Unchanged. In particular, `send`, `send-file` and `request` retain immutable operation, key, message ID, attempt, acceptance, delivery, read and error evidence. |

Message component defaults are explicit:

- Missing `quote`, `contacts`, `media` or `stubType` means the full field was null. Present components retain every public field. Missing quote means no local quote evidence; missing media does not prove there is no unavailable media.
- `deletion: {status: "unknown"}` expands to `{status: "unknown", source: null, observedAt: null}`: no deletion observation, not proof of remote availability. Deleted/uncertain boundaries retain source/time and withhold bodies.

There is no general removal of false, zero, null or unknown. Null chat states/counts, pending values, `status: 0`, unknown receipts and missing request (`data: null`) retain their meanings. Absent chat `pending` means an empty local map, without establishing remote state. Omitted chat `observedAt` is a projection choice, not a freshness claim. Activity remains observed activity, not metadata arrival time.

Embedded quotes keep their exact available references and embedded/unknown/deleted state. Shared cards keep `source: shared-content`. Neither becomes verified identity. Deleted/withheld bodies and private fields are excluded before either format is applied; full cannot recover deleted content.

Use full to inspect metadata observation times, consume the original history array, or inspect public fields without applying these defaults. Use `contact`/`resolve` for identity evidence, never cards or names.

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
| Chats with states/pending | 1113 | 930 | 16.44% | 327 | 263 | 19.57% |
| History with quote/card/deletions | 2195 | 1711 | 22.05% | 603 | 458 | 24.05% |
| Search across exact JIDs | 1153 | 883 | 23.42% | 315 | 237 | 24.76% |
| Contact conflict | 1018 | 893 | 12.28% | 290 | 256 | 11.72% |
| Uncertain send request | 497 | 497 | 0% | 131 | 131 | 0% |

The unchanged request is intentional: it retains evidence and immutable intent needed to avoid duplicate sends.
