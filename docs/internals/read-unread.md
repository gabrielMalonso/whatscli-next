# Read/unread internals

See [chat-state usage](../user/chat-state.md) for public counter and pending-state rules. These implementation notes describe the pinned Baileys API.

## SDK observations

`chatModify` creates a `regular_low` app-state patch containing `markChatAsReadAction` and a message range. `appPatch` resynchronizes, sends the encoded patch, and saves its version. The CLI does not separately call `readMessages` or send an additional message read receipt.

The runtime uses `emitOwnEvents: false`. Decoding a locally generated patch would not independently confirm a phone effect. A later resync can suppress that patch because its saved version has advanced.

Noninitial remote read actions emit counter 0 or -1. The callback omits remote action time, message range, request key, and direction. Initial synchronization can produce neutral null. Buffering can wait for a chat, discard an old range, or absorb updates into history. Incoming messages produce increments that can combine with read actions. These counters are not reliable absolute totals.

## Pending state

An explicit 0, -1, or manual-unread true can establish state and clear pending. An isolated positive counter, null or missing field, or manual false cannot. Without pending, positive evidence means unread with an unknown total.

The selected message range comes from local history and may not include the latest remote message. A callback cannot be matched to that range. A contrary explicit state can clear pending; insufficient evidence leaves it pending across restarts. Neither arrival time nor clearing pending proves freshness, causation, or the requested phone effect.

Archive uses the same app-patch path. Different timing or decryption warnings do not establish stronger confirmation or explain a divergence.

When changing this behavior, cover both mutation directions, event-buffer ordering, duplicate increments, history, restart, and exact-key replay in `test/read-unread.test.ts` and `test/pending.test.ts`.
