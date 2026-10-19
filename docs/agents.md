# Agent quick reference

Run `node dist/src/cli.js ...` from the project directory. Each invocation writes one JSON response to stdout. Use the same `--data-dir PATH` on every command when selecting a session. All identifiers below are fictional.

## Session

```sh
node dist/src/cli.js start
node dist/src/cli.js status
node dist/src/cli.js pair qr
```

Ask the owner to scan the returned private PNG. Poll `status` until `connection` is `open`, and verify the account JID with the owner. Pairing images/codes are sensitive. Restarting with the same directory preserves the session; `stop` does not log out. For an existing linked session, no new pairing is normally needed.

## Identify and inspect

```sh
node dist/src/cli.js chats --limit 50 --offset 0
node dist/src/cli.js chat --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js messages --jid '12025550101@s.whatsapp.net' --limit 20
node dist/src/cli.js search --query 'example' --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js resolve --phone '+12025550101'
node dist/src/cli.js contact --jid '123450001@lid'
```

Use an exact observed JID or the exact PN JID from a successful resolution, verified with the owner before real test operations. Never send to a display name or derive a telephone number from a LID. PN (`@s.whatsapp.net`), LID (`@lid`), and group (`@g.us`) identities remain distinct. Use `group --jid EXACT_GROUP_JID` to inspect a group's current metadata.

`resolve` requires an open connection and an explicit `+` international number (8–15 digits, no punctuation). Proceed only when `data.status` is `confirmed` and `data.jid` is non-null. Missing/partial results remain unknown; `ok: true` alone is insufficient. The check is persisted for exact PN first contact, without creating a conversation or verifying an unobserved LID alias. A later inconclusive/negative check supersedes it. Verification is historical evidence, with no automatic expiry or guarantee of continued phone ownership.

`contact` works offline and returns historical local metadata and association evidence with source/time. A LID without a unique association returns `phone: null`; `mapping.status: conflict` retains contradictory evidence instead of selecting a phone. Conflicting associations block first contact. A known mapping never rewrites a request, history or receipt, nor bypasses `--allow-jid`. Legacy SDK mapping and alternate message-key observation times may be null. Contact names are metadata, never addressing instructions.

Results describe locally stored data. `coverage: partial` applies even when a search returns no matches or history synchronization reports completion. Lists are limited to 100 results; page using `--offset`. Events use `events --after SEQUENCE` and return the next 100 entries.

## Send once

Choose a stable, unique key for the intended action before invoking a send:

```sh
node dist/src/cli.js send \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-message-001' \
  --text 'A fictional example message.'

node dist/src/cli.js request --key 'example-message-001'
```

Reusing the same key and arguments returns its stored result without another resolution/send, even offline or after identity evidence changes. Conflicting arguments (including PN/LID substitution) fail. A new key authorizes another operation, so do not create one merely because a command failed or timed out. Query the original key first. `data: null` from `request` means no intent has yet been recorded; a transport timeout does not cancel an in-flight command.

Interpret a request record using separate evidence fields:

| Field | Meaning |
| --- | --- |
| `attempt: uncertain` | Intent was persisted; the network outcome is unknown. It will not be resubmitted automatically. |
| `attempt: sdk-returned` | Baileys returned the expected message. This alone does not establish acceptance or delivery. |
| `acceptance: server-ack` | A matching SDK server acknowledgment was observed. |
| `delivery: delivered` | A matching SDK delivery status was observed. |
| `read: read` | A matching SDK read status was observed. |
| `errorObserved: true` | An invocation error or SDK error status was observed. This does not establish nondelivery. |

Missing receipt evidence remains `unknown`. Group participant receipts are separate events and cannot establish every participant's outcome. Phone confirmation is independent evidence; it does not rewrite SDK-derived receipt fields.

## Files and chat state

```sh
node dist/src/cli.js send-file \
  --jid '12025550101@s.whatsapp.net' --key 'example-file-001' \
  --file ./example.txt --mime text/plain --caption 'Fictional attachment'

node dist/src/cli.js download \
  --jid '12025550101@s.whatsapp.net' --id 'EXAMPLE_MESSAGE_ID' \
  --out ./example-download.txt

node dist/src/cli.js archive --jid '12025550101@s.whatsapp.net' --key 'example-archive-001'
node dist/src/cli.js unarchive --jid '12025550101@s.whatsapp.net' --key 'example-unarchive-001'
node dist/src/cli.js read --jid '12025550101@s.whatsapp.net' --key 'example-read-001'
node dist/src/cli.js unread --jid '12025550101@s.whatsapp.net' --key 'example-unread-001'
```

Files are documents, limited to 64 MiB. A file key preserves its original manifest even if that path later changes. Downloads never overwrite existing files; failures preserve a private partial file. Use `--from-me true|false` and `--participant EXACT_JID` if a media ID is ambiguous.

Archive/read require an independently observed conversation and a stored last-message key/timestamp. Phone verification or an SDK send return alone does not meet that requirement.

After a chat mutation, the affected observed field becomes `null` with a pending intent until a corresponding SDK observation arrives. A returned call is insufficient to claim success. In validation, compare the owner's phone with later `chat` and `events` results. An unread update can be an increment, so positive exact totals remain unknown.

## Recovery

`reconnect` requests a new connection; transient disconnects normally recover automatically. `resync` asks Baileys to synchronize app state, but can return despite failed collections. Inspect `status.issues` and later events. Historical issues do not disappear simply because the connection reopens.

Preserve the private data directory when diagnosing a failure. Never remove credentials or recreate the session as an automatic recovery step. Keep daemon logs, databases, QR images, backups, and message data private. See [the README](../README.md) for installation, storage permissions, and the full command reference.
