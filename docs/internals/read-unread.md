# Read/unread internals

See [chat-state usage](../user/chat-state.md) for public counter and pending-state rules. These implementation notes describe the pinned Baileys API.

## SDK observations

`chatModify` creates a `regular_low` app-state patch containing `markChatAsReadAction` and a message range. `appPatch` resynchronizes, sends the encoded patch, and saves its version. The CLI does not separately call `readMessages` or send an additional message read receipt.

The pinned rc14 package is patched with the compiled changes from fork commit `de9235c398aa50b3e12aaf2a8d0f04503bdeae92`; see [provenance and regeneration](../../patches/README.md). `chatModify` receives the immutable key as local `requestId`. Its unbuffered `patch-response` is projected into `request.appStateResponse` and a narrow `app-state.response` journal entry, inside one Store transaction. Only known non-send requests in `regular_low` can acquire that evidence. The first valid response is retained; duplicates cannot downgrade it or alter newer pending intents. No chat state or message receipt is advanced by this event. `perform` reloads the record on completion, preserving a response even if the SDK subsequently throws.

The runtime uses `emitOwnEvents: true`. An async invocation context and interception of the socket's emitter capture target `chats.update` events before the SDK buffer can merge them with remote events. Only the affected archive/unread field is projected into `sdkReported`, with source `sdk-event-during-request`. These events never update observed chat state or discharge pending. A later resync can suppress the local patch because its saved version has advanced.

The context also covers the SDK's preflight resync, so this source deliberately does not claim that every captured legacy chat event is an own-patch echo. Its request key is local invocation context; the new response event has separate SDK correlation. The context is bound to the originating socket's ownership token; a replacement socket cannot reuse an old invocation inherited through recovery callbacks. Events for other conversations and events outside this context follow the usual observation path. Synthetic outgoing message upserts and target chat updates during sends are excluded from observed history/activity; a separate network echo remains observable.

SDK reports persist separately from chats. A newer intent clears its field's previous report, sufficient independent state removes it, and a late event cannot overwrite either. A return without an event does not create a report, and old requests are never backfilled from requested values. An event before an interrupted SDK call remains SDK evidence alongside the uncertain request outcome.

Noninitial remote read actions emit counter 0 or -1. The callback omits remote action time, message range, request key, and direction. Initial synchronization can produce neutral null. Buffering can wait for a chat, discard an old range, or absorb updates into history. Incoming messages produce increments that can combine with read actions. These counters are not reliable absolute totals.

## Pending state

Any valid counter (0, -1, or positive), or manual-unread true, can establish state and clear pending and the previous SDK report for that field. Positive evidence means unread with an unknown total, whether or not a read/unread intent was pending. Null or missing fields and manual false remain insufficient. The original request and its outcome are preserved; superseding pending does not confirm the requested phone effect.

Incoming messages received online or from an offline backlog produce positive counters through the existing SDK chat-update path. The runtime does not add a separate unread transition when storing a message. Positive history counters and duplicate increments can also establish unread, including after a read observation. This is a local interpretation of SDK evidence, not proof of remote freshness. In either buffered order of read and incoming, a positive aggregate establishes unread; an explicit zero in a later callback establishes read.

The selected message range comes from local history and may not include the latest remote message. A callback cannot be matched to that range. A contrary explicit state can clear pending; insufficient evidence leaves it pending across restarts. Neither arrival time nor clearing pending proves freshness, causation, or the requested phone effect.

Archive uses the same app-patch path. Different timing or decryption warnings do not establish stronger confirmation or explain a divergence.

List selection uses pending intent values for boolean filters by default, without replacing observed values in `chatView`. `matchedBy` records only the fields selected through intent. Unknown filters and `observedOnly: true` use observed values, including null pending state. Both paths filter in SQL before ordering and pagination. A response does not discharge pending: pending means missing state observation, not missing IQ response.

When changing this behavior, cover both mutation directions, event-buffer ordering, duplicate increments, history, restart, and exact-key replay in `test/read-unread.test.ts` and `test/pending.test.ts`.

## Own-device message reads

Direct delivery/read/played receipts no longer put the receipt time in `messageTimestamp`. The SDK keeps its status update and exposes a separate per-message receipt with the origin `userJid` and a timestamp in seconds. See upstream [issue #2726](https://github.com/WhiskeySockets/Baileys/issues/2726) and the [buffer-only proposal #2804](https://github.com/WhiskeySockets/Baileys/pull/2804). The fork fixes the source projection, covering both live updates and buffered merge orders. Existing timestamps already overwritten in SQLite are not rewritten from guesses.

The CLI recognizes a direct incoming read only when the receipt user is the current account's PN or LID and the exact incoming key exists. A READ status by itself, peer receipts, outgoing keys, groups, unknown IDs and a read time before the message time cannot clear conversation state.

A small persisted range tracks message keys responsible for validated SDK unread increments since a locally observed zero. Every positive update must include exactly the matching number of distinct incoming keys and valid original message times; otherwise coverage is insufficient. Every tracked key must acquire a matching own-device read receipt before the CLI establishes zero again. Partial and duplicate receipts cannot erase a newer unread key. Snapshots, manual unread markers and new read/unread intents invalidate this inference. Unknown or already untracked unread baselines need a separate chat-state observation; no intent or timeout substitutes for one.

The receipt can be absorbed into `messages.upsert.userReceipt` by buffering, or arrive as `message-receipt.update`; both paths use the same checks. The range survives restart, without inferring that unseen remote messages are covered. The public `readObservation` and narrow `chat-read-receipts` journal event identify `source: own-device-receipts` and `scope: tracked-incoming-messages`, with exact IDs, original message times and a separate `readAt` in seconds. This is local coverage of an external read observation, not a new confirmation of a prior CLI command. Archive state and `request.appStateResponse` remain independent.

## Equal-second mutation boundaries and evidence

Chat commands select every stored message at the maximum message timestamp in that exact conversation. Selecting one row was insufficient when two received messages shared a second: `INSERT OR REPLACE` during status updates can reverse their rowid tie break. A single-row selection could then omit the message that arrived last. Keeping the whole timestamp boundary avoids guessing an order and excludes older history. This does not prove that the local boundary contains the latest remote message or that a remote client applied the action.

`app-state.chat-action` journal entries project the SDK's decoded action, exact range and source. A `local-echo` entry can include the locally supplied `requestId`; it describes decoded outgoing data, not an independent observation. A `sync` entry includes representation, initial-sync and MAC-verification qualifiers, without inferred request correlation or originating-device identity. Only the named scalar fields and minimal message keys/times are stored; extra SDK payloads are excluded. These entries do not mutate chat state, clear pending, or strengthen the IQ response.

The manual-unread-before-arrival case remains an operational gap: a manual `unreadCount=-1`, a later positive increment and an own-device receipt for the new message do not independently establish that the manual marker was removed. The CLI can therefore remain unread while another client shows read. Without a sufficient separate chat-state action or additional protocol evidence, the receipt must not manufacture zero. The projection above allows the next observation window to distinguish a missing action from one that buffering did not project.

## Insufficient receipt reconciliation

A validated incoming range can have an observed-read or manual-unread baseline. The latter retains exact keys to expose message-level evidence and reject retired/duplicate IDs, but is never allowed to establish a conversation zero. Earlier persisted ranges had an implicit observed-zero baseline and remain compatible. Unknown baselines or mismatched batches still cannot create a range.

For a manual baseline, `readReconciliation` persists a narrow diagnostic and `chat-read-insufficient` records it in the public journal. It contains a minimal message ID/original time, receipt time, local capture time and the explicit reason `manual-unread-marker-unconfirmed`. It does not change observed read state, pending, request evidence or filters. The lifecycle is documented in [chat-state usage](../user/chat-state.md#message-read-manual-marker-unconfirmed).

The controlled capture established that message READ and an own-device receipt arrived without a decoded synced read=true action or a chat zero in that observation window. That blocks whole-chat confirmation using the current exposed evidence; it does not prove that no additional signal exists anywhere in the underlying protocol. A future protocol correction needs evidence that actually distinguishes removal of the manual marker. The diagnostic deliberately keeps that operational gap visible.

## Controlled diagnostic validation

Round 4 on 2026-10-21 validated CLI `afe20c389e2480d482b40aedfb931f6c1c01b526` with SDK `de9235c398aa50b3e12aaf2a8d0f04503bdeae92` on the ES candidate. The RJ control retained its original release. This was a coordinated browser/CLI comparison using four internal messages between owned accounts, separate from automated fictional fixtures. The private report, focused DOM observations and per-step JSON remain outside Git.

All eleven diagnostic checks passed, with no new divergence:

| Check | Observed result                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01   | Normal baseline had no diagnostic.                                                                                                                    |
| D02   | Three reproductions retained unread/count while exposing the exact message ID, original timestamp, read time and local capture time.                  |
| D03   | Native/adapter chat and archived lists preserved the field in full/compact and normal/observed-only output.                                           |
| D04   | Archive/unarchive intents and archive-only observations preserved the entire diagnostic, including `receivedAt`.                                      |
| D05   | Eligible main/archived rows, pending, `matchedBy` and observed-only filtering retained their meanings.                                                |
| D06   | A new arrival removed the previous example; its own receipt created an example for the new ID.                                                        |
| D07   | Both read and unread intents removed the diagnostic while leaving the affected state null/pending.                                                    |
| D08   | A subsequent normal read from an observed-zero baseline produced `readObservation` and read/zero, without an insufficient-evidence diagnostic.        |
| D09   | All four new messages retained their original timestamps after reading.                                                                               |
| D10   | One bounded page of 68 journal events contained three new minimal diagnostics identical to their public chat fields; no historical backfill occurred. |
| D11   | Restoration left the internal conversation archived/read-zero, with no pending intent or diagnostic.                                                  |

Restart persistence, invalid/foreign/duplicate/retired receipts, replacement by a newer `readAt` and isolated zero-observation cleanup remain supported by offline regressions, not an additional live test. The live reset and subsequent normal read do not demonstrate isolated-zero cleanup from an existing diagnostic. No synthetic receipts, restart or forced resync were used in this live round. Lifecycle rules remain those documented above; this validation adds no broader guarantee.

Scenario A remains **open**: manual unread, archive, new message with automatic unarchive, archive again, then browser menu read can leave the CLI unread while the browser shows read. Approval covers the diagnostic surface only. Operationally, the conversation can remain eligible for unread queues; consumers must preserve the insufficient-evidence qualifier rather than silently treating it as reconciled read or repeating a command. A further synchronization fix requires additional evidence of manual-marker removal. Round 4 requires no new candidate; PRs remain open for independent review, without merge authorization.
