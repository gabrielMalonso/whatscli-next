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

When the SDK emits state during a mutation, `chat`, `chats`, and the mutation's `localChat` expose a separate `sdkReported` projection. For example:

```json
{
  "archived": null,
  "pending": {
    "archived": { "key": "example-archive-001", "value": true }
  },
  "sdkReported": {
    "archived": {
      "value": true,
      "source": "sdk-event-during-request",
      "requestKey": "example-archive-001",
      "reportedAt": 1700000000000
    }
  }
}
```

This provides the SDK's local state without treating it as independent confirmation. `requestKey` identifies the local invocation context in which the legacy chat event was emitted. The patched SDK separately carries a local `requestId` on patch responses; it never assigns that ID to synced actions. `reportedAt` is the local capture time, not the remote action time. A preflight resync can also emit state during the call.

`request.attempt: "sdk-returned"` means the call returned. The response's note explains that SDK evidence, independent observation, and phone confirmation remain separate. `sdkReported` only appears after an actual SDK event; a return without an event or an error cannot manufacture a value.

The ordinary `archived`/`unread` fields retain independent-observation semantics. They may remain null with `pending` even if `sdkReported` is known, the server replied, and the action worked in WhatsApp. A sufficient outside observation clears the affected pending intent and SDK report, even if the observed value differs from the request. A new intent clears the previous SDK report for that field. Reports survive restart; exact-key replay does not invoke the SDK again or recreate a superseded report. Legacy requests are not backfilled.

Boolean list filters also consider the latest pending intent by default, so `chats --unread true --archived false` can include a conversation just marked unread or unarchived through the CLI. Such rows retain null observed fields and include `matchedBy`, for example `{"unread":"pending-intent"}`. This describes requested state, even if no server response exists; it is not confirmed state. `--observed-only` excludes these matches. `unknown` always matches missing observed state, so a pending conversation can also appear in an unknown query. Inspect pending keys and response evidence before acting; queue membership is not permission to repeat an uncertain operation.

Full and compact output both preserve `sdkReported`. Pending indicates missing sufficient observation, not a failed action or a promise that confirmation will arrive. Waiting, querying the original key, or resynchronizing cannot guarantee an observation. Phone or browser confirmation remains separate evidence.

## Interpreting unread observations

A positive SDK unread update observed outside the mutation's invocation context establishes `unread: true`, including while a read/unread intent is pending. It supersedes the pending unread intent and its previous SDK report, while preserving the original request and its outcome. This does not confirm that the requested read/unread action worked on the phone. Events captured during the call remain only in `sdkReported`.

The exact unread total remains unknown and is returned as `unreadCount: null`. The SDK can report increments rather than absolute totals.

Incoming messages received online or during a disconnection use this same SDK observation path. Positive history counters and duplicate increments can also establish unread, including after a read observation. These observations do not guarantee the current state on another device. If buffering combines read and incoming into a positive aggregate, unread wins in that callback; a later explicit zero establishes read.

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

Archive observations cannot confirm read state. Read observations cannot confirm archive state.

An observed state may differ from the requested state. Clearing `pending` does not prove the request caused the change.

The legacy chat callback provides neither request correlation nor remote action time. The pinned SDK has an install-time patch from the fork; see [dependency provenance](../../patches/README.md).

See [read/unread implementation constraints](../internals/read-unread.md).
