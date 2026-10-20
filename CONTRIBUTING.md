# Contributing

Keep contributions focused on a small, single-account WhatsApp CLI for agents. Organization policies, approved-contact lists, scheduling, customer records, and downstream integrations belong in consumer repositories.

## Setup and checks

Use **Node.js 24.18+ (24.x)** and **pnpm 10.24.0**:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node dist/src/cli.js help
```

Read the [architecture overview](docs/internals/overview.md) and [repository instructions](AGENTS.md) before changing runtime behavior.

Before submitting a change, run:

```sh
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm verify:build
```

`pnpm test` builds the project before running the offline suite. Run `verify:build` after the final build/test to detect missing, stale, or unexpected output. Use `pnpm format` for mechanical formatting, and review those changes separately from behavior changes.

The [CI workflow](.github/workflows/ci.yml) runs these checks without an account or secrets.

## Making a change

Keep each PR focused on one problem, with relevant regression tests and usage documentation. Follow existing TypeScript conventions and the pinned Baileys API. Add abstractions or dependencies only when needed.

Preserve the core contracts:

- One writer per data directory.
- Exact recipient identity.
- Durable send intent before invocation.
- No automatic resend of uncertain operations.
- Separate evidence for SDK return, acceptance, delivery, read, and phone confirmation.
- JSON responses on stdout and diagnostics on stderr.

Explain the problem, resulting behavior, checks run, and anything left unverified. Follow the [independent review process](AGENTS.md#feature-delivery-and-independent-review). Do not merge or enable auto-merge without permission.

## Testing and privacy

Automated tests use fictional fixtures and injected I/O. They must never contact WhatsApp. Test behavior and failure boundaries rather than duplicating implementation details.

Live testing requires a separately agreed account and exact conversations. Offline checks do not establish phone effects or complete remote history.

Never include credentials, databases, logs, pairing images, private messages, or account identifiers in commits or bug reports. Do not start a second runtime against active state, delete sessions, or kill unfamiliar processes to make tests pass.

## Documentation

Write in English, using working commands and fictional identifiers. Keep the README short and make guides discoverable through the [documentation index](docs/README.md).

- `docs/user/`: workflows, commands, and output contracts.
- `docs/operations/`: runtime, privacy, backup, and deployment procedures.
- `docs/internals/`: current architecture and implementation constraints.

Document what helps someone use or change the project. Leave local measurements, test-session reports, and development history out of guides. State limitations without presenting individual test results as guarantees.

Update links and package inclusion when files move.

Contributions use the project's [MIT license](LICENSE).
