# Local history and search

These commands query locally stored chats and messages and work offline:

```sh
node dist/src/cli.js chats --unread true --archived false --limit 50 --offset 0
node dist/src/cli.js chats --unread unknown --limit 50 --offset 0
node dist/src/cli.js chats --archived unknown --limit 50 --offset 0
node dist/src/cli.js chat --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js messages --jid '12025550101@s.whatsapp.net' --limit 20 --offset 0
node dist/src/cli.js search --query 'example text' --jid '12025550101@s.whatsapp.net'
```

History is partial. An empty local result does not prove that WhatsApp has no conversations or pending messages. Reading stored messages does not mark a chat as read.

## Group metadata

`group` fetches current metadata through the SDK and requires an open connection:

```sh
node dist/src/cli.js group --jid '120363000000000001@g.us'
```

## Search and filters

Search matches literal substrings of current message text and captions using Unicode case normalization. `%` and `_` are literal characters. Omit `--jid` to search all stored conversations. Quoted text, contact cards, deleted bodies, SDK keys, and private audit data are excluded.

`chats` accepts independent `--unread true|false|unknown` and `--archived true|false|unknown` filters, combined with AND. Omit a filter to include all its states. By default boolean filters consider the latest pending intent for each field; matching rows identify those fields in `matchedBy` as `pending-intent`, while their observed values remain null. Add `--observed-only` to restrict boolean filters to known observed state. `unknown` always matches null observed state, including pending mutations, and is distinct from `false`. A pending-intent match can therefore also appear in an unknown query. Inspect both unknown filters separately; a chat may match both.

Verification and SDK send returns alone do not create listed conversations. PN and LID histories remain separate.

## Ordering and pagination

Chats are sorted by `activity.timestamp` descending, then exact JID in binary ascending order. Chats without activity appear last. Activity uses a safe positive Unix timestamp in seconds; `source` identifies the observed chat field or independent message. `observedAt` records the separate local observation time in milliseconds.

Renames, state changes, receipts, edits, and late-arriving old history do not advance activity based on arrival time. Deleting message bodies does not erase activity or add a preview. See [Activity derivation](../internals/message-content.md#activity-derivation) for field selection and legacy recovery.

Filters apply before limits and offsets. Lists return at most 100 items. Keep filters fixed and request offsets `0`, `limit`, `2*limit`, and so on until a short or empty page.

Pages reflect changing local state, not a snapshot or remote scan. Despite stable tie ordering, additions, removals, and updates can shift offsets. Deduplicate by exact identity and restart at offset 0 for a fresh pass. See [command results](evidence.md) for coverage and uncertainty.

## Message fields

| Field      | Contract                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quote`    | Null without quote evidence. Otherwise contains an available exact `reference` (`jid`, `id`, `participant`, `fromMe: null`), `source: embedded` or null, `state: available/unknown/deleted`, text, and content type. Missing identifiers remain null. The enclosing chat supplies the JID only when no explicit remote JID exists. |
| `contacts` | Null without card content. Otherwise contains `source: shared-content`, `state: available/missing`, and `cards` with display name, vCard name, shared phones, and `state: available/incomplete/missing/malformed`.                                                                                                                 |
| `deletion` | `status: deleted/unknown`, `source: messages.delete/revoke/chat-delete-boundary/null`, and local `observedAt` in milliseconds or null. Unknown with a null source means no deletion was observed, not that the message remains available remotely.                                                                                 |

Quotes expose one level of received snapshot, not a fetch, verified author, or current original body. Missing quote text has no lookup fallback. Known deleted targets hide embedded text and type; incomplete references that may cross a deletion remain unknown with content hidden. Exact chats and authors remain separate. Raw context, thumbnails, URLs, nested quotes, and cryptographic fields are excluded.

Shared cards expose supported plain vCard name and phone fields. Unsupported encodings or malformed content may remain incomplete. Phone-number spelling, including local numbers, is preserved; raw cards and extra fields are omitted. Shared numbers and `waid` never establish mappings, recipient verification, or permission to send. Use [recipient identity](identity.md) independently.

Once a message's decoded content is stored, a later decryption-failure replay without new content for that exact identity preserves its content and original timestamp. The diagnostic event `message-content-unavailable` then includes `retainedContent: true`; the replay does not renew chat activity or invalidate read coverage. Identity evidence and status updates remain observable, while content-bearing updates follow the ordinary path. New unknown messages remain insufficient evidence. This rule does not restore previously degraded records or deleted bodies.

## Deletion and revocation

Exact deletion evidence retains the history row but clears `text`, `contentType`, `media`, `quote`, and `contacts`. Search, downloads, and the SDK content callback withhold deleted bodies. Updates, duplicate history, edits, and restarts cannot restore hidden content. `message: null` alone is not deletion evidence.

Deletion must identify the exact chat, message ID, direction, and incoming participant when required. An incomplete group or broadcast author emits `message-deletion-unknown` without deleting another author's row. PN/LID aliases never merge. See [Revocation validation](../internals/message-content.md#revocation-validation) for SDK target normalization.

The first retained body remains private alongside its deletion marker; no public audit command exists. Immutable outbound intents retain their original supplied text and captions. Previously exported files and responses cannot be recalled, and local deletion handling does not establish remote retention.

### Chat-wide deletion

An SDK observation such as `{"jid":"12025550101@s.whatsapp.net","all":true}` contains no server time or message range. It marks known rows in the exact chat as deleted and persists a local-time boundary. Later arrivals of old or undated messages, and quotes that may cross the boundary, are withheld as `status: unknown, source: chat-delete-boundary`. Newly observed messages timestamped after the boundary are allowed.

Clock skew and missing timestamps leave the cleared range uncertain. Legacy chat-wide deletion journals are recovered during upgrades with the same limitation.
