# Text replies to stored messages

`send` can send text quoting one explicitly selected, currently eligible message in the **same exact stored conversation**. All examples use fictional identifiers:

```sh
node dist/src/cli.js send --jid '123450001@lid' --key 'example-reply-001' \
  --text 'A fictional reply.' --quote-id 'EXAMPLE_MESSAGE_ID' --quote-from-me false

node dist/src/cli.js send --jid '120363000000000001@g.us' --key 'example-reply-002' \
  --text 'Another fictional reply.' --quote-id 'EXAMPLE_GROUP_MESSAGE_ID' \
  --quote-from-me false --quote-participant '123450001@lid'
```

Read the exact target's `id`, `fromMe`, and `participant` from `messages`. `--quote-from-me` is always required with `--quote-id`; it is relative to this account. Groups require `--quote-participant` even for own messages, and that participant must be present in the stored key. Direct conversations can omit it when selection is unique. A supplied participant is an exact canonical PN/LID identifier, never a name, device JID, shared card or inferred phone. Ambiguous selection fails instead of choosing a row. Omitted and explicit participant selectors are different key arguments.

The flat socket/JSONL command uses a nested selector. The outer `id` is **RPC correlation only**:

```json
{"id":"example-rpc","command":"send","key":"example-reply-001","jid":"123450001@lid","text":"A fictional reply.","quote":{"id":"EXAMPLE_MESSAGE_ID","fromMe":false}}
```

`quote` accepts only `id`, `fromMe`, and optional `participant`. There is no alternate quote JID. Ordinary `send` without `quote` keeps its prior behavior. Files/cards cannot be sent as replies; the outgoing reply is always text.

## Eligible content and pinned SDK limits

Eligible targets have nonempty observed text (`conversation`/`extendedTextMessage`) or an image/video/document caption, at most 64 KiB of UTF-8. Existing SDK message wrappers are normalized. The snapshot keeps the original content type and text/caption only; media bytes, filenames, thumbnails, URLs, cryptographic fields, cards and embedded quoted chains are excluded. No download, audit-body recovery or guessed preview occurs. Audio, stickers, cards and other unsupported/empty/unavailable targets are refused.

For atypical stored messages with multiple content fields, the snapshot uses only the type selected by rc14 and that same field's text/caption. A selected field without eligible text is refused; text in another field cannot supply its body.

Baileys **7.0.0-rc14** generates incoming quote authors from the supplied stored participant or direct peer; own quote authors come from `creds.me.id`, with an upstream LID TODO. This implementation supports exact incoming PN/LID authors, including group participants. Own quotes require a known canonical PN account author, matching the stored participant when present. Own LID conversations/authors, missing group authors and inconsistent direct authors are explicitly refused.

New PN sends retain the existing per-request USync route preparation. If it selects a different LID destination, this feature refuses **before intent/invocation**: rc14 would otherwise write the original peer PN into cross-chat `contextInfo.remoteJid`, and this feature does not invent another conversation or quote author. Route lookup never authorizes finding the target in a LID chat. An explicit LID request can quote only a message actually stored in that exact LID conversation. Failed/unproven route lookup retains the exact PN destination and can quote an eligible PN target. No SDK update, context override or identity substitution is used to bypass these limits.

## Durable intent, deletion and errors

The existing key guard covers quote selection and route preparation. The runtime validates the target before the route await, then reselects and compares the safe snapshot afterward. Deletion, revocation, an uncertain deletion boundary, a newly ambiguous target or a changed snapshot aborts before persistence/invocation. A later event after the single SDK invocation cannot cancel that attempted send; public message visibility still follows deletion policy.

The intent transaction commits the original `operation.quote` selector, generated outgoing `messageId`, immutable route and a separate safe `quote` snapshot before the only invocation:

```json
{"reference":{"jid":"123450001@lid","id":"EXAMPLE_MESSAGE_ID","fromMe":false,"participant":null},"author":"123450001@lid","contentType":"conversation","text":"Fictional original body"}
```

The top-level request `quote` above is **intent evidence**, distinct from a history message's one-level embedded `quote`. Full/compact `send` and `request` preserve it identically, including uncertainty. Later target edits/deletions do not rewrite immutable intents or permit resend. Current history/quoted views stay redacted according to tombstones/boundaries, and search indexes only current top-level text/caption, never quoted text or intent snapshots. SQLite backups preserve the additive JSON fields with no schema change; treat these snapshots as private message content, unencrypted at rest.

An existing key is checked before quote, credential, chat or route lookups. Exact replay returns its original pending/uncertain/completed record even offline or after restart, deletion or editing. Changed text, selector ID/direction/participant, kind or exact recipient yields `KEY_CONFLICT`; adding a quote to a legacy plain-text intent also conflicts. Never create a new key to bypass uncertainty. Inspect `request --key ORIGINAL_KEY` after an error.

Malformed selectors yield `INVALID_ARGUMENT`. Missing/deleted/ambiguous/unsupported targets and unsupported author/route cases yield `PRECONDITION_FAILED`. Intent/completion transaction failures retain `LOCAL_STATE`; SDK failures retain the existing uncertain intent. The public error boundary excludes SDK/SQL snippets and private paths. Existing attempt, acceptance, delivery and read evidence remains separate, and sending does not optimistically update observed chat state.

## Offline verification boundary

`test/quoted-text.test.ts` uses fictional private state, injected I/O, actual rc14 `generateWAMessage` and a protobuf encode/decode round trip. It covers exact direct/group authors and directions, safe captions, collisions, unsupported targets, PN/LID refusal, mutation during route preparation, same-key concurrency/conflicts, replay/restart, deletion visibility, search exclusion, receipt ordering, transaction failures and CLI/socket/JSONL projections/errors. No real socket factory, account or WhatsApp call is used.

This proves local intent handling and SDK generation for the supported cases. It does not verify phone rendering, delivery/read/phone effect, receiving/decryption/catch-up, production operation or macOS. Historical checkpoints 06/08 do not validate this feature. Observations remain local/partial, app state unknown and receive continuity unproven.
