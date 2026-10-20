# Agent quick reference

Run commands from the project checkout with `node dist/src/cli.js --output compact ...`.

Each command returns one JSON object on stdout. Full output is the default. Compact output preserves complete text and evidence, though some commands use a different response shape. See [JSON output](output.md).

For a custom session, include the same `--data-dir PATH` on every command. Use a trusted private directory as described in [Getting started](getting-started.md).

All identifiers below are fictional.

## Check the account

```sh
node dist/src/cli.js --output compact status
```

Verify the account JID with its owner.

Before a network operation, require linked credentials and `connection: open`. Compare `status.data.build.fingerprint` with the intended build. Starting an already-running daemon does not upgrade it.

See [Runtime and recovery](../operations/runtime.md) for disconnected accounts.

## Find the exact recipient

```sh
node dist/src/cli.js --output compact chats --unread true --archived false --limit 50 --offset 0
node dist/src/cli.js --output compact chat --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 20
node dist/src/cli.js --output compact resolve --phone '+12025550101'
node dist/src/cli.js --output compact contact --jid '123450001@lid'
```

Use either:

- An exact, observed conversation JID.
- An exact PN JID returned by `resolve` with `data.status: confirmed` and a non-null `data.jid`.

Names are metadata, not recipient identities. Never derive a phone number from a LID or treat PN/LID aliases as interchangeable.

Investigate conflicting or unknown identities before sending. See [Recipients and contact identity](identity.md).

### Handle partial history

Local history is incomplete. An empty result does not prove the remote queue is empty.

When listing chats:

- Inspect `unknown` unread and archived states separately. Neither is equivalent to `false`.
- Keep filters fixed while paginating with offsets.
- Deduplicate results by exact JID.
- Account for changes between pages.

See [Local history and search](history.md).

## Send once

Choose a stable key for the intended action before sending:

```sh
node dist/src/cli.js --output compact send \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-message-001' \
  --text 'A fictional example message.'

node dist/src/cli.js --output full request --key 'example-message-001'
```

A key identifies one immutable operation.

Replaying the same key with identical arguments returns the original record without another lookup or send, even offline or after a restart. Changed arguments fail.

For file operations, the key retains the original byte manifest even if the contents at that path change.

### Handle timeouts and errors

After a timeout or error, inspect the original request key.

- A new key creates a new operation. It is not a safe retry.
- A timeout does not cancel an in-flight command.
- `request` returning null means no intent has been recorded yet. It does not establish that the operation cannot still proceed.
- Fix storage failures before making further mutations.
- Uncertain sends are never retried automatically.

See [Sending messages and media](sending.md) for documents, contact cards, and downloads. For replies to stored messages, see [Quoted replies](quoted-replies.md).

Phone numbers in shared contact cards do not verify a recipient or grant permission to send.

## Read the evidence

| Result                   | What it establishes                                |
| ------------------------ | -------------------------------------------------- |
| `ok: true`               | The command was processed.                         |
| `attempt: sdk-returned`  | Baileys returned the expected message.             |
| `attempt: uncertain`     | The intent exists; completion is unknown.          |
| `acceptance: server-ack` | A matching SDK server acknowledgment was observed. |
| `delivery: delivered`    | A matching SDK delivery status was observed.       |
| `read: read`             | A matching SDK read status was observed.           |

Missing receipts remain unknown.

Group participant receipts are separate events. One participant's receipt does not establish the outcome for everyone. Confirmation from the phone remains independent evidence.

See [Understanding command results](evidence.md).

### Archive and read state

Archive/read mutations leave affected fields null and pending until a corresponding observation arrives. A field can remain pending even if the phone's state has changed.

To investigate:

1. Inspect the original request.
2. Inspect the exact chat.
3. Read a bounded page of events.
4. Report any unresolved state.

Do not repeat mutations or resync merely to obtain a preferred verdict.

See [Archive and read state](chat-state.md).

## Preserve the session

Keep credentials, databases, messages, logs, QR images, and backups private.

Do not delete sessions or bypass locks to recover from errors. Stop normally and confirm the recorded PID has exited before changing builds or copying the entire directory.

[SQLite backups](../operations/backup.md) use a new destination and exclude logs, QR images, locks, and external files.

A backup timeout may leave work running. Inspect the completion manifest before proceeding.

Recovery into a new directory preserves uncertainty. It does not authorize resending or opening a second live connection.

[Local observability](../operations/observability.md) is optional and disabled by default. It captures technical metadata without additional consumer logging calls.

Capture completeness remains unknown. Logs cannot prove that a downstream task finished or authorize another send.
