# Read/unread observations and confirmation limits

This offline investigation starts from `92e0a09f5c071eeb090d3b95efb5875ac592004e`, with Baileys `7.0.0-rc14`. It does not identify the exact cause of any historical phone/client divergence or complete physical validation. The earlier [phone evidence](validation.md) remains separate.

## What the installed rc14 actually emits

The inspected primary sources are the pinned package's `lib/Socket/chats.js`, `lib/Utils/chat-utils.js`, `lib/Utils/event-buffer.js`, `lib/Utils/process-message.js`, `lib/Utils/history.js` and `lib/Types/Chat.d.ts`.

- `chatModify` generates a `regular_low` app-state patch with `markChatAsReadAction.read` and a message range. `appPatch` first resynchronizes that collection, then encodes/queries the patch and saves its app-state version. A return establishes the SDK call's completion, not a phone observation or an individual message read receipt. `readMessages` is a separate SDK path; this CLI does not call it for `read`.
- The runtime deliberately keeps `emitOwnEvents: false`. The SDK's optional own-event path decodes the locally generated patch and emits it through the same handler. Enabling it would not create independent remote confirmation. A later resync does not guarantee an echo: the decoder suppresses mutations at or below its minimum version, and the write has already advanced the saved version.
- For a noninitial remote action, `processSyncAction` emits `chats.update` with `unreadCount: 0` for read or `-1` for manually unread. It does not expose the action's timestamp, message range, request key or message direction in that callback. `markedAsUnread` can appear in chat/history data, but is not the field this handler emits for `markChatAsReadAction`.
- During initial synchronization, a read action emits a neutral `null` counter. Its conditional compares the action's last-message timestamp with the buffered chat's last received timestamp. The buffer can retain the update while waiting for a chat, discard it when its range is older, or absorb it into history/upsert data. Absorption and counter aggregation can change which fields reach the runtime; there need not be a standalone `chats.update`.
- `processMessage` generates positive unread increments for qualifying incoming messages. The buffer can combine them with other counters, including read actions. These positive values are not reliable absolute totals or a standalone read-state confirmation.

Both archive and read use the app-patch path. The different observed phone/client timing does not establish a separate guarantee for archive, or identify whether an earlier read/unread callback was absent, filtered, combined or never independently generated. Decryption/integrity diagnostics are not automatically the cause of this divergence.

## Concrete defect and conservative correction

On the exact base, an incoming-message increment alone removed a pending read/unread intent. A buffered read action combined with an incoming increment could do the same. Three regressions failed on the unchanged base production sources with `unread: true` where the invalidated field should remain `null`.

The correction only changes the condition for discharging pending unread state: an observed `0`, `-1` or `markedAsUnread: true` can establish a state; an isolated positive counter cannot. Without pending, positive counters still establish unread with an unknown total. Historical positive totals and live increments share this conservative rule because the public counter does not reliably distinguish them. Missing/null fields and a manual `false` alone remain insufficient. Raw SDK counters are not accumulated into invented totals.

The regressions use real rc14 `processMessage`, `processSyncAction`, patch generation and event buffering, with an injected socket and fictional SQLite state. They cover both read/unread intents, duplicate increments, positive history counters, both buffer orders, a later separate explicit state, ordinary nonpending unread state, restart and same-key replay without another SDK invocation. Run `pnpm build && node --test dist/test/read-unread.test.js dist/test/pending.test.js`.

This correction does not eliminate legitimate pending state. A later explicit observation can be contrary to the requested value and still establish observed chat state. It leaves the original request's acceptance/delivery/read evidence unchanged. Clearing pending is not an acknowledgment tied to the operation.

## Retained limits

The runtime persists the exact intent/key before invocation and passes the latest locally stored message key/direction/timestamp to the SDK. It does not match a later chat callback against that message: the SDK callback omits that range. The SDK documents a reverse-chronological range through the last received message; one latest local message does not guarantee that boundary or current remote history. No PN/LID identity merge, name lookup or synthetic phone mapping is involved.

Callback arrival time is not remote action time. An old history chunk or an action from the SDK's pre-write resync can reach the store later and establish an observed state without proving freshness relative to the request. Duplicate or out-of-order explicit observations cannot be reliably ordered by remote mutation time with this callback alone. The fix adds no invented correlation, freshness guarantee or global resync/history recovery. Where no sufficient observation arrives, unknown/pending survives restart.

The additional local causal exercises executed the installed `chatModify`/`appPatch` bodies with injected query/key storage/resync, real encode/decode, real sync/message handlers and buffer, and the actual runtime listeners/store. They demonstrated own-event suppression, local-only own-event generation, version filtering, initial-sync conditions and absorption, lack of request metadata, exact PN/LID/group generation and required group participant/timestamp fields. These exercises establish SDK/code behavior, not what happened on a real phone.

## Finite physical test for the coordinator's single tester

1. Agree on one account and exact conversation. Keep the runtime's current observation as the baseline; do not restore a stale snapshot or force a historical unread flag. Record the current exact chat, stored last-message identity/direction/timestamp and event cursor without opening or changing the phone conversation.
2. Issue one authorized read or unread mutation with one new immutable key. Record the response and original request. Keep `sdk-returned`, phone-visible state and subsequent client observation as separate facts.
3. At the agreed checkpoint, inspect the exact `chat` and a bounded `events --after CURSOR` result once. Record whether `0`, `-1`, manual markers, positive counters, history or only unrelated/null fields arrived. A matching later state satisfies the state expectation without proving the original request caused it. An absent callback cannot distinguish every upstream/filtering hypothesis.
4. Only after recording that checkpoint, have the owner perform one separately agreed manual action. Inspect another bounded event range and chat observation. A resulting callback demonstrates the phone-originated observation path; it must not be attributed retrospectively to the CLI mutation. Do not send messages, trigger repeated resyncs or retry mutations to manufacture evidence.
5. If agreed, restart normally after recording the state, then inspect chat/request and replay the same key once. Verify persistence and no new invocation. If observation is still missing, report pending/unknown and stop; neither restart, a resync return nor absence of errors proves remote confirmation.

Existing safe event projections may not distinguish absence before the SDK buffer from filtering/absorption within it. A physical result without that trace must retain this ambiguity. No real account/session, credentials, private messages/logs, transport, phone or external snapshot was accessed in this investigation.
