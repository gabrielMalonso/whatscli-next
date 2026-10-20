# Documentation

Start with [Getting started](user/getting-started.md) to install and pair whatscli-next. For agent integrations, read the [Agent quick reference](user/agents.md) and [JSON output contract](user/output.md).

## Using the CLI

- [Getting started](user/getting-started.md): installation, pairing, and data directories.
- [Agent quick reference](user/agents.md): common workflows and safe retry rules.
- [Command guide](user/commands.md): identity, history, sends, downloads, and chat state.
- [Quoted replies](user/quoted-replies.md): selecting a stored message and preserving reply context.
- [JSON output](user/output.md): full/compact formats, field defaults, and errors.

Run `node dist/src/cli.js help` for the JSON command reference and available flags.

## Running an account

- [Runtime and recovery](operations/runtime.md): connection states, retries, shutdown, and receiving limits.
- [Privacy](operations/privacy.md): trusted paths, permissions, and diagnostics.
- [Backup and recovery](operations/backup.md): SQLite snapshots and offline recovery.
- [Observability](operations/observability.md): opt-in local capture and queries.
- [Builds and upgrades](operations/release.md): verified output, daemon identity, and package checks.

## Contributing

Read [Contributing](../CONTRIBUTING.md) for setup and testing, and [AGENTS.md](../AGENTS.md) for repository instructions.

- [Architecture overview](internals/overview.md): ownership, transport, persistence, and source map.
- [Storage](internals/storage.md): schema, search projections, and upgrades.
- [Read/unread internals](internals/read-unread.md): SDK observations and pending-state constraints.
- [Observability architecture](internals/observability-architecture.md): append ownership, buffering, and failure handling.
