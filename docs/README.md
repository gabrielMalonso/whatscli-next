# Documentation

Start with [Getting started](user/getting-started.md) to install and pair whatscli-next.

Building an agent integration? Read the [Agent quick reference](user/agents.md) and [JSON output](user/output.md).

## Using whatscli-next

Guides for developers using the CLI directly or through an agent.

- [Getting started](user/getting-started.md) — installation, pairing, and data directories.
- [Agent quick reference](user/agents.md) — inspect conversations, send once, and handle uncertain outcomes.
- [Command guide](user/commands.md) — recipient identity, local history, sends, downloads, and chat state.
- [Quoted replies](user/quoted-replies.md) — select a stored message and preserve reply context.
- [JSON output](user/output.md) — full and compact responses, error codes, and token measurements.

Run `node dist/src/cli.js help` for the JSON command reference and available flags.

## Running an account

Guides for developers managing a connection, local data, or a deployment.

- [Runtime and recovery](operations/runtime.md) — connection states, retries, reconnecting, and shutdown.
- [Privacy](operations/privacy.md) — trusted paths, file permissions, and diagnostic boundaries.
- [Backup and recovery](operations/backup.md) — SQLite snapshots and recovery into a new directory.
- [Observability](operations/observability.md) — opt-in local capture and bounded queries.
- [Fixed-version installation and upgrades](operations/release.md) — verified builds, package inspection, and daemon identity.
- [Supervised pilot runbook](operations/pilot.md) — procedures for a separately approved live-account test.

## Working on the project

Resources for contributors and developers working on the implementation.

Start with [Contributing](../CONTRIBUTING.md) for development guidelines and the [architecture overview](internals/overview.md) for runtime design. Coding agents should also read [AGENTS.md](../AGENTS.md).

### Implementation and performance

- [Storage](internals/storage.md) — schema, search projections, and offline benchmarks.
- [CLI performance](internals/cli-performance.md) — startup and RPC measurements.
- [Observability architecture](internals/observability-architecture.md) — capture design and comparison evidence.

### Investigations and validation

- [Read/unread investigation](internals/read-unread.md) — SDK state semantics and a finite validation procedure.
- [Reliability audit](internals/reliability.md) — offline fault-injection findings.
- [Validation report](internals/validation.md) — historical live checkpoints and their limits.

### Project history and scope

- [Roadmap](roadmap.md) — delivery history, acceptance boundaries, and deferred capabilities.

Historical benchmark JSON files are stored alongside their internal reports. Results reflect the recorded source and environment, not current performance guarantees.
