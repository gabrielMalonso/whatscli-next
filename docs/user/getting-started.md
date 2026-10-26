# Getting started

whatscli-next runs one WhatsApp account per data directory. A background daemon maintains the connection, and CLI commands return JSON.

## Install from source

Requires Git, **Node.js 24.18+ (24.x)**, and **pnpm 10.24.0**.

Linux has been tested. macOS uses the same Unix socket design but remains unverified. There is no documented native Windows workflow.

```sh
git clone https://github.com/gabrielMalonso/whatscli-next.git
cd whatscli-next
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm verify:build
node dist/src/cli.js help
```

Baileys is pinned to `7.0.0-rc14`, including its bundled protocol version. Keep the lockfile unchanged and leave installation scripts disabled. The package is not published to npm.

`help` returns the JSON command reference. You can also run `pnpm -s whatscli ...`, but use `node dist/src/cli.js ...` when another program consumes stdout.

See [builds and upgrades](../operations/release.md) for build verification and installation updates. `pnpm verify:build` checks emitted files against the current source and compiler, not Git provenance or dependency authenticity.

## Choose a data directory

Default locations:

| Platform | Directory                                                          |
| -------- | ------------------------------------------------------------------ |
| Linux    | `$XDG_STATE_HOME/whatscli-next`, or `~/.local/state/whatscli-next` |
| macOS    | `~/Library/Application Support/whatscli-next`                      |

To select a named account, pass `--account NAME` on **every command**, starting with pairing:

```sh
node dist/src/cli.js --account example start
node dist/src/cli.js --account example status
node dist/src/cli.js --account example pair qr
node dist/src/cli.js --account example chats --limit 20
node dist/src/cli.js --account example stop
```

Each name selects a separate directory under `accounts/` inside the default location above. Names are normalized to lowercase: `Example` and `example` select the same account on both platforms. Use 1–32 ASCII letters, digits, hyphens, or underscores, starting with a letter or digit. Spaces, dots, and path separators are rejected.

Each directory has its own credentials, history, request keys, and daemon. The name is a local selector; confirm the actual WhatsApp account JID with its owner after pairing. Naming an account does not move or relabel an existing session.

For an explicit directory, pass `--data-dir /absolute/private/path` on every command. Do not combine it with `--account` or repeat either selector. Omitting both uses the default session; it does not select the last account used. The remaining examples below use that default.

The path must meet these requirements:

- Use a canonical path without symlinks.
- Path ancestors must be trusted, owned by your user or root, and not writable by group or others.
- The final directory must belong to your user and have private permissions (0700).
- Root-owned sticky temporary directories are allowed.
- The complete socket path must fit within 100 bytes.

A private directory does not make unsafe ancestors acceptable. See [Privacy](../operations/privacy.md) if a path is rejected.

Credentials, messages, QR images, logs, and backups are private and **not encrypted at rest**. Keep them out of Git and public issue reports.

## Pair your account

Start the daemon and check its status:

```sh
node dist/src/cli.js start
node dist/src/cli.js status
```

`start` returns when the local control socket is ready. WhatsApp connects asynchronously.

When `status.data.qrAvailable` becomes `true`, request the QR image:

```sh
node dist/src/cli.js pair qr
```

The response contains a private local PNG path. Show the image to the account owner, who can scan it under **WhatsApp → Linked devices → Link a device**.

Request another image if the QR code expires. QR pairing does not require a phone number.

Alternatively, request a pairing code:

```sh
node dist/src/cli.js pair code --phone 12025550100
```

Replace the fictional number with the account owner's international phone number. Enter the returned code through WhatsApp's link-with-phone-number flow.

Keep QR images and pairing codes private.

After pairing, check `hasLinkedCredentials`, `connection: open`, and the returned account JID. Confirm the account with its owner. The SDK's raw `registered` flag is not a reliable pairing verdict.

## Read your first local results

```sh
node dist/src/cli.js chats --limit 20
node dist/src/cli.js --output compact status
```

Local history is always partial. An empty chat list does not mean the account has no conversations.

Before sending, read the [agent quick reference](agents.md) for exact recipient identities and stable request keys.

## Stop and restart

```sh
node dist/src/cli.js stop
node dist/src/cli.js start
```

Stopping preserves the session.

Wait for shutdown to succeed and the recorded daemon PID to exit before starting a new build. A timeout does not kill the daemon. Inspect `status` and allow cleanup to finish.

`start` does not upgrade a running process. If it returns `alreadyRunning: true`, the response identifies the process already using that data directory.

Compare `status.data.build.fingerprint` with the fingerprint printed by the intended build:

- A matching fingerprint matches the intended build’s emitted first-party JavaScript, not its source commit or dependencies.
- A null fingerprint indicates unstamped code.
- An absent field indicates a legacy daemon.

Neither a null nor an absent fingerprint identifies the current checkout. See [upgrades and build identity](../operations/release.md#identify-startup-and-upgrade-without-losing-the-session).

For local inspection without contacting WhatsApp, use `start --offline`.

Changing network mode or `--allow-jid EXACT_JID` requires a normal stop before restarting. The allowlist restricts operations to one exact JID; it does not grant permission to send.

Continue with the [documentation index](../README.md) for command workflows or [runtime and recovery](../operations/runtime.md) for connection issues.
