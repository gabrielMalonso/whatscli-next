# Agent quick reference

Run `node dist/src/cli.js --output compact ...` from the checkout. Commands return JSON on stdout; [JSON output](output.md) defines compact response shapes and defaults. All examples use fictional identifiers.

Select the same account on every command with `--account NAME` (for example, `--account central-ES`), or use `--data-dir PATH` for an explicit session directory. Do not combine the selectors. Omitting both uses the original default session. See [Getting started](getting-started.md) for account names, pairing, and trusted private paths.

## Check the account

```sh
node dist/src/cli.js --output compact status
```

Confirm the account JID with its owner. Network operations require linked credentials and `connection: open`. Check the responding build fingerprint when changing installations; `alreadyRunning: true` does not upgrade the daemon. See [runtime recovery](../operations/runtime.md) for connection problems.

## Select the exact conversation

```sh
node dist/src/cli.js --output compact chats --unread true --archived false --limit 50 --offset 0
node dist/src/cli.js --output compact messages --jid '12025550101@s.whatsapp.net' --limit 20
node dist/src/cli.js --output compact resolve --phone '+12025550101'
node dist/src/cli.js --output compact contact --jid '123450001@lid'
```

Use an exact observed JID or the exact PN JID returned by `resolve` with `data.status: confirmed` and a non-null `data.jid`. Names, LID digits, aliases, and shared contact cards cannot identify or authorize a recipient. Investigate conflicts before sending; see [recipient identity](identity.md).

History is partial. Inspect unread and archived `unknown` states separately from `false`, keep pagination filters fixed, and deduplicate by exact JID as pages change. See [history and search](history.md).

## Send and inspect

Choose a stable key before invoking an intended action:

```sh
node dist/src/cli.js --output compact send \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-message-001' \
  --text 'A fictional example message.'

node dist/src/cli.js --output full request --key 'example-message-001'
```

After an error or timeout, inspect the original key. Never use a new key to retry an uncertain action. Read [command results and retry rules](evidence.md) before interpreting the outcome; command success alone does not establish delivery.

See [sending and media](sending.md) for files, cards, routes, and downloads, and [quoted replies](quoted-replies.md) for exact quote selectors.

## Inspect unresolved chat state

For archive/read changes, inspect the original request, the exact `chat`, and one bounded `events --after SEQUENCE` page. Report unresolved state rather than repeating mutations or resyncs to obtain a preferred verdict. See [Chat state](chat-state.md) for pending fields and observation rules.

## Protect the session

Keep private state out of reports. Follow [normal shutdown](../operations/runtime.md#shutdown-and-upgrades) before changing builds or copying a directory. Do not delete sessions or bypass locks.

Use [backup and recovery](../operations/backup.md) for completion checks and offline restoration. [Observability](../operations/observability.md) provides optional technical evidence, not proof of task completion or permission to send again.
