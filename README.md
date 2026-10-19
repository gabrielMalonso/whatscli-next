# whatscli-next

A small, JSON-only WhatsApp CLI for agents. TypeScript, pnpm, SQLite, and a single Baileys connection. No browser, interactive menus, or manual chat interface. MIT licensed.

The [real-account feasibility validation](docs/validation.md) passed for pairing, restart, text exchange, idempotency, archive/read operations, phone-originated changes, and automatic reconnect. The CLI preserves the observed limits: partial local history, uncertain sends, and chat fields that can lag behind the phone.

## Install

Requires **Node.js 24.18+ (24.x)** and **pnpm 10.24.0**. Linux was tested; macOS uses the same Unix socket design but has not been run on a Mac.

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli.js help
```

`help` returns a JSON command reference. You can also run `pnpm -s whatscli ...`. Use Node directly when another program must consume stdout without package-manager output.

Baileys is pinned to `7.0.0-rc14`, including its bundled protocol version. `pnpm-lock.yaml` fixes the dependency graph and integrity hashes. Installation scripts for Baileys (a Node version check) and protobufjs are disabled; the published code is used directly.

## Start and pair

```sh
node dist/src/cli.js start
node dist/src/cli.js status
node dist/src/cli.js pair qr
```

`start` launches the background daemon and returns when its local socket is ready. WhatsApp connects asynchronously. Wait until `status.data.qrAvailable` is true before requesting a QR. `pair qr` returns a private local PNG path; the agent can show that image to the account owner, who scans it under WhatsApp → Linked devices → Link a device. Request another image if it expires. No phone number is needed.

Alternatively:

```sh
node dist/src/cli.js pair code --phone 12025550100
```

The number is fictional. Enter the returned code in WhatsApp's link-with-phone-number flow. QR images and pairing codes are sensitive and must not be published. No QR payload or credential objects are printed in ordinary responses.

Check `hasLinkedCredentials`, `connection: open`, and the returned account JID. The SDK's raw `registered` flag can remain false after valid Web pairing. Stop/restart retains the session:

```sh
node dist/src/cli.js stop
node dist/src/cli.js start
```

One data directory holds one account. Default locations:

- Linux: `$XDG_STATE_HOME/whatscli-next`, or `~/.local/state/whatscli-next`.
- macOS: `~/Library/Application Support/whatscli-next`.

Use the same `--data-dir PATH` on **every** command when selecting another directory:

```sh
node dist/src/cli.js --data-dir .private/session start
node dist/src/cli.js --data-dir .private/session status
```

For a restricted test session, start with `--allow-jid EXACT_JID`. An existing daemon keeps its configuration; stop it before changing options. `start --offline` serves stored data without contacting WhatsApp, for local checks.

## Agent commands

All examples below use fictional identifiers. Find the exact JID in stored conversations; sending and chat mutations require an already observed conversation. Display names are not recipients. PN, LID, and group JIDs remain distinct; a LID is never interpreted as a telephone number.

```sh
node dist/src/cli.js chats --limit 50 --offset 0
node dist/src/cli.js chat --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js messages --jid '12025550101@s.whatsapp.net' --limit 20 --offset 0
node dist/src/cli.js search --query 'example text' --jid '12025550101@s.whatsapp.net'
node dist/src/cli.js group --jid '120363000000000001@g.us'
```

Search examines stored text/captions, not SDK key material. It matches literal substrings with Unicode case normalization; `%` and `_` are literal. Omit `--jid` to search all locally stored conversations. Lists return up to 100 items per request; use `--offset` for the next page. History coverage is always partial.

Send text or a local file:

```sh
node dist/src/cli.js send \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-message-001' \
  --text 'A fictional example message.'

node dist/src/cli.js send-file \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-file-001' \
  --file ./example.txt \
  --mime text/plain \
  --caption 'Fictional attachment'
```

Files are sent as WhatsApp documents, with their filename preserved. The default MIME type is `application/octet-stream`. The initial size limit is 64 MiB. The daemon reads one byte snapshot, persists its size/SHA-256/arguments and generated message ID, then invokes Baileys using those exact bytes.

A key binds one immutable operation. Reusing it returns the recorded result, including uncertainty, without another send. Changed arguments are rejected. Reusing a file key returns its original manifest even if that path's contents have since changed. To inspect an uncertain result:

```sh
node dist/src/cli.js request --key 'example-message-001'
```

Do not substitute a new key just because a request timed out. An intentional new message needs a new key. The program never automatically resubmits uncertain intents, including after restart.

Download a stored media message:

```sh
node dist/src/cli.js download \
  --jid '12025550101@s.whatsapp.net' \
  --id 'EXAMPLE_MESSAGE_ID' \
  --out ./example-download.pdf
```

Use `--from-me true|false` and `--participant EXACT_JID` if the message ID is ambiguous. The daemon calls Baileys for decryption/download, writes a private output file, and returns its byte count and SHA-256. Existing output is never overwritten. Media is limited to 64 MiB; failed downloads report and preserve any partial file. Expired/unavailable media may require the SDK's reupload request or may remain unavailable.

Change chat state:

```sh
node dist/src/cli.js archive   --jid '12025550101@s.whatsapp.net' --key 'example-archive-001'
node dist/src/cli.js unarchive --jid '12025550101@s.whatsapp.net' --key 'example-unarchive-001'
node dist/src/cli.js read      --jid '12025550101@s.whatsapp.net' --key 'example-read-001'
node dist/src/cli.js unread    --jid '12025550101@s.whatsapp.net' --key 'example-unread-001'
```

These use `chatModify` and a stored last-message key/timestamp. Marking a conversation read does not separately send message read receipts. The affected public field becomes `null` with a `pending` intent until a corresponding fresh SDK observation arrives. Unrelated changes do not make an old read counter current. A positive SDK unread update establishes `unread: true`, but its exact total is unknown and returned as `unreadCount: null`; the SDK can send increments rather than absolute totals.

Diagnostics and event inspection:

```sh
node dist/src/cli.js events --after 0
node dist/src/cli.js reconnect
node dist/src/cli.js resync
```

Events are paginated by sequence (100 per request). `reconnect` explicitly reconnects. The diagnostic `drop-connection` command closes only this daemon's WebSocket and lets its normal reconnect handler recover. `resync` returning successfully does not prove complete app state: the SDK can log and skip failed collections.

## JSON and evidence

Every command returns one JSON object on stdout; errors return `ok: false` and a nonzero exit code. SDK diagnostics go to the daemon's private `daemon.log` through stderr. Responses include connection state and `source: local`, `coverage: partial`, and `appState: unknown`.

- `ok` means the command was processed. It is not a delivery verdict.
- `attempt: sdk-returned` means Baileys returned. `uncertain` means completion is unknown. Intent is durable before invocation.
- `acceptance`, `delivery`, and `read` advance only on matching SDK status evidence; missing evidence remains `unknown`.
- Group participant receipts remain separate event evidence. One participant's receipt is not proof that every participant received/read the message.
- PN/LID alias mappings are retained as evidence; this initial CLI does not merge identities or correlate receipts across aliases.
- Chat snapshots are local observations, with unknown/pending fields when appropriate. The real test found read-state changes that reached the phone without promptly updating the client.
- Message output contains text, keys/identifiers, content type and safe media metadata. Raw SDK objects, sender-key distributions, and message secrets stay in private storage.

A transport timeout does not cancel an in-flight WhatsApp attempt. Query its key afterward. The SDK's outgoing retry-content cache is disabled and outgoing content is withheld from its retry callback, so it cannot silently re-relay an uncertain message through that path. This reduces recovery from recipient decryption failures; delivery can remain unknown. Incoming decryption retry requests remain enabled.

## Storage and execution

```text
agent → CLI → private Unix socket → daemon → Baileys
                                      ↓
                                    SQLite
```

Only the daemon owns the WhatsApp connection and writes SQLite. The retained JSONL probe uses the same runtime and must not run against an active daemon's directory. A lifetime SQLite lock enforces one writer and is released by the OS after a crash. Startup recovers an owned private stale socket; it preserves an active socket or an unfamiliar file. Use a shorter data-directory path if the complete Unix socket path exceeds 100 bytes.

The directory must be owned by the current user with private permissions (0700); credentials, databases, logs, socket, QR images, and downloaded files use 0600. Existing insecure state is rejected rather than silently repaired. The database file is `probe.sqlite`, retained from the validation program. Authentication uses the SDK's binary serializer and atomic key batches, with durable SQLite commits.

Credentials and messages are **not encrypted at rest**. Keep the entire directory, WAL/SHM files, QR images, logs, and backups private and out of version control. Stop the daemon before copying a backup. The repository ignores `.private/`, `.tmp/`, databases and logs; the package file allowlist excludes state. No credential deletion, logout, OS service installation or network-wide interruption is performed automatically.

## Verification and limits

```sh
pnpm test
pnpm check
```

Automated tests use fictional fixtures, offline daemons, local Unix sockets, and injected I/O failures; they never connect to real WhatsApp. See [the validation report](docs/validation.md) for real-account evidence and [the agent quick reference](docs/agents.md) for a compact workflow.

The [development roadmap](docs/roadmap.md) records the next capabilities and validation checkpoints. Contributions follow the independent-review workflow in [AGENTS.md](AGENTS.md).

This first version covers one account per directory, observed recipients, local history/search, text/documents, media download, archive/read operations and lifecycle. New-recipient discovery, complete-history guarantees, group administration, multiple-account orchestration, plugins and draft workflows are outside its scope.
