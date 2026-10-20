# Contributing

whatscli-next is a small WhatsApp CLI for agents. Keep contributions focused on that purpose. Organization policies, contact approval, scheduling, customer records, and downstream integrations belong in consumer repositories.

## Development setup

Requires **Node.js 24.18+ (24.x)** and **pnpm 10.24.0**.

From a checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node dist/src/cli.js help
```

Before changing the runtime, read the [architecture overview](docs/internals/overview.md) and [repository instructions](AGENTS.md). The [roadmap](docs/roadmap.md) documents delivery history and scope boundaries.

## Making a change

Keep each PR focused on one problem. Include the code, relevant regression tests, and documentation needed for the change.

Follow the existing TypeScript conventions and pinned Baileys API. Add abstractions or dependencies only when there is a concrete need.

Preserve these core contracts:

- One runtime and SQLite writer per data directory.
- JSON responses on stdout; diagnostics on stderr.
- Exact recipient identity.
- Durable send intent recorded before invocation.
- No automatic resend of uncertain operations.
- Separate evidence for SDK return, acceptance, delivery, read, and phone confirmation.

In your PR, explain the problem, what changed, which checks you ran, and what remains unverified.

Do not include credentials, databases, logs, pairing images, private messages, or account identifiers in PRs. Use fictional examples and the smallest useful reproduction in bug reports.

## Checks

Run these checks before handing off a change:

```sh
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm verify:build
```

`pnpm test` builds the project before running the offline test suite. Run `verify:build` after the final build/test to catch missing, stale, or unexpected output.

Use `pnpm format` for mechanical formatting, and review formatting changes separately from behavior changes.

The [CI workflow](.github/workflows/ci.yml) runs these checks on pull requests and pushes to `main`. It uses Ubuntu 24.04, Node.js 24.18.0, and the pnpm version specified in `packageManager`. CI runs without an account/session or repository secrets and does not upload artifacts.

### Testing boundaries

Automated tests use fictional fixtures and injected I/O. They must not contact WhatsApp.

Live tests require a separately agreed account and exact conversations. Do not start a second runtime against an active session directory, delete a session, or kill an unfamiliar process to make a test pass.

## Documentation

Write public documentation in English and use working commands with fictional identifiers.

Keep the README short: purpose, installation, key limits, and links. Place documentation according to its audience:

- `docs/user/` — user workflows and command guidance.
- `docs/operations/` — runtime and operational procedures.
- `docs/internals/` — implementation details, design notes, and historical evidence.

Add new guides to the [documentation index](docs/README.md).

State uncertainty clearly and distinguish historical validation from current guarantees. If files move, update links and the package file allowlist. Include new guides in the formatting scripts.

## Agent-assisted feature work

The feature delivery process in [AGENTS.md](AGENTS.md#feature-delivery-and-independent-review) requires at least two fresh, independent review rounds.

Each review must cover the committed HEAD, remain read-only, and make no live WhatsApp calls. Fix valid blocking findings and request a fresh review after implementation changes.

Feature workers must not merge or enable auto-merge. The coordinator decides when the broader goals have been met.

## License

The project uses the [MIT license](LICENSE).
