# Read/unread internals

See [chat-state usage](../user/chat-state.md) for public counter and pending-state rules. These implementation notes describe the pinned Baileys API.

## SDK observations

`chatModify` creates a `regular_low` app-state patch containing `markChatAsReadAction` and a message range. `appPatch` resynchronizes, sends the encoded patch, and saves its version. The CLI does not separately call `readMessages` or send an additional message read receipt.

The runtime uses `emitOwnEvents: true`. An async invocation context and interception of the socket's emitter capture target `chats.update` events before the SDK buffer can merge them with remote events. Only the affected archive/unread field is projected into `sdkReported`, with source `sdk-event-during-request`. These events never update observed chat state or discharge pending. A later resync can suppress the local patch because its saved version has advanced.

The context also covers the SDK's preflight resync, so this source deliberately does not claim that every captured event is an own-patch echo. The request key is local invocation context, not SDK correlation. Events for other conversations and events outside this context follow the usual observation path. Synthetic outgoing message upserts and target chat updates during sends are excluded from observed history/activity; a separate network echo remains observable.

SDK reports persist separately from chats. A newer intent clears its field's previous report, sufficient independent state removes it, and a late event cannot overwrite either. A return without an event does not create a report, and old requests are never backfilled from requested values. An event before an interrupted SDK call remains SDK evidence alongside the uncertain request outcome.

Noninitial remote read actions emit counter 0 or -1. The callback omits remote action time, message range, request key, and direction. Initial synchronization can produce neutral null. Buffering can wait for a chat, discard an old range, or absorb updates into history. Incoming messages produce increments that can combine with read actions. These counters are not reliable absolute totals.

## Pending state

An explicit 0, -1, or manual-unread true can establish state and clear pending. An isolated positive counter, null or missing field, or manual false cannot. Without pending, positive evidence means unread with an unknown total.

The selected message range comes from local history and may not include the latest remote message. A callback cannot be matched to that range. A contrary explicit state can clear pending; insufficient evidence leaves it pending across restarts. Neither arrival time nor clearing pending proves freshness, causation, or the requested phone effect.

Archive uses the same app-patch path. Different timing or decryption warnings do not establish stronger confirmation or explain a divergence.

When changing this behavior, cover both mutation directions, event-buffer ordering, duplicate increments, history, restart, and exact-key replay in `test/read-unread.test.ts` and `test/pending.test.ts`.
