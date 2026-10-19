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

- Run `pnpm install --frozen-lockfile --ignore-scripts` when dependencies are missing, `pnpm test` for meaningful behavior checks, and `pnpm check` for types.
- Automated tests must use fictional fixtures and injected I/O. They must not depend on real WhatsApp.
- Live tests require an explicitly agreed account and exact conversation. Do not send to other contacts or operate a downstream production account without that agreement.
- Do not copy credentials, private databases, messages, logs or pairing images into worktrees or commits. `.private/`, `.tmp/`, `node_modules/` and `dist/` remain local and ignored.
- Never connect a second runtime to an active session directory. Preserve unfamiliar files and work; do not kill processes or delete sessions as recovery shortcuts.
- A live account/session already used by another task is not an offline test fixture. Default to offline verification; coordinate live work with the coordinator.

## Feature delivery and independent review

The user has authorized feature implementation and independent review by agents for this project.

1. Work on one scoped feature in its T3-bound worktree. Read `docs/roadmap.md`, the feature brief, and the current implementation. Preserve existing behavior and scope.
2. Implement the feature, meaningful regression tests and generic usage documentation. Commit and push the branch; open a PR against this repository's `main`, and register it with `link_pull_request`.
3. Request a fresh independent review using a new `delegate_task` for each round. Reviewers inspect the current committed HEAD and must not edit files or make live WhatsApp calls.
4. Each review prompt must contain the original brief, base/head SHAs, the current diff scope, prior findings, fixes, unresolved objections and relevant test evidence. Do not reuse the same reviewer's context as a new independent round.
5. Assess findings, fix valid defects, document reasons for rejecting findings, run the relevant checks, commit and push. Then request another fresh review.
6. Perform at least two independent review rounds. Continue until the latest review covers the current HEAD and no valid blocking findings remain. Any later implementation change requires a new review. Keep nonblocking limitations explicit.
7. Report the PR URL, exact HEAD, test results, review task IDs, resolved/unresolved findings and live-test limits to the coordinator. Use the coordinator thread supplied in the task brief for the completion callback.
8. Feature workers and reviewers must not merge or enable auto-merge. The coordinator checks the broader goals before merge. After a merge, the coordinator checks out `main` and pulls before starting the next feature.

Keep review proportional to actual correctness and regression risk. Do not add unrelated cleanup, dependencies, CI changes or new architectural machinery to satisfy speculative findings.
