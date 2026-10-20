# Sending messages and media

Send text, a local document, or one explicit contact card. Choose a stable key before sending and follow the [durable-key and failure rules](evidence.md#durable-keys-and-replay). Text can also [quote a stored message](quoted-replies.md).

All examples use fictional identifiers:

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

node dist/src/cli.js send-contact \
  --jid '12025550101@s.whatsapp.net' \
  --key 'example-card-001' \
  --name 'Fictional Contact' \
  --phone '+12025550103'
```

## Files

Files are sent as WhatsApp documents with their filenames preserved. The default MIME type is `application/octet-stream`, and the initial size limit is 64 MiB.

The runtime sends one byte snapshot, persisting its size, SHA-256, arguments, and message ID before invocation. Reusing the key retains the original manifest even if the file at that path changes.

## Contact cards

`--jid` selects the recipient; `--name` and `--phone` describe only the shared content.

| Field | Requirements                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone | Explicit `+` followed by 8–15 digits beginning with a nonzero digit; no other punctuation or inferred country code.                                                               |
| Name  | Nonblank, at most 256 UTF-8 bytes, preserving spelling, Unicode, and surrounding spaces. C0/C1 controls, Unicode line/paragraph separators, and unpaired surrogates are rejected. |

Only one explicit card is supported. Raw vCards, multiple cards, and implicit lookups are unsupported. The immutable request retains the exact recipient, name, phone, generated card, and message ID in both output formats. Deleting current message bodies does not erase this intent evidence.

A card does not verify WhatsApp membership, phone ownership, recipient identity, or permission to share or send. It never contributes to identity mappings or recipient verification. Recipient checks follow the same exact observed-chat or persisted positive exact-PN requirements as other sends; aliases and `--allow-jid` remain exact. The caller is responsible for sharing permissions.

## Direct PN routes and receipts

A new direct PN send may use a server-confirmed LID destination. The original PN still controls authorization and `--allow-jid`; the request retains its original `operation.jid`, message ID, and immutable route:

```text
route: {status, jid, source, observedAt, limit}
```

| Route      | Meaning                                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proven`   | One exact PN result, a canonical LID, and no known conflict at either endpoint. `jid` is the actual LID destination; `limit: server-association-at-query-time`.                                    |
| `unproven` | Lookup failed or returned missing, malformed, ambiguous, or conflicting evidence. The destination remains the original PN; `reason` explains the gap and `limit: exact-original-destination-only`. |

The runtime queries the pinned SDK for each new PN send rather than treating cached mappings as proof. `observedAt` is the local query time in milliseconds. The association proves neither permanent ownership nor acceptance, delivery, or read status.

Groups and explicit LID sends require no PN route lookup. Routing never creates or merges PN/LID histories. Replayed keys perform no new lookup. Legacy requests have no route evidence, and later mappings never backfill it.

Proven-route receipts must match the recorded destination and message ID, `fromMe: true`, and no group participant. Supported device suffix normalization preserves the JID domain; PN and LID digits are never interchangeable. Unproven routes retain the exact-original-destination receipt rule. Later mappings neither rewrite routes nor retract receipts. Unmatched legacy receipts remain in `events` without promoting the request.

## Download media

```sh
node dist/src/cli.js download \
  --jid '12025550101@s.whatsapp.net' \
  --id 'EXAMPLE_MESSAGE_ID' \
  --out ./example-download.pdf
```

For ambiguous message IDs, add `--from-me true|false` and `--participant EXACT_JID`. The runtime uses Baileys to decrypt and download media, writes a private output file, and returns the byte count and SHA-256.

Downloads are limited to 64 MiB and never overwrite existing output. Failures preserve partial files. Expired media may require an SDK reupload request or remain unavailable.
