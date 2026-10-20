# Command guide

Run commands from the project checkout with `node dist/src/cli.js`. Each command returns one JSON object on stdout.

To see available commands and flags:

```sh
node dist/src/cli.js help
```

All examples use fictional identifiers. For a custom session, include the same `--data-dir PATH` on every command.

See [Getting started](getting-started.md) for installation and pairing.

## Find a conversation

Start with [Recipients and contact identity](identity.md) to select an exact observed JID or resolve an international phone number.

Display names and LID digits cannot identify a telephone recipient.

[Local history and search](history.md) covers chat filters, activity order, pagination, quotes, shared contact cards, and deletion visibility.

Local results always have partial coverage.

## Send and download

[Sending messages and media](sending.md) covers text, documents, contact cards, durable request keys, send routes, and media downloads.

For replies to stored messages, [Quoted replies](quoted-replies.md) explains the exact message selectors.

Choose a stable key before sending. If a command times out, the attempt may still be running. Inspect the original key:

`request --key KEY`

Never create a new key just to retry an uncertain send.

## Change chat state

[Archive and read state](chat-state.md) covers `archive`, `unarchive`, `read`, and `unread`, including pending fields and observation limits.

Reading stored message history does not mark a conversation as read.

## Interpret the result

[Understanding command results](evidence.md) distinguishes command success, SDK return, acceptance, delivery, and read evidence.

[JSON output](output.md) covers full and compact response shapes, stable error codes, and compact field defaults.

## Operate the account

[Runtime and recovery](../operations/runtime.md) covers `status`, `events`, `reconnect`, `resync`, and shutdown.

For data protection and diagnostics, see [Backup and recovery](../operations/backup.md) and [optional local observability](../operations/observability.md).
