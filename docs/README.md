# Documentation

Start with [Getting started](user/getting-started.md) to install and pair whatscli-next, or follow the [Agent quick reference](user/agents.md) for a typical workflow. All command examples use fictional identifiers. Run `node dist/src/cli.js help` for the JSON command reference and available flags.

## Using the CLI

- [Recipient identity](user/identity.md): exact JIDs, phone resolution, and conflicting evidence.
- [History and search](user/history.md): chat filters, pagination, quotes, contact cards, and deletion visibility.
- [Sending and media](user/sending.md): text, files, contact cards, routing, and downloads.
- [Quoted replies](user/quoted-replies.md): exact message selection and supported reply context.
- [Chat state](user/chat-state.md): archive/read mutations and pending observations.
- [Command results and retry rules](user/evidence.md): durable keys, receipts, uncertainty, and failures.
- [JSON output](user/output.md): full/compact formats, defaults, and error codes.

## Running an account

- [Runtime and recovery](operations/runtime.md): connection states, retries, shutdown, and receiving limits.
- [Privacy](operations/privacy.md): trusted paths, permissions, and diagnostics.
- [Backup and recovery](operations/backup.md): SQLite snapshots and offline recovery.
- [Observability](operations/observability.md): opt-in local capture and queries.
- [Builds and upgrades](operations/release.md): build verification, daemon identity, and package checks.

## Contributing

Read [Contributing](../CONTRIBUTING.md) for setup and testing, and [AGENTS.md](../AGENTS.md) for repository instructions.

- [Architecture overview](internals/overview.md): ownership, transport, persistence, and source map.
- [Storage](internals/storage.md): schema, search projections, and upgrades.
- [Message content and observations](internals/message-content.md): contact-card encoding, revocation validation, and activity derivation.
- [Read/unread internals](internals/read-unread.md): SDK observations and pending-state constraints.
- [Observability architecture](internals/observability-architecture.md): append ownership, buffering, and failure handling.
