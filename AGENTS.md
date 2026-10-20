# Working on whatscli-next

## Scope and invariants

- Keep this a small, generic WhatsApp CLI for agents. Organization rules, approved-contact lists, scheduling, customer records and downstream integrations belong in their own repositories.
- Use the pinned Baileys API. Do not introduce another SDK abstraction, plugin framework, elaborate drafts system or multiple-account orchestration.
- One account per data directory. Only the runtime owns the WhatsApp connection and writes SQLite; CLI clients use the private Unix socket.
- JSON goes to stdout; diagnostics go to stderr. Preserve the distinction between local, partial, unknown and independently observed state.
- Never derive a telephone number from a LID or address a recipient by display name. Keep identity provenance and ambiguity explicit.
- Persist an immutable send intent and message ID before invocation. Preserve idempotency across crashes, concurrent calls and restart. Never automatically resend an uncertain intent.
- SDK return, acceptance, delivery, read and a person's phone confirmation are separate evidence. Do not advance observed chat state optimistically.
- Never expose raw SDK messages, credential objects or embedded cryptographic material in public projections or diagnostics.

## Verification and private state

- Run `pnpm install --frozen-lockfile --ignore-scripts` when dependencies are missing, `pnpm lint` and `pnpm format:check` for code quality, `pnpm check` for types, and `pnpm test` for meaningful behavior checks. Run `pnpm verify:build` after the final build/test. Use `pnpm format` for mechanical formatting; keep formatting separate from behavioral changes.
- Automated tests must use fictional fixtures and injected I/O. They must not depend on real WhatsApp.
- Live tests require an explicitly agreed account and exact conversation. Do not send to other contacts or operate a downstream production account without that agreement.
- Keep credentials, private databases, messages, logs, and pairing images out of source directories and commits. `.private/`, `.tmp/`, `node_modules/`, and `dist/` remain local and ignored.
- Never connect a second runtime to an active session directory. Preserve unfamiliar files and work; do not kill processes or delete sessions as recovery shortcuts.
- A live account/session already used by another task is not an offline test fixture. Default to offline verification.

## Contributions

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and contribution guidelines. Keep changes focused, report what you verified, and do not merge or enable auto-merge without permission.
