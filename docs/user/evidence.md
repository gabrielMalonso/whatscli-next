# Understanding command results

Use this guide to interpret outcomes and handle interrupted commands. [JSON output](output.md) defines serialization, compact fields, and error codes.

## Local and remote evidence

Responses describe local observations: `source: local`, `coverage: partial`, and `appState: unknown`. History, chat state, and receipts do not establish complete remote state. A missing client update does not prove the phone's state remained unchanged.

| Evidence                 | What it establishes                                          |
| ------------------------ | ------------------------------------------------------------ |
| `ok: true`               | The command was processed, not that a message was delivered. |
| `attempt: sdk-returned`  | Baileys returned the expected message.                       |
| `attempt: uncertain`     | The intent exists; completion is unknown.                    |
| `acceptance: server-ack` | Matching SDK acceptance evidence was observed.               |
| `delivery: delivered`    | Matching SDK delivery evidence was observed.                 |
| `read: read`             | Matching SDK read evidence was observed.                     |

Missing receipts remain `unknown`. A successful response can still contain `attempt: uncertain` and `errorObserved: true`. Group participant receipts are separate events; one participant's receipt does not establish everyone's outcome. Phone confirmation remains independent evidence.

## Durable keys and replay

A key identifies one immutable operation. The intent is committed before SDK invocation, along with a generated message ID for sends. Exact-key replay returns the original pending, uncertain, or completed record without another lookup or invocation, including during concurrent calls, offline inspection, and after restart.

Changing the kind, exact recipient, content, or arguments causes a conflict. Requests retain their original identities and routes; later PN/LID mappings never rewrite them. File keys retain the original byte manifest even if the file changes. See [sending](sending.md) and [quoted replies](quoted-replies.md) for operation-specific content.

## Timeouts and failures

After a timeout or error, inspect the original key:

```sh
node dist/src/cli.js request --output full --key ORIGINAL_KEY
```

A timeout or transport disconnect does not cancel runtime work. `request` returning null means no intent has been recorded yet, not that the original command cannot still proceed. Never create a replacement key to retry an uncertain action; a new key represents a new intended action.

If recording an SDK outcome fails, the entire outcome update rolls back. The committed intent, message ID, and earlier independent receipts remain authoritative, and the attempt may remain uncertain. A local error does not establish nondelivery. Fix storage failures before further mutations.

The SDK's outgoing retry-content cache is disabled, and outgoing content is withheld from its retry callback. This prevents that path from silently resending an uncertain message but reduces recovery from recipient decryption failures. Incoming decryption retries remain enabled.
