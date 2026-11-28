# Agent quick reference

Run `node dist/src/cli.js --output compact ...` from the checkout. Commands return JSON on stdout; [JSON output](output.md) defines compact response shapes and defaults. All examples use fictional identifiers.

Select the same account on every command with `--account NAME` (for example, `--account example`), or use `--data-dir PATH` for an explicit session directory. Do not combine the selectors. Omitting both uses the default session. See [Getting started](getting-started.md) for account names, pairing, and trusted private paths.

## Check the account

```sh
node dist/src/cli.js --output compact status
```

Confirm the account JID with its owner. Network operations require linked credentials and `connection: open`. Check the responding build fingerprint when changing installations; `alreadyRunning: true` does not upgrade the daemon. See [runtime recovery](../operations/runtime.md) for connection problems.

## Select the exact conversation

```sh
node dist/src/cli.js --output compact chats --unread true --archived not-true --limit 50 --offset 0
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 20
node dist/src/cli.js --output compact resolve --phone '+12025550101'
node dist/src/cli.js --output compact contact --jid '123450001@lid'
```

Use an exact observed JID or the exact PN JID returned by `resolve` with `data.status: confirmed` and a non-null `data.jid`. Names, LID digits, aliases, and shared contact cards cannot identify or authorize a recipient. Investigate conflicts before sending; see [recipient identity](identity.md).

History is partial. Build triage queues with `--archived not-true`, which keeps chats whose archive state is unknown; `--archived false` matches only explicit false and can hide unread conversations. Rows keep `archived: null` for unknown state; `not-true` already covers false plus unknown, so use separate `unknown` queries only to tell which is which. Keep pagination filters fixed, and deduplicate by exact JID as pages change. See [history and search](history.md).

Queue filters also include matching pending intents. A row with `matchedBy.unread: "pending-intent"` is requested unread state, with `unread: null` until observed. Use `--observed-only` for strict observations. Mutation `feedback.serverResponse` distinguishes a matching server version, an unmatched response and no recorded response; `feedback.stateObservation` tracks the separate observation. Inspect the original key and `request.appStateResponse`; pending is not a failed command or a reason to issue another key.

## Send and inspect

Choose a stable key before invoking an intended action:

```sh
node dist/src/cli.js --output compact send \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-message-001' \
  --text 'A fictional example message.' \
  --wait-ack-ms 5000

node dist/src/cli.js --output full request --key 'example-message-001'
```

`--wait-ack-ms 5000` returns once server acceptance or an error is observed, or after 5 seconds with `data.wait.outcome: timeout` and acceptance still unknown. Use it instead of sleeping and polling; a timeout is not a failure. Use `request --key` later for delivery and read evidence. See [waiting for acceptance](sending.md#waiting-for-server-acceptance).

After an error or timeout, inspect the original key. Never use a new key to retry an uncertain action. Read [command results and retry rules](evidence.md) before interpreting the outcome; command success alone does not establish delivery.

See [sending and media](sending.md) for files, cards, routes, and downloads, and [quoted replies](quoted-replies.md) for exact quote selectors.

## Mark read or archive without missing a reply

Before `read` or `archive`, pass as the guard the ID of the last incoming message whose content you actually read, usually `latestIncoming.id` once you have read that message. Pass `none` only when the chat had no incoming message. Never name a message with `available: false`, or one you only saw in a `chat`/`chats` row:

```sh
node dist/src/cli.js --output compact chat --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js --output compact read \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-read-001' \
  --if-latest-incoming 'FICTIONAL-IN-001'
```

The daemon checks the guard immediately before it builds the patch, so no script comparison is needed. Own messages, protocol stubs after your sends, edits and reactions are ignored. Missed calls, unrecognized content, and late or same-second arrivals block it. While any counted message in the chat has `available: false` (undecryptable so far), the guard refuses with `unavailable-incoming`. Once they become available, run `incoming --jid JID --after ID` with the last message you read before them (or `none`), page while `truncated` is `true`, and read every listed message before naming one: a message that gains content moves after messages stored meanwhile, including history.

- **`PRECONDITION_FAILED`:** nothing changed. Run `incoming --jid JID --after ID` with the ID you named, read every listed message, and repeat with `--after` set to the last listed ID while `truncated` is `true`. Do not proceed while any listed message is unavailable. Then decide and retry with the last listed ID, which is the current `latestIncoming.id`. Never retry with `details.latestIncoming.id` alone: it can be an old history message that hides a newer reply.
- **`feedback.latestIncomingChanged: true` on success:** a message arrived during or after the mutation, which the patch did not cover. Follow the same `incoming --after` procedure from the guarded ID and decide whether the chat needs attention. Do not repeat the command.
- **`PROTOCOL` on a guarded command:** the daemon did not confirm the guard. Inspect `request --key` and restart the daemon with the current build.

Pass only an ID you have actually read; copying the current value to make the check pass defeats the guard. Coverage is local; see [the incoming-message guard](chat-state.md#guard-against-new-incoming-messages).

## Inspect unresolved chat state

For archive/read changes, inspect the original request, the exact `chat`, and one bounded `events --after SEQUENCE` page (or `events --tail N [--kind KIND]` for the latest entries, still in ascending order). Report unresolved state rather than repeating mutations or resyncs to obtain a preferred verdict. See [Chat state](chat-state.md) for pending fields and observation rules.

## Protect the session

Keep private state out of reports. Follow [normal shutdown](../operations/runtime.md#shutdown-and-upgrades) before changing builds or copying a directory. Do not delete sessions or bypass locks.

Use [backup and recovery](../operations/backup.md) for completion checks and offline restoration. [Observability](../operations/observability.md) provides optional technical evidence, not proof of task completion or permission to send again.
