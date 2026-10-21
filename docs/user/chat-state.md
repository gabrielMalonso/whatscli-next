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

This provides the SDK's local state without treating it as independent confirmation. `requestKey` identifies the local call during which the event was emitted; the SDK does not attach request correlation. `reportedAt` is the local capture time, not the remote action time. A preflight resync can also emit state during the call.

`request.attempt: "sdk-returned"` means the call returned. The response's note explains that SDK evidence, independent observation, and phone confirmation remain separate. `sdkReported` only appears after an actual SDK event; a return without an event or an error cannot manufacture a value.

The ordinary `archived`/`unread` fields and their filters retain independent-observation semantics. They may remain null with `pending` even if `sdkReported` is known and the action worked in WhatsApp. A sufficient outside observation clears the affected pending intent and SDK report, even if the observed value differs from the request. A new intent clears the previous SDK report for that field. Reports survive restart; exact-key replay does not invoke the SDK again or recreate a superseded report. Legacy requests are not backfilled.

Full and compact output both preserve `sdkReported`. Pending indicates missing sufficient observation, not a failed action or a promise that confirmation will arrive. Waiting, querying the original key, or resynchronizing cannot guarantee an observation. Phone or browser confirmation remains separate evidence.

## Interpreting unread observations

Without a pending read/unread mutation, a positive SDK unread update establishes `unread: true`.

The exact unread total remains unknown and is returned as `unreadCount: null`. The SDK can report increments rather than absolute totals.

A positive counter alone cannot resolve a pending read/unread intent.

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

The rc14 callback provides neither request correlation nor remote action time.

See [read/unread implementation constraints](../internals/read-unread.md).
