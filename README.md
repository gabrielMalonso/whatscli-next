# whatscli-next

A small WhatsApp CLI for agents. Read locally stored conversations, send messages and files, and manage chat state with JSON commands.

Built with TypeScript, SQLite, and [Baileys](https://github.com/WhiskeySockets/Baileys). A background process manages the connection, and CLI clients communicate with it over a private Unix socket.

## Get started

Requires **Node.js 24.18+ (24.x)** and **pnpm 10.24.0**.

Install from source:

```sh
git clone https://github.com/gabrielMalonso/whatscli-next.git
cd whatscli-next
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm verify:build
node dist/src/cli.js help
```

Follow [Getting started](docs/user/getting-started.md) to pair your account.

Use `--account pessoal` or `--account central-ES` on every command to keep named accounts in separate private directories. Without a selector, commands use the original default session; `--data-dir PATH` selects an explicit directory.

Linux has been tested; macOS has not been verified. No npm package is published.

## What it does

- List and search locally stored chats and messages.
- Resolve international phone numbers and inspect contact identity evidence.
- Send text, quoted replies, documents, and individual contact cards.
- Download media and request changes to archive and read state.
- Record send intents before sending, using durable keys to prevent repeated attempts.
- Check local status, diagnose recovery issues, and back up private SQLite data.

Each command writes one JSON response to stdout. Diagnostics go to stderr. Use Node directly when another program needs to consume the output.

Message history is partial. A successful command does not confirm delivery, and uncertain sends are never retried automatically. Credentials and messages are **not encrypted at rest**. Keep the data directory and backups private.

## Documentation

Browse the [documentation index](docs/README.md) or start with:

- [Getting started](docs/user/getting-started.md) — installation, pairing, and data directories.
- [Agent quick reference](docs/user/agents.md) — common workflows and safe retry rules.
- [History and search](docs/user/history.md) — chat filters, pagination, and message visibility.
- [JSON output](docs/user/output.md) — response formats, errors, and compact output.
- [Runtime and recovery](docs/operations/runtime.md) — disconnections, shutdown, and receiving limits.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, checks, and project scope. For implementation details, read the [architecture overview](docs/internals/overview.md).

## License

[MIT](LICENSE).
