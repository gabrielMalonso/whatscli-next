# Architecture overview

```text
agent → CLI → private Unix socket → daemon → Baileys
                                      ↓
                                      SQLite
```

## Ownership and transport

Only the daemon owns the WhatsApp connection and writes to SQLite. A lifetime SQLite lock enforces one writer per data directory. The JSONL probe uses the same runtime and must not share a directory with an active daemon.

The CLI resolves `--account NAME` to `accounts/<lowercase-name>` under the platform's default data location, then passes only the resolved directory to the daemon. There is no account registry or shared connection manager. `--data-dir PATH` remains an alternative; omitting both retains the default session.

Startup recovers owned, private stale sockets while preserving active sockets and unfamiliar files. The complete Unix socket path must fit within 100 bytes.

Each CLI invocation starts a new Node process without loading the SDK, Store, or connection runtime. RPC uses one newline-delimited response, an inclusive 8 MiB response cap, and a single transport attempt. Fragment assembly scans each decoded fragment once, then joins and parses the first complete line.

Full and compact output use the same socket payload. Smaller pages reduce transport volume.

The optional `whatscli-tui` is a separate terminal client of the same socket. Its command type permits only `status`, `chats`, `messages`, and local `contact` queries; it does not import the SDK or open SQLite. It polls bounded pages every two seconds, serializes refresh cycles, discards replies for obsolete selections, and freezes displayed history while the user scrolls. Optional contact names load separately with bounded concurrency and caching. Its alternate-screen output is separate from the JSON CLI. See the [terminal monitor guide](../user/tui.md).

The flat socket/JSONL request reserves `id` for correlation. Downloads use a separate `messageId`:

```json
{"id":"rpc-example","command":"download","jid":"12025550101@s.whatsapp.net","messageId":"EXAMPLE_MESSAGE_ID","path":"/private/example-download.txt","fromMe":true}
```

A missing `messageId` is rejected. CLI `download --id MESSAGE_ID` still selects the media message.

## Persistence and evidence

Authentication, observations, and immutable operation intents are stored in `probe.sqlite`. The intent and message ID are committed before SDK invocation. Exact-key replay returns the original record without another attempt; completion failures preserve the committed intent and independently recorded receipts.

Body/search updates, outcome changes, and their journals commit or roll back together. Deletion batches are atomic. SQLite transactions cannot undo remote effects or establish delivery.

See [storage](storage.md) for schema and search rules, [message content and observations](message-content.md) for card encoding and deletion/activity normalization, and [read/unread internals](read-unread.md) for SDK confirmation limits. [Command evidence](../user/evidence.md) explains how to interpret results.

Credentials and messages are not encrypted at rest. [Privacy](../operations/privacy.md), [backup/recovery](../operations/backup.md), and [runtime recovery](../operations/runtime.md) cover operational requirements. [Observability](observability-architecture.md) is a separate best-effort recorder, not authoritative operation state.

## Source map

| Area                       | Entry points                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CLI and daemon lifecycle   | [cli.ts](../../src/cli.ts), [daemon.ts](../../src/daemon.ts)                                               |
| Runtime and operations     | [runtime.ts](../../src/runtime.ts), [operations.ts](../../src/operations.ts)                               |
| Socket and projections     | [rpc.ts](../../src/rpc.ts), [protocol.ts](../../src/protocol.ts), [response.ts](../../src/response.ts)     |
| Storage and authentication | [store.ts](../../src/store.ts), [store-schema.ts](../../src/store-schema.ts), [auth.ts](../../src/auth.ts) |
| Identity and routing       | [identity.ts](../../src/identity.ts), [send-route.ts](../../src/send-route.ts)                             |

See [Contributing](../../CONTRIBUTING.md) for setup, checks, and testing boundaries.
