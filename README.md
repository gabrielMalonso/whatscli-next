# whatscli-next

A small, JSON-only WhatsApp CLI for agents. TypeScript, pnpm, SQLite, and a single Baileys connection. No browser, interactive menus, or manual chat interface. MIT licensed.

The [real-account feasibility validation](docs/validation.md) passed for pairing, restart, text exchange, idempotency, archive/read operations, phone-originated changes, and automatic reconnect. The CLI preserves the observed limits: partial local history, uncertain sends, and chat fields that can lag behind the phone.

## Install

Requires **Node.js 24.18+ (24.x)** and **pnpm 10.24.0**. Linux was tested; macOS uses the same Unix socket design but has not been run on a Mac.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node dist/src/cli.js help
```

`help` returns a JSON command reference. You can also run `pnpm -s whatscli ...`. Use Node directly when another program must consume stdout without package-manager output.

Baileys is pinned to `7.0.0-rc14`, including its bundled protocol version. `pnpm-lock.yaml` fixes the dependency graph and integrity hashes. Installation scripts for Baileys (a Node version check) and protobufjs are disabled; the published code is used directly.

## Start and pair

```sh
node dist/src/cli.js start
node dist/src/cli.js status
node dist/src/cli.js pair qr
```

`start` launches the background daemon and returns when its local socket is ready. WhatsApp connects asynchronously. Wait until `status.data.qrAvailable` is true before requesting a QR. `pair qr` returns a private local PNG path; the agent can show that image to the account owner, who scans it under WhatsApp → Linked devices → Link a device. Request another image if it expires. No phone number is needed.

Alternatively:

```sh
node dist/src/cli.js pair code --phone 12025550100
```

The number is fictional. Enter the returned code in WhatsApp's link-with-phone-number flow. QR images and pairing codes are sensitive and must not be published. No QR payload or credential objects are printed in ordinary responses.

Check `hasLinkedCredentials`, `connection: open`, and the returned account JID. The SDK's raw `registered` flag can remain false after valid Web pairing. Stop/restart retains the session:

```sh
node dist/src/cli.js stop
node dist/src/cli.js start
```

One data directory holds one account. Default locations:

- Linux: `$XDG_STATE_HOME/whatscli-next`, or `~/.local/state/whatscli-next`.
- macOS: `~/Library/Application Support/whatscli-next`.

Use the same `--data-dir PATH` on **every** command when selecting another directory:

```sh
node dist/src/cli.js --data-dir .private/session start
node dist/src/cli.js --data-dir .private/session status
```

For a restricted test session, start with `--allow-jid EXACT_JID`. An existing daemon keeps its configuration; stop it before changing options. `start --offline` serves stored data without contacting WhatsApp, for local checks.

## Agent commands

All examples below use fictional identifiers. Use an exact observed conversation JID, or resolve an explicitly international phone before first contact. Display names are not recipients. PN, LID, and group JIDs remain distinct; a LID is never interpreted as a telephone number.

```sh
node dist/src/cli.js resolve --phone '+12025550101'
node dist/src/cli.js contact --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js contact --jid '123450001@lid'
```

`resolve` requires an open WhatsApp connection and exactly `+` followed by 8–15 digits; no country/area code, punctuation or local-number interpretation is added. It uses the pinned Baileys `onWhatsApp` API. Only a single affirmative result for the exact requested PN JID yields `status: confirmed` and a usable `jid`. Missing, partial, ambiguous, different-identity or failed SDK responses yield `status: unknown`, with `jid: null`; an explicit negative yields `not-found`. The installed SDK filters out negative entries, so an empty result remains unknown. Inspect `data.status`, not just `ok`.

Verification is persisted separately from chats and authorizes text/document/contact-card first contact to that exact PN JID. It survives restart and is historical evidence, without an automatic expiry or claim that the phone is still assigned to the same person. A subsequent inconclusive/negative lookup replaces the prior verification. Resolution and an SDK send return do not create an observed conversation; archive/read still require an observed chat and a stored last-message key/timestamp. `--allow-jid` remains an exact restriction, including when a PN/LID association is known. Resolution does not grant authority to send to an unobserved LID alias.

`contact` is a local query and works offline. It returns exact identifiers, `source: local`, `historical: true`, the exact JID's verification, and safe contact metadata (`name`, `notify`, `username`, `verifiedName`, `status`) with per-field source/observation time. Association evidence comes from SDK contact/history/mapping events, alternate message keys and the SDK mapping key store. `mapping.status` is `known`, `unknown` or `conflict`; contradictory associations in either direction are retained. An unknown/conflicting LID has `phone: null`. No association is inferred from names or LID digits. Conflicts block first contact even with a positive phone check. Legacy journal mappings retain their original times; legacy SDK key-store/alternate message-key evidence has `observedAt: null` when the original time is unavailable. Metadata availability and identity coverage remain partial.

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

Search examines stored text/captions, not SDK key material. It matches literal substrings with Unicode case normalization; `%` and `_` are literal. Omit `--jid` to search all locally stored conversations. Lists return up to 100 items per request; use `--offset` for the next page. History coverage is always partial.

`chats` accepts independent `--unread true|false|unknown` and `--archived true|false|unknown` filters, combined with AND. Omit a filter to include every state. `unknown` matches a null field, including a pending mutation; it is never included in `false`. Query both kinds of unknown separately when inspecting gaps (the same chat may appear in both). `unread` remains the existing mutation command; listing and `chat --jid EXACT_JID` only read local observations, without marking anything read or contacting WhatsApp. Verified recipients and SDK send returns alone do not enter this list. PN/LID identities remain separate.

Chats are ordered by `activity.timestamp` descending, then exact JID in binary ascending order; missing activity comes last. Activity is the greatest positive, safe Unix timestamp **in seconds** observed from the installed rc14 fields `conversationTimestamp`, `lastMsgTimestamp`, `lastMessageRecvTimestamp`, an exact-chat embedded message, or an independently observed message's `messageTimestamp`. `activity.source` identifies the field (`chat.FIELD` or `message.messageTimestamp`); equal timestamps select the lexically first source. Missing/invalid timestamps stay `{timestamp: null, source: null}`. `observedAt` remains the local observation time in milliseconds, independent of activity. Renames, state updates, receipts/edits and an old history chunk arriving now cannot bump activity by their arrival time. Activity survives deletion of message bodies and contains no preview. Upgrade recovers legacy chat fields and stored incoming timestamps; legacy own-message rows cannot distinguish SDK returns from independent echoes and are conservatively omitted from that recovery.

Filters apply **before** limit/offset. Keep filters fixed and request offsets `0`, `limit`, `2*limit`, … until a short/empty page. A stable local set has no tie-related duplicates or omissions, including chats without activity. Each page reads current local state: new activity, state changes, additions or removal between pages can shift offsets and cause repeats or omissions. Deduplicate by exact JID and restart from offset 0 when a fresh pass is needed. There is no snapshot, remote scan or completeness guarantee. An empty local page/list does **not** prove that WhatsApp has no pending conversations; unavailable history and unknown states remain gaps.

Message results add these fields:

| Field | Contract |
| --- | --- |
| `quote` | `null` without quote evidence; otherwise an exact available `reference` (`jid`, `id`, `participant`, `fromMe: null`), `source: embedded` or `null`, `state: available/unknown/deleted`, `text` and `contentType`. Missing identifiers stay null. The enclosing chat supplies the JID only when the quote has no explicit remote JID. |
| `contacts` | `null` without card content; otherwise `source: shared-content`, `state: available/missing` and `cards`. Each card has `displayName`, vCard `name`, shared `phones` and `state: available/incomplete/missing/malformed`. |
| `deletion` | `status: deleted/unknown`, `source: messages.delete/revoke/chat-delete-boundary/null`, and `observedAt` (local milliseconds or null). `unknown` with a null source means no deletion was observed, not proof that a message still exists remotely. |

Quotes expose only one embedded level, after the SDK's bounded wrapper normalization. They are received snapshots, not a fetch of the original or proof of its author/current content. There is no fallback lookup of a missing quoted body. A known deleted quoted target hides its embedded text/type; an incomplete reference that could match a deletion stays unknown with hidden content. Different exact chats/authors are kept separate. No display-name addressing, raw context object, thumbnails, URLs, nested quotes or cryptographic fields are returned.

Card parsing handles plain vCard `FN` and `TEL` fields, unfolding continued lines and unescaping text. Shared telephone spelling is preserved, including local numbers; unsupported encodings or broken content may remain incomplete/malformed. Extra fields and raw vCards are omitted. Shared numbers and `waid` parameters never create contact mappings, recipient verification or permission to send. Use `resolve` independently.

Exact deletion/revocation evidence leaves a history row with null `text`, `contentType`, `media`, `quote` and `contacts`. Search considers only the message's current text/caption, excluding deleted bodies, quote text, cards and private audit evidence. Downloads and the SDK content callback also withhold deleted content. A partial update (including `message: null` alone) preserves earlier content; an explicit REVOKE stub or protocol revocation is separate evidence. Persistent markers prevent status, duplicate history and edits from restoring hidden content after restart. The first retained body is stored privately with the deletion marker; it has no public audit command.

Keys are matched by exact chat, message ID, direction and incoming participant when required. Own group messages retain their existing single-author identity when an echo adds a participant. An incomplete incoming group/broadcast deletion cannot select an author; it emits `message-deletion-unknown`, leaves other rows untouched and does not establish a deletion verdict. PN/LID aliases are never combined. Revocations validate the raw sender-relative target against the account-relative envelope: a same-author target follows the envelope's direction, while our own administrative group revocation of a received message requires its original participant. An inbound 1:1 target can name our account as the sender's destination; that perspective is accepted only against authenticated self PN/LID identities, normalized for device suffixes. The local target retains the envelope's exact peer chat without alias merging. A different sender's other-author target, missing self/direction evidence or inconsistent chat/participant remains unknown. A derived REVOKE update carrying a notification key must match an available consistent raw notification; rc14's lossy envelope projection cannot override the raw target or authorize deletion in another direction.

The SDK also types `{jid, all: true}` with no server time or message range. On that observation, known rows in the exact chat are deleted; a persisted local time boundary conservatively withholds later old/undated arrivals as `status: unknown, source: chat-delete-boundary`. A newly observed message timestamped after that boundary is allowed. Clock skew and missing timestamps cannot establish membership in the cleared range; unknown quotes across that boundary are withheld too. Legacy delete journals are recovered on upgrade; the same range uncertainty applies to old chat-wide events. This is local, partial evidence, not a remote retention guarantee. Previously exported files/responses are not recalled, and immutable outbound request intents retain the originally supplied text/caption as intent evidence.

Send text, a local file or one explicit contact card:

```sh
node dist/src/cli.js send \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-message-001' \
  --text 'A fictional example message.'

node dist/src/cli.js send-file \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-file-001' \
  --file ./example.txt \
  --mime text/plain \
  --caption 'Fictional attachment'

node dist/src/cli.js send-contact \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-card-001' \
  --name 'Fictional Contact' \
  --phone '+12025550103'
```

Files are sent as WhatsApp documents, with their filename preserved. The default MIME type is `application/octet-stream`. The initial size limit is 64 MiB. The daemon reads one byte snapshot, persists its size/SHA-256/arguments and generated message ID, then invokes Baileys using those exact bytes.

`send-contact` sends one real `contactMessage` through rc14's `sendMessage({contacts: {contacts: [card]}})` API. `--jid` addresses the recipient; `--name` and `--phone` describe only the shared card. The phone requires an explicit `+` followed by 8–15 digits, starting with a nonzero digit; no punctuation or inferred country code. The name must be nonblank and at most 256 UTF-8 bytes. Unicode, spelling and surrounding spaces are preserved without normalization; controls (C0/C1), Unicode line/paragraph separators and unpaired surrogates are rejected. The deterministic vCard 3.0 builder escapes backslash/comma/semicolon, uses CRLF framing and folds lines at 75 UTF-8 bytes without splitting code points. Raw vCards, implicit lookup and multiple cards are unsupported.

Before invocation, SQLite stores the exact recipient, name, phone, generated vCard and message ID in an immutable `send-contact` operation. A repeated key compares all this content and returns the original record, including while the SDK is pending, offline or after restart/identity changes. Changing recipient/name/phone/kind conflicts. Full, compact and `request` preserve the complete intent and separate attempt/receipt/uncertainty fields. Deleted current message bodies stay hidden; the original request remains intent evidence. SDK return alone establishes no acceptance, delivery, read or observed chat/state.

The card's phone does not verify identity, current WhatsApp membership, ownership or permission to share/send. It never feeds recipient checks, identity mappings or verified contacts. Recipient authorization uses the same exact observed-chat or persisted positive exact-PN rules as other sends; PN/LID aliases and `--allow-jid` remain exact. Sharing permissions and approved-contact choices belong to the downstream consumer. Card generation and behavior have offline fixture coverage only; phone rendering and real-account effects await checkpoint 06.

A key binds one immutable operation. Reusing it returns the recorded result, including uncertainty, without another send. Changed arguments are rejected. Reusing a file key returns its original manifest even if that path's contents have since changed. To inspect an uncertain result:

```sh
node dist/src/cli.js request --key 'example-message-001'
```

Do not substitute a new key just because a request timed out. An intentional new message needs a new key. The program never automatically resubmits uncertain intents, including after restart.

Download a stored media message:

```sh
node dist/src/cli.js download \
  --jid '12025550101@s.whatsapp.net' \
  --id 'EXAMPLE_MESSAGE_ID' \
  --out ./example-download.pdf
```

Use `--from-me true|false` and `--participant EXACT_JID` if the message ID is ambiguous. The daemon calls Baileys for decryption/download, writes a private output file, and returns its byte count and SHA-256. Existing output is never overwritten. Media is limited to 64 MiB; failed downloads report and preserve any partial file. Expired/unavailable media may require the SDK's reupload request or may remain unavailable.

Change chat state:

```sh
node dist/src/cli.js archive   --jid '12025550101@s.whatsapp.net' --key 'example-archive-001'
node dist/src/cli.js unarchive --jid '12025550101@s.whatsapp.net' --key 'example-unarchive-001'
node dist/src/cli.js read      --jid '12025550101@s.whatsapp.net' --key 'example-read-001'
node dist/src/cli.js unread    --jid '12025550101@s.whatsapp.net' --key 'example-unread-001'
```

These use `chatModify` and a stored last-message key/timestamp. Marking a conversation read does not separately send message read receipts. The affected public field becomes `null` with a `pending` intent until a corresponding fresh SDK observation establishes a known field. Unrelated, missing and neutral/null fields do not confirm it or make an old counter current. A positive SDK unread update establishes `unread: true`, but its exact total is unknown and returned as `unreadCount: null`; the SDK can send increments rather than absolute totals. Counter `-1` means manually unread; `0` means read unless the same update explicitly marks it unread. A fresh `0`/`-1` supersedes an older manual marker. `markedAsUnread: true` establishes unread; `false` clears only that manual marker and cannot erase a positive counter or prove read when the counter is unknown. Fresh evidence after a pending mutation replaces the affected stale evidence. Archive observations never confirm reading, nor do read observations confirm archiving.

## Recovery

Diagnostics and event inspection:

```sh
node dist/src/cli.js events --after 0
node dist/src/cli.js reconnect
node dist/src/cli.js resync
```

Events are paginated by sequence (100 per request). The diagnostic `drop-connection` command closes only this daemon's WebSocket and lets its normal reconnect handler recover. `resync` returning successfully does not prove complete app state: the SDK can log and skip failed collections.

`status` and successful daemon/probe responses add `recovery` and `receiveContinuity` to the existing envelope, identically in full and compact output. Existing `connection` retains its coarse connection status; use `recovery.state` for the current runtime decision:

| `recovery.state` | Meaning |
| --- | --- |
| `offline` | Intentionally offline; no network attempts. |
| `connecting` | Initial connection, automatic retry, or manual replacement/cleanup in progress. |
| `open` | SDK reported open; this says nothing about complete receiving/decryption. |
| `waiting-retry` | One retry timer is scheduled. |
| `intervention-required` | Automatic recovery stopped; inspect `reason` and `code`. |
| `stopping` | Shutdown has started; no further connections will open. |

`recovery` always includes `reason`, `code`, `attempt` and `nextRetryAt`. Unknown/inapplicable values are null. `attempt` counts automatic retries since the last open/manual reconnect: while waiting it names the upcoming retry, while connecting it names the retry being made; initial/manual attempts are zero. `nextRetryAt` is a local Unix time in milliseconds, present only while waiting. Opens reset current recovery; `issues` remains historical and may include `connection-stopped-review-required` from a prior failure.

For pinned rc14 codes 408 (lost/timed out), 428 (closed), 503 (service unavailable), and 515 (restart required), retry waits are 1, 2, 4, 8, 16, then 30 seconds, capped without an attempt limit. A 515 can complete the SDK's pairing restart; it also waits at least one second to avoid repeated-restart spin. No credentials are reset and no new pairing is automatically requested. Codes 401/403/411/440/500 report `logged-out`, `forbidden`, `multidevice-mismatch`, `session-replaced`, or `bad-session` and stop retries. Unknown/missing codes report `unknown-disconnect` and stop, without assuming a transient cause.

`reconnect` explicitly retries using the same credentials after investigation, or replaces an active connection; concurrent calls share one replacement. It cancels a pending retry and waits for both SDK cleanup and actual transport closure. In rc14, another `end()` can return early, and the SDK close event can precede physical closure when the transport is already `CLOSING`. Automatic recovery and shutdown use the same closure checks. Each socket receives an isolated credential copy; only current-owner credential updates are copied into durable auth state. It cannot enable an offline or stopping runtime. A synchronous factory exception reports `socket-creation-failed`; since the SDK may have allocated resources without returning a cleanup handle, further reconnects are refused until runtime restart. Failed manual cleanup similarly reports `socket-end-failed` and requires investigation/restart. Persistence failures fail closed instead of entering an outage retry loop. Restart is an explicit new attempt using the same directory; intervention decisions are current-process state, not a persisted lockout. Preserve the directory and diagnose terminal/authentication failures before retrying.

`receiveContinuity: {status: "unproven", lastInterruption: {at, reason} | null}` retains one small local observation across restart. Reasons are `runtime-start`, `runtime-stop`, `connection-closed`, and `manual-reconnect`; `at` is the local observation time in milliseconds, never a remote gap boundary. Each later interruption replaces the previous observation; this is not an interval ledger. A null observation means none was recorded by this version, including a fresh/offline or upgraded directory. Network startup records risk before creating a socket, so even an abrupt exit leaves evidence for an offline restart. An open connection or `receivedPendingNotifications: true` never clears this risk or proves that every message arrived/decrypted. There are no lost-message counts, catch-up verdicts or automatic resync claims. Local queries and existing request keys remain usable during outages; new sends fail their connection precondition and uncertain intents are never resent.

## JSON and evidence

Use `--output compact` to reduce agent input, or `--output full` (the default) for the original safe public projection. Both are minified JSON. Compact uses command-specific omissions and exact-context inheritance; it never truncates text or changes pagination, evidence, errors or exit codes. See the [compact contract and reproducible token/byte benchmark](docs/output.md) before consuming its different history shape and documented optional fields. Use `request --output full --key KEY` to inspect an existing intent without repeating an operation.

Every command returns one JSON object on stdout; errors return `ok: false` and a nonzero exit code. SDK diagnostics go to the daemon's private `daemon.log` through stderr. Responses include connection state and `source: local`, `coverage: partial`, and `appState: unknown`.

- `ok` means the command was processed. It is not a delivery verdict.
- `attempt: sdk-returned` means Baileys returned. `uncertain` means completion is unknown. Intent is durable before invocation.
- `acceptance`, `delivery`, and `read` advance only on matching SDK status evidence; missing evidence remains `unknown`.
- Group participant receipts remain separate event evidence. One participant's receipt is not proof that every participant received/read the message.
- PN/LID associations are queryable evidence; requests, history and receipts keep their original identities without alias merging. Repeating a send key uses the original intent without another lookup, even offline or after verification changes.
- Chat snapshots are local observations, with unknown/pending fields when appropriate. The real test found read-state changes that reached the phone without promptly updating the client.
- Message output contains text, keys/identifiers, content type and safe media metadata. Raw SDK objects, sender-key distributions, and message secrets stay in private storage.

A transport timeout does not cancel an in-flight WhatsApp attempt. Query its key afterward. The SDK's outgoing retry-content cache is disabled and outgoing content is withheld from its retry callback, so it cannot silently re-relay an uncertain message through that path. This reduces recovery from recipient decryption failures; delivery can remain unknown. Incoming decryption retry requests remain enabled.

## Storage and execution

```text
agent → CLI → private Unix socket → daemon → Baileys
                                      ↓
                                    SQLite
```

Only the daemon owns the WhatsApp connection and writes SQLite. The retained JSONL probe uses the same runtime and must not run against an active daemon's directory. A lifetime SQLite lock enforces one writer and is released by the OS after a crash. Startup recovers an owned private stale socket; it preserves an active socket or an unfamiliar file. Use a shorter data-directory path if the complete Unix socket path exceeds 100 bytes.

The directory must be owned by the current user with private permissions (0700); credentials, databases, logs, socket, QR images, and downloaded files use 0600. Existing insecure state is rejected rather than silently repaired. The database file is `probe.sqlite`, retained from the validation program. Authentication uses the SDK's binary serializer and atomic key batches, with durable SQLite commits.

Credentials and messages are **not encrypted at rest**. Keep the entire directory, WAL/SHM files, QR images, logs, and backups private and out of version control. Stop the daemon before copying a backup. The repository ignores `.private/`, `.tmp/`, databases and logs; the package file allowlist excludes state. No credential deletion, logout, OS service installation or network-wide interruption is performed automatically.

## Verification and limits

```sh
pnpm test
pnpm check
```

Automated tests use fictional fixtures, offline daemons, local Unix sockets, and injected I/O failures; they never connect to real WhatsApp. See [the validation report](docs/validation.md) for real-account evidence and [the agent quick reference](docs/agents.md) for a compact workflow.

The [development roadmap](docs/roadmap.md) records the next capabilities and validation checkpoints. Contributions follow the independent-review workflow in [AGENTS.md](AGENTS.md).

This version covers one account per directory, exact recipient resolution, contact identity evidence, local history/search, text/documents, media download, archive/read operations and lifecycle. Complete-history guarantees, group administration, multiple-account orchestration, plugins and draft workflows are outside its scope. Phone resolution and first-contact sending have offline regression coverage; real 1:1/media validation remains a separate checkpoint.
