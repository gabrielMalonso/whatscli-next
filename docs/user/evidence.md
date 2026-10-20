# Understanding command results

Command success, SDK return, acceptance, delivery, and read status are separate observations. Interpret each field according to the evidence it provides.

## Output formats

Use `--output compact` to reduce agent input, or `--output full` for the original safe public projection. Full output is the default.

Both formats return minified JSON.

Compact output uses command-specific omissions and exact-context inheritance. It does not truncate text or change pagination, evidence, errors, or exit codes.

Before consuming compact history output, check its different response shape and optional fields in the [compact output contract](output.md).

To inspect an existing intent without repeating the operation, use:

```sh
node dist/src/cli.js request --output full --key KEY
```

## Response contract

Every command returns one JSON object on stdout.

Errors return `ok: false` and a nonzero exit code.

SDK diagnostics go through stderr to the daemon's private `daemon.log`.

Responses include connection state and:

- `source: local`
- `coverage: partial`
- `appState: unknown`

These fields describe local evidence, not complete remote state.

## Interpret send evidence

| Evidence                | What it establishes                                       |
| ----------------------- | --------------------------------------------------------- |
| `ok`                    | The command was processed. It is not a delivery verdict.  |
| `attempt: sdk-returned` | Baileys returned the expected message.                    |
| `attempt: uncertain`    | Completion is unknown.                                    |
| `acceptance`            | Advances only on matching SDK acceptance-status evidence. |
| `delivery`              | Advances only on matching SDK delivery-status evidence.   |
| `read`                  | Advances only on matching SDK read-status evidence.       |

Send intent is durable before SDK invocation.

Missing acceptance, delivery, or read evidence remains `unknown`.

### Group receipts

Group participant receipts remain separate event evidence.

One participant's receipt does not prove that every participant received or read the message.

### Recipient identity

PN/LID associations are queryable evidence.

Requests, history, and receipts retain their original identities without alias merging.

Repeating a send key uses the original intent without another lookup, even offline or after verification changes.

## Interpret local history and state

Chat snapshots contain local observations, with unknown or pending fields where appropriate.

A missing client-side update does not establish that the phone's state remained unchanged.

Message output includes:

- Message text
- Keys and identifiers
- Content type
- Safe media metadata

Raw SDK objects, sender-key distributions, and message secrets remain in private storage.

## Handle transport timeouts

A transport timeout does not cancel an in-flight WhatsApp attempt.

Query the original request key afterward rather than creating a new operation.

### Outgoing retry behavior

The SDK's outgoing retry-content cache is disabled. Outgoing content is also withheld from its retry callback.

This prevents that callback path from silently relaying an uncertain message again.

The trade-off is reduced recovery from recipient decryption failures. Delivery may remain unknown.

Incoming decryption retry requests remain enabled.

## Handle storage failures

If local storage fails while recording a completed or failed SDK call:

1. The command returns an error.
2. The entire outcome update rolls back.
3. The previously committed intent, message ID, and any earlier independent receipts remain authoritative.

Query the original key to inspect the recorded state. It may still show `attempt: uncertain`.

Repeating the same key never invokes the operation again.

Fix the storage problem before making further mutations.

A storage error does not establish whether WhatsApp received the operation.
