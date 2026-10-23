# Archive and read state

Use these commands to request changes to a conversation's archive or read state:

```sh
node dist/src/cli.js archive   --jid '12025550101@s.whatsapp.net' --key 'example-archive-001'
node dist/src/cli.js unarchive --jid '12025550101@s.whatsapp.net' --key 'example-unarchive-001'
node dist/src/cli.js read      --jid '12025550101@s.whatsapp.net' --key 'example-read-001'
node dist/src/cli.js unread    --jid '12025550101@s.whatsapp.net' --key 'example-unread-001'
```

## How state changes work

These commands use `chatModify` with a stored last-message key/timestamp.

Marking a conversation read does not separately send message read receipts.

After a mutation, the affected public field becomes `null` with a `pending` intent until a corresponding SDK observation establishes a known state.

Unrelated, missing, and neutral/null fields do not confirm the mutation or make an old counter current.

## Server response and command feedback

Read/archive results expose two independent signals:

```json
{
  "feedback": {
    "serverResponse": "version-matched",
    "stateObservation": "pending"
  }
}
```

This means the response's collection version matched the submitted version, while the conversation still lacks a sufficient state observation. It does not mean that the action failed or that the phone confirmed it.

`request.appStateResponse` persists the collection, submitted version, optional server version, status and local `receivedAt` time. It is also available through `request --key KEY`, including after restart. `serverResponse` is `unknown` without recorded evidence, `response-received` for a response without an exact version match, or `version-matched` for a matching response. A bare or mismatched response is never upgraded to a matching one.

`stateObservation` is `pending` for this request's outstanding observation, `superseded` when a newer intent for the same field is pending, `available` when the field has an observed boolean, or `unknown` when neither is available. An available state can contradict the request; it does not prove causation or current phone state.

An SDK/local failure can coexist with a server response. Inspect `request.attempt` and `request.errorObserved` as well as the response. Never automatically retry an uncertain operation. Reusing the exact key retrieves evidence without another SDK invocation. Historical requests without recorded response metadata remain unknown; this change does not backfill them from requested values or local echoes. Message acceptance/delivery/read fields retain their separate meaning.

## Local SDK state

When the SDK emits the explicitly correlated local echo of a mutation, `chat`, `chats`, and the mutation's `localChat` expose a separate `sdkReported` projection. For example:

```json
{
  "archived": null,
  "pending": {
    "archived": { "key": "example-archive-001", "value": true }
  },
  "sdkReported": {
    "archived": {
      "value": true,
      "source": "sdk-local-echo",
      "requestKey": "example-archive-001",
      "reportedAt": 1700000000000
    }
  }
}
```

This provides the SDK's decoded local echo without treating it as independent confirmation. `requestKey` is the `requestId` supplied to the SDK for that exact command. Synced actions never acquire that ID. `reportedAt` is the local capture time, not the remote action time. Historical reports with `source: sdk-event-during-request` remain readable; that older source described the invocation context and could include preflight sync.

`request.attempt: "sdk-returned"` means the call returned. A return without an echo or an error cannot manufacture a report. An independent update received in the preflight remains a state observation and can supersede pending; a later local echo cannot replace it. The response's note explains that SDK evidence, independent observation, and phone confirmation remain separate.

The ordinary `archived`/`unread` fields retain independent-observation semantics. They may remain null with `pending` even if `sdkReported` is known, the server replied, and the action worked in WhatsApp. A sufficient outside observation clears the affected pending intent and SDK report, even if the observed value differs from the request. A new intent clears the previous SDK report for that field. Reports survive restart; exact-key replay does not invoke the SDK again or recreate a superseded report. Legacy requests are not backfilled.

Boolean list filters also consider the latest pending intent by default, so `chats --unread true --archived false` can include a conversation just marked unread or unarchived through the CLI. Such rows retain null observed fields and include `matchedBy`, for example `{"unread":"pending-intent"}`. This describes requested state, even if no server response exists; it is not confirmed state. `--observed-only` excludes these matches. `unknown` always matches missing observed state, so a pending conversation can also appear in an unknown query. Inspect pending keys and response evidence before acting; queue membership is not permission to repeat an uncertain operation.

Full and compact output both preserve `sdkReported`. Pending indicates missing sufficient observation, not a failed action or a promise that confirmation will arrive. Waiting, querying the original key, or resynchronizing cannot guarantee an observation. Phone or browser confirmation remains separate evidence.

## Interpreting unread observations

An independently observed positive SDK unread update establishes `unread: true`, including while a read/unread intent is pending. It supersedes the pending unread intent and its previous SDK report, while preserving the original request and its outcome. This does not confirm that the requested read/unread action worked on the phone. Only explicitly identified local echoes populate `sdkReported`; the timing of an independent event within a call does not make it local.

The exact unread total remains unknown and is returned as `unreadCount: null`. The SDK can report increments rather than absolute totals.

Incoming messages received online or during a disconnection use this same SDK observation path. Positive history counters and duplicate increments can also establish unread, including after a read observation. These observations do not guarantee the current state on another device. The app preserves accepted observation order before SDK buffering: read followed by incoming establishes unread, and incoming followed by an explicit zero establishes read. Buffer absorption of a message READ cannot by itself manufacture conversation zero.

### Counter values

| Observation      | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `-1`             | Manually unread.                                                         |
| `0`              | Read, unless the same update explicitly marks the conversation unread.   |
| Positive counter | Unread evidence, but not an exact total when the SDK reports increments. |

An observed `0` or `-1` supersedes an older manual unread marker.

### Manual unread markers

- `markedAsUnread: true` establishes unread state.
- `markedAsUnread: false` clears only the manual unread marker.

Clearing the marker cannot erase a positive counter or prove the conversation is read when the counter is unknown.

## Confirmation limits

`observedAt` belongs to the whole local chat row. Metadata can refresh it without a new read/archive observation; it is not a per-field freshness guarantee.

Archive observations cannot confirm read state. Read observations cannot confirm archive state.

An observed state may differ from the requested state. Clearing `pending` does not prove the request caused the change.

The legacy chat callback provides neither request correlation nor remote action time. The pinned SDK has an install-time patch from the fork; see [dependency provenance](../../patches/README.md).

See [read/unread implementation constraints](../internals/read-unread.md).

## Reading received messages in another device

Opening a conversation or choosing the WhatsApp read menu can produce message receipts without a manual chat-state patch. The CLI can remove that conversation from unread queues when receipts from the account's own device cover every tracked incoming unread message since an observed read baseline. `readObservation.source` is `own-device-receipts`; its `scope` is `tracked-incoming-messages`. Message timestamps stay unchanged; `readAt` is the receipt time in seconds.

An old receipt cannot clear newer incoming messages or a newer manual unread marker. Unknown baselines, incomplete message ranges and pending read/unread intents remain uncertain until sufficient evidence arrives. The CLI does not turn a single message receipt into a global claim about unseen history or the effect of a previous command.

Decoded reactions are excluded from unread-message coverage, matching the SDK's counter behavior. They remain stored and can unarchive a conversation according to the account setting. Unknown or undecryptable content still makes coverage insufficient; this does not repair a baseline lost before the fix.

### New content after a manual marker

A manual unread marker observed over a known read/zero baseline is distinct from an unknown message backlog. A new, noninitial synced patch can preserve that origin when there is no pending read/unread intent or uncovered incoming increment. Its version, remote action timestamp and message frontier must be valid; the frontier must cover the locally stored latest boundary.

A complete increment containing new incoming IDs can then replace that marker with a tracked message range. Every message must have an original timestamp strictly after the action time and frontier, arrive as `notify`, and acquire a validated own-device read receipt. Only full coverage establishes zero. `readObservation.replacedManualMarker` records the prior action's timestamp in milliseconds, frontier in seconds and collection version; it does not confirm a CLI command.

Capture occurs before SDK buffering can merge increments or absorb READ into an upsert. Missing deltas never mean an absolute zero. A new independent marker or read/unread intent retires old coverage; old/duplicate actions and local echoes cannot retire a newer range. Loss of coverage captured before a crash persists across restart and prevents reuse of the old zero baseline.

Markers over unknown/positive state, incomplete batches, cached/replayed IDs, history/snapshots, ambiguous times and missing metadata cannot acquire this qualification. Message times have second resolution while action times have millisecond resolution; equality or clock disagreement remains conservative and can leave a real browser read unreconciled. The diagnostic below remains available for such unqualified manual ranges. Additional waiting is not a substitute for the missing ordering or coverage evidence.

## Inspect a command's SDK range

Use the current release's CLI and a recent event sequence supplied with the candidate:

```sh
node /absolute/release/dist/src/cli.js --account example events --after SEQUENCE
```

The response's `data` array contains `kind: app-state.chat-action` entries. Their nested `data` includes `source`, `action` and `messageRange.messages` (minimal IDs, direction and original message timestamps). Match a `local-echo` entry's `requestId` to the command key. It is decoded SDK output, not proof of application on another device. Synced entries identify `source: sync` with their sync/MAC qualifiers. Continue from the last returned `sequence` when a page has 100 events; no history scan or forced resync is needed.

A manual unread marker followed by a new incoming message can still remain unread locally after that message is read in another device when the qualified baseline, ordering or coverage above is unavailable. That receipt alone does not prove that the prior manual marker was cleared.

## Message read, manual marker unconfirmed

For an unqualified manually unread conversation, a receipt can prove that a tracked incoming message was read without confirming removal of the prior manual marker. `chat` and eligible `chats` rows then expose:

```json
{
  "readReconciliation": {
    "status": "insufficient-evidence",
    "reason": "manual-unread-marker-unconfirmed",
    "source": "own-device-receipt",
    "scope": "message",
    "message": { "id": "fictional-incoming", "timestamp": 1700000010 },
    "readAt": 1700000100,
    "receivedAt": 1700000100123
  }
}
```

`message.timestamp` and `readAt` are separate event times in seconds; `receivedAt` is local capture time in milliseconds. This is one message's evidence, not full conversation coverage. The last observed `unread`/counter, archive, pending and `matchedBy` semantics stay unchanged. Both normal and observed-only queues retain an eligible row and its diagnostic; compact output retains it too. The conversation can therefore remain in an unread queue while the browser shows it read. The diagnostic exposes that unresolved observation gap; it does not establish the browser's current state or justify retrying an uncertain command.

The diagnostic survives runtime restart. Archive-only intents and observations, neutral null counters and duplicate receipts preserve it. Any new valid unread-counter observation or explicit manual-marker field clears the old diagnostic; this includes a new incoming increment. Both new read and unread intents clear it and retire the old tracked range, while remaining pending as usual. A real zero observation clears it and establishes read through the existing path.

Only a first valid own-device read receipt for an exact ID/time in the current tracked range can create a diagnostic. Receipts for retired or unknown IDs, foreign users, outgoing keys or invalid/earlier times cannot create one. Already-recorded receipts for the same ID are ignored. Within a range, a different newly read ID updates the example only if its `readAt` is newer than the current example; equal or older times cannot replace it. A new incoming increment clears the public example but retains previously read members, so their duplicate receipts cannot recreate it for the new message. No waiting, automatic retry or forced synchronization substitutes for missing state evidence.
