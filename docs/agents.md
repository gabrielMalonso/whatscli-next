# Agent quick reference

Run `node dist/src/cli.js --output compact ...` from the project directory. Each invocation writes one JSON response to stdout. Use the same `--data-dir PATH` on every command when selecting a session. All identifiers below are fictional. The default remains full for compatibility; these examples select compact explicitly. See the [compact JSON contract and benchmark](output.md) for documented defaults and full inspection.

## Session

```sh
node dist/src/cli.js --output compact start
node dist/src/cli.js --output compact status
node dist/src/cli.js --output compact pair qr
```

Ask the owner to scan the returned private PNG. Poll `status` until `connection` is `open`, and verify the account JID with the owner. Pairing images/codes are sensitive. Restarting with the same directory preserves the session; `stop` does not log out. For an existing linked session, no new pairing is normally needed.

## Identify and inspect

```sh
node dist/src/cli.js --output compact chats --limit 50 --offset 0
node dist/src/cli.js --output compact chats --unread true --archived false --limit 50 --offset 0
node dist/src/cli.js --output compact chats --unread unknown --limit 50 --offset 0
node dist/src/cli.js --output compact chats --archived unknown --limit 50 --offset 0
node dist/src/cli.js --output compact chat --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 20
node dist/src/cli.js --output compact search --query 'example' --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js --output compact resolve --phone '+12025550101'
node dist/src/cli.js --output compact contact --jid '123450001@lid'
```

Use an exact observed JID or the exact PN JID from a successful resolution, verified with the owner before real test operations. Never send to a display name or derive a telephone number from a LID. PN (`@s.whatsapp.net`), LID (`@lid`), and group (`@g.us`) identities remain distinct. Use `group --jid EXACT_GROUP_JID` to inspect a group's current metadata.

`resolve` requires an open connection and an explicit `+` international number (8–15 digits, no punctuation). Proceed only when `data.status` is `confirmed` and `data.jid` is non-null. Missing/partial results remain unknown; `ok: true` alone is insufficient. The check is persisted for exact PN first contact, without creating a conversation or verifying an unobserved LID alias. A later inconclusive/negative check supersedes it. Verification is historical evidence, with no automatic expiry or guarantee of continued phone ownership.

`contact` works offline and returns historical local metadata and association evidence with source/time. A LID without a unique association returns `phone: null`; `mapping.status: conflict` retains contradictory evidence instead of selecting a phone. Conflicting associations block first contact. A known mapping never rewrites a request, history or receipt, nor bypasses `--allow-jid`. Legacy SDK mapping and alternate message-key observation times may be null. Contact names are metadata, never addressing instructions.

Results describe locally stored data. `coverage: partial` applies even when a search returns no matches or history synchronization reports completion. Lists are limited to 100 results; page using `--offset`. Events use `events --after SEQUENCE` and return the next 100 entries.

For pending conversations, `chats` combines optional `--unread`/`--archived` filters with AND; each accepts `true`, `false` or `unknown`. Omission includes every state. Null/pending states match `unknown`, never `false`; inspect unread-unknown and archive-unknown separately to find either gap. Only observed chats appear, with exact PN/LID identities kept separate. These queries work offline, make no WhatsApp calls and never mark conversations read. `unread --jid ... --key ...` is still a mutation.

Ordering uses greatest observed conversation/message activity in `activity.timestamp` (Unix seconds), descending, then exact JID ascending; missing activity is last with null timestamp/source. `activity.source` names the rc14 chat timestamp field or `message.messageTimestamp`. Metadata observation time (`observedAt`, local milliseconds) and old chunks arriving now do not create fresh activity. Activity and states persist across restart. Upgrade conservatively excludes legacy own-message rows from activity recovery because an SDK return cannot be distinguished from an echo.

With fixed filters, advance offsets by the requested limit until a short/empty page. Filtering happens before pagination and ties are deterministic in a stable set. Pages read current local state, so changes between calls can repeat or skip entries; deduplicate exact JIDs and restart from 0 for a fresh pass. There is no snapshot/remote scan. An empty local list does not prove an empty remote queue: history is partial and unknown states may hide pending work.

Compact `messages` returns `data: {jid, messages: [...]}`; each row inherits that exact JID. Search remains an array with an exact JID on each row. Null quote/card/media/stub components are omitted; present quotes/cards and all unknown/deletion evidence remain intact. Messages include `deletion` and any available `quote`/`contacts`. Quotes contain one safe embedded snapshot and the available exact reference; absent bodies/identifiers remain unknown/null, with no guessed history lookup. Card `cards` contain display/vCard names, shared phone strings and per-card available/incomplete/missing/malformed states. These phones are shared content, never verified recipient identities or send authorization.

`deletion.status: deleted` hides current text/type/quote/cards/media and excludes the body from search/download. `status: unknown, source: null` means no deletion observation. `unknown` with `source: chat-delete-boundary` withholds an old/undated arrival after a chat-wide deletion whose exact range is unavailable. Exact markers survive duplicates and restart. Incomplete group deletion keys emit `message-deletion-unknown` without choosing an author. Inspect these evidence gaps; do not equate local content with current remote availability. Search covers current top-level text/captions, excluding quoted text, cards and private audit bodies. See [the public contract](../README.md#agent-commands) for details and observable limits.

## Send once

Choose a stable, unique key for the intended action before invoking a send:

```sh
node dist/src/cli.js --output compact send \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-message-001' \
  --text 'A fictional example message.'

node dist/src/cli.js --output compact request --key 'example-message-001'
```

Reusing the same key and arguments returns its stored result without another resolution/send, even offline or after identity evidence changes. Conflicting arguments (including PN/LID substitution) fail. A new key authorizes another operation, so do not create one merely because a command failed or timed out. Query the original key first. `data: null` from `request` means no intent has yet been recorded; a transport timeout does not cancel an in-flight command.

Use `request --output full --key KEY` to inspect the complete public intent without repeating an operation. Full is also useful for chat metadata observation times and the original history array shape. Neither mode truncates text. Interpret a request record using separate evidence fields:

| Field | Meaning |
| --- | --- |
| `attempt: uncertain` | Intent was persisted; the network outcome is unknown. It will not be resubmitted automatically. |
| `attempt: sdk-returned` | Baileys returned the expected message. This alone does not establish acceptance or delivery. |
| `acceptance: server-ack` | A matching SDK server acknowledgment was observed. |
| `delivery: delivered` | A matching SDK delivery status was observed. |
| `read: read` | A matching SDK read status was observed. |
| `errorObserved: true` | An invocation error or SDK error status was observed. This does not establish nondelivery. |

Missing receipt evidence remains `unknown`. Group participant receipts are separate events and cannot establish every participant's outcome. Phone confirmation is independent evidence; it does not rewrite SDK-derived receipt fields.

Share one explicitly supplied contact card with the same durable-key rules:

```sh
node dist/src/cli.js --output compact send-contact \
  --jid '12025550101@s.whatsapp.net' --key 'example-card-001' \
  --name 'Fictional Contact' --phone '+12025550103'
node dist/src/cli.js --output full request --key 'example-card-001'
```

The recipient JID is separate from the shared name/phone. Names preserve Unicode and spaces (nonblank, up to 256 UTF-8 bytes); controls, line separators and malformed Unicode are rejected. Phones require explicit `+` and 8–15 international digits, starting nonzero. vCard escaping/folding is automatic; raw cards and batches are unsupported. SQLite persists the exact name/phone/vCard before sending. Same-key content/kind changes fail; retrying the original command returns the recorded intent, including uncertainty, without lookup/resend. Full and compact preserve it identically. Deleted current bodies stay hidden while original intent remains queryable.

Shared content confers no identity verification, WhatsApp membership, phone ownership or send/share permission. Approved contacts and sharing policy belong to the downstream consumer. Only the recipient's exact observed conversation or separately persisted exact-PN verification authorizes sending; aliases never inherit authority. Offline tests cover SDK generation and injected behavior; real phone rendering awaits checkpoint 06.

## Files and chat state

```sh
node dist/src/cli.js --output compact send-file \
  --jid '12025550101@s.whatsapp.net' --key 'example-file-001' \
  --file ./example.txt --mime text/plain --caption 'Fictional attachment'

node dist/src/cli.js --output compact download \
  --jid '12025550101@s.whatsapp.net' --id 'EXAMPLE_MESSAGE_ID' \
  --out ./example-download.txt

node dist/src/cli.js --output compact archive --jid '12025550101@s.whatsapp.net' --key 'example-archive-001'
node dist/src/cli.js --output compact unarchive --jid '12025550101@s.whatsapp.net' --key 'example-unarchive-001'
node dist/src/cli.js --output compact read --jid '12025550101@s.whatsapp.net' --key 'example-read-001'
node dist/src/cli.js --output compact unread --jid '12025550101@s.whatsapp.net' --key 'example-unread-001'
```

Files are documents, limited to 64 MiB. A file key preserves its original manifest even if that path later changes. Downloads never overwrite existing files; failures preserve a private partial file. Use `--from-me true|false` and `--participant EXACT_JID` if a media ID is ambiguous.

Archive/read require an independently observed conversation and a stored last-message key/timestamp. Phone verification or an SDK send return alone does not meet that requirement.

After a chat mutation, the affected observed field becomes `null` with a pending intent until a corresponding SDK observation establishes a known field. A returned call or unrelated/null field is insufficient to claim success. In validation, compare the owner's phone with later `chat` and `events` results. Positive unread counters can be increments: they establish unread, with an unknown exact total. Counter `-1` means manually unread; `0` supersedes an older manual marker unless the same update explicitly marks unread. A manual `false` alone cannot prove read with an unknown counter or cancel a positive counter. Pending mutations invalidate older evidence for the affected field.

## Recovery

Inspect the response envelope's `recovery.state`: `connecting`, `open`, `waiting-retry`, `intervention-required`, `offline`, or `stopping`. `reason`/`code` explain a known failure; `attempt` counts automatic retries since the last open/manual reconnect; `nextRetryAt` is a local millisecond timestamp only while waiting. Both output modes retain these fields. Historical `issues` are separate: an old connection-stopped issue does not block a currently open runtime.

Known transient rc14 codes 408/428/503 and restart-required 515 retry indefinitely with waits capped at 30 seconds (at least one second, including 515). Terminal codes 401/403/411/440/500 and unknown codes require investigation. `reconnect` explicitly cancels a pending retry or replaces the socket with the same credentials; concurrent calls share cleanup/creation. It cannot enable offline access or reopen after shutdown. Socket creation/cleanup exceptions require investigation and a runtime restart; persistence failures fail closed. See [the recovery contract](../README.md#recovery) for reasons and limitations.

`receiveContinuity.status` stays `unproven`, even after open or pending-notification completion. Its persisted `lastInterruption` is only the latest local observation (`at` in milliseconds and `reason`), not a remote interval or lost-message count. It survives offline restart; a null marker does not prove uninterrupted reception. Source stays local, coverage partial, app state unknown. Consult stored history/requests during an outage; a new send fails offline, while repeating an existing key returns its evidence without sending. Never replace an uncertain intent with a new key just to recover.

`resync` asks Baileys to synchronize app state, but can return despite failed collections. Inspect later events without claiming catch-up.

Preserve the private data directory when diagnosing a failure. Never remove credentials or recreate the session as an automatic recovery step. Keep daemon logs, databases, QR images, backups, and message data private. See [the README](../README.md) for installation, storage permissions, and the full command reference.
