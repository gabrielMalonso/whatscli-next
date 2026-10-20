# Local history and search

Use these commands to inspect locally stored chats, messages, and groups:

```sh
node dist/src/cli.js chats --limit 50 --offset 0
node dist/src/cli.js chats --unread true --archived false --limit 50 --offset 0
node dist/src/cli.js chats --unread unknown --limit 50 --offset 0
node dist/src/cli.js chats --archived unknown --limit 50 --offset 0
node dist/src/cli.js chat --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js messages --jid '12025550101@s.whatsapp.net' --limit 20 --offset 0
node dist/src/cli.js search --query 'example text' --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js group --jid '120363000000000001@g.us'
```

History coverage is always partial. An empty local result does not prove that WhatsApp has no pending conversations.

## Search messages

Search examines stored message text and captions, not SDK key material.

Matching uses literal substrings with Unicode case normalization. `%` and `_` are treated as literal characters.

Omit `--jid` to search all locally stored conversations.

Lists return up to 100 items per request. Use `--offset` to retrieve subsequent pages.

## Filter chats

`chats` accepts two independent filters:

- `--unread true|false|unknown`
- `--archived true|false|unknown`

When both are supplied, they are combined with AND. Omit a filter to include all states for that field.

`unknown` matches a null field, including a pending mutation. It is never included in `false`.

Query both kinds of unknown separately when investigating gaps. The same chat may appear in both results.

The existing `unread` command changes chat state. Listing chats and running `chat --jid EXACT_JID` only read local observations. They do not mark conversations read or contact WhatsApp.

Verified recipients and SDK send returns alone do not add conversations to the list. PN and LID identities remain separate.

## Chat activity and ordering

Chats are ordered by:

1. `activity.timestamp` descending.
2. Exact JID in binary ascending order for equal timestamps.

Chats without activity appear last.

### Activity timestamps

Activity uses the greatest positive, safe Unix timestamp **in seconds** observed from these installed rc14 fields:

- `conversationTimestamp`
- `lastMsgTimestamp`
- `lastMessageRecvTimestamp`
- An exact-chat embedded message
- An independently observed message's `messageTimestamp`

`activity.source` identifies the selected field as `chat.FIELD` or `message.messageTimestamp`.

When timestamps are equal, the lexically first source wins.

Missing or invalid timestamps produce:

```json
{"timestamp": null, "source": null}
```

`observedAt` remains the local observation time in milliseconds. It is independent of activity.

The following do not advance activity based on their arrival time:

- Chat renames or state updates
- Receipts or edits
- Old history chunks arriving later

Activity survives deletion of message bodies and contains no message preview.

### Activity after upgrades

Upgrade recovery uses legacy chat fields and stored incoming message timestamps.

Legacy own-message rows cannot distinguish SDK returns from independent echoes, so they are conservatively excluded from activity recovery.

## Paginate chat results

Filters are applied **before** limit and offset.

Keep filters fixed and request offsets `0`, `limit`, `2*limit`, and so on until a page is short or empty.

For a stable local dataset, ordering avoids tie-related duplicates and omissions, including for chats without activity.

Each page reads the current local state. Between requests, new activity, state changes, additions, or removals can shift offsets and cause repeated or missing entries.

Deduplicate by exact JID. Restart at offset 0 when you need a fresh pass.

There is no snapshot, remote scan, or completeness guarantee. An empty local page or list does **not** establish that WhatsApp has no pending conversations. Unavailable history and unknown states remain gaps.

## Message fields

Message results include additional fields for quotes, shared contact cards, and deletion evidence.

| Field      | Contract                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quote`    | `null` without quote evidence. Otherwise includes an exact available `reference` (`jid`, `id`, `participant`, `fromMe: null`), `source: embedded` or `null`, `state: available/unknown/deleted`, `text`, and `contentType`. Missing identifiers remain null. The enclosing chat supplies the JID only when the quote has no explicit remote JID. |
| `contacts` | `null` without card content. Otherwise includes `source: shared-content`, `state: available/missing`, and `cards`. Each card contains `displayName`, vCard `name`, shared `phones`, and `state: available/incomplete/missing/malformed`.                                                                                                         |
| `deletion` | `status: deleted/unknown`, `source: messages.delete/revoke/chat-delete-boundary/null`, and `observedAt` in local milliseconds or null. `unknown` with a null source means no deletion was observed, not that the message still exists remotely.                                                                                                  |

## Quoted messages

Quotes expose one embedded level after the SDK's bounded wrapper normalization.

They are received snapshots, not a fetch of the original message or proof of its author or current content.

There is no fallback lookup for a missing quoted body.

When a quoted target is known to be deleted, its embedded text and content type are hidden. An incomplete reference that could match a deletion remains unknown, with its content hidden.

Different exact chats and authors remain separate.

Quote output excludes:

- Display-name addressing
- Raw context objects
- Thumbnails and URLs
- Nested quotes
- Cryptographic fields

## Shared contact cards

Card parsing supports plain vCard `FN` and `TEL` fields. It unfolds continued lines and unescapes text.

Shared phone-number spelling is preserved, including local numbers. Unsupported encodings or malformed content may produce incomplete or malformed cards.

Extra fields and raw vCards are omitted.

Shared numbers and `waid` parameters never create contact mappings, recipient verification, or permission to send.

Use `resolve` independently to verify a recipient.

## Message deletion and revocation

### Deleted message content

Exact deletion or revocation evidence retains the history row but sets these fields to null:

- `text`
- `contentType`
- `media`
- `quote`
- `contacts`

Search examines only the message's current text or caption. It excludes deleted bodies, quoted text, contact cards, and private audit evidence.

Downloads and the SDK content callback also withhold deleted content.

A partial update, including `message: null` alone, preserves previously stored content. An explicit REVOKE stub or protocol revocation provides separate deletion evidence.

Persistent markers prevent status updates, duplicate history, or edits from restoring hidden content after a restart.

The first retained body is stored privately alongside the deletion marker. There is no public audit command for it.

### Exact message identity

Deletion keys match by:

- Exact chat
- Message ID
- Direction
- Incoming participant, when required

Own group messages retain their existing single-author identity when an echo adds a participant.

An incomplete incoming group or broadcast deletion cannot identify an author. It emits `message-deletion-unknown`, leaves other rows unchanged, and establishes no deletion verdict.

PN/LID aliases are never combined.

### Revocation validation

Revocations validate the raw sender-relative target against the account-relative envelope.

For a same-author target, direction follows the envelope.

When our account administratively revokes another participant's received group message, the target must include the original participant.

An inbound 1:1 target may identify our account as the sender's destination. That perspective is accepted only against authenticated self PN/LID identities, with device suffixes normalized.

The local target retains the envelope's exact peer chat. No aliases are merged.

The following remain unknown:

- Another sender's other-author target
- Missing self or direction evidence
- Inconsistent chat or participant identity

A derived REVOKE update containing a notification key must match an available, consistent raw notification.

The rc14 envelope projection loses information and cannot override the raw target or authorize deletion in another direction.

## Chat-wide deletion

The SDK also supports a typed observation of:

```json
{"jid":"12025550101@s.whatsapp.net","all":true}
```

This observation provides no server time or message range.

When received:

- Known rows in the exact chat are deleted.
- A persisted local time boundary conservatively withholds later arrivals of old or undated messages as `status: unknown, source: chat-delete-boundary`.
- A newly observed message with a timestamp after that boundary is allowed.

Clock skew and missing timestamps prevent reliable identification of which messages belonged to the cleared range.

Unknown quotes crossing the boundary are also withheld.

Legacy deletion journals are recovered during upgrades. The same range uncertainty applies to older chat-wide events.

### Retention limits

Deletion handling provides local, partial evidence, not a guarantee about remote retention.

Previously exported files and responses cannot be recalled.

Immutable outbound request intents retain their originally supplied text or caption as intent evidence.
