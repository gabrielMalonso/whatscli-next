# Sending messages and media

Send text, a local file, or one explicit contact card.

Text can also [quote one explicitly selected stored message](quoted-replies.md), using exact direction and participant information, safe snapshots, and the documented PN/LID SDK limits.

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

## Send a file

Files are sent as WhatsApp documents, preserving their filenames.

The default MIME type is `application/octet-stream`. The initial file size limit is 64 MiB.

The daemon reads one byte snapshot, then persists its size, SHA-256, arguments, and generated message ID before invoking Baileys with those exact bytes.

## Send a contact card

`send-contact` sends one `contactMessage` through rc14 using the payload `{contacts: {contacts: [card]}}`.

`--jid` identifies the recipient. `--name` and `--phone` describe only the shared card.

### Card field requirements

The phone number must:

- Start with an explicit `+`.
- Contain 8–15 digits after the `+`.
- Start those digits with a nonzero digit.
- Contain no additional punctuation.

No country code is inferred.

The name must be nonblank and at most 256 UTF-8 bytes.

Unicode, spelling, and surrounding spaces are preserved without normalization.

The following are rejected:

- C0/C1 control characters
- Unicode line and paragraph separators
- Unpaired surrogates

### vCard generation

The deterministic vCard 3.0 builder:

- Escapes backslashes, commas, and semicolons.
- Uses CRLF line framing.
- Folds lines at 75 UTF-8 bytes without splitting code points.

Raw vCards, implicit lookups, and multiple cards are unsupported.

### Durable contact-card intent

Before SDK invocation, SQLite records an immutable `send-contact` operation containing:

- Exact recipient
- Name and phone number
- Generated vCard
- Message ID

Repeating the key compares the complete content and returns the original record, including while the SDK is pending, offline, or after a restart or identity change.

Changing the recipient, name, phone, or operation kind causes a conflict.

Full output, compact output, and `request` preserve the complete intent alongside separate attempt, receipt, and uncertainty fields.

Deleted current message bodies remain hidden. The original request remains available as intent evidence.

An SDK return alone establishes no acceptance, delivery, read status, or observed chat/state.

### Contact-card safety

The phone number in a shared card does not verify:

- Recipient identity
- Current WhatsApp membership
- Phone-number ownership
- Permission to share or send

Card content never contributes to recipient checks, identity mappings, or verified contacts.

Recipient authorization follows the same exact observed-chat or persisted positive exact-PN rules as other sends. PN/LID aliases and `--allow-jid` remain exact.

Sharing permissions and approved-contact decisions belong to the downstream consumer.

[Checkpoint 06](../internals/validation.md#checkpoint-06--essential-flow-accepted) records one phone-confirmed card with a fictional number in an approved group, alongside offline generation tests.

That evidence does not validate arbitrary card rendering or real first contact.

## Durable request keys

A key identifies one immutable operation.

Reusing it returns the recorded result, including uncertainty, without sending again. Changed arguments are rejected.

Reusing a file key returns its original byte manifest, even if the file's contents have changed since the first request.

Inspect an uncertain result with:

```sh
node dist/src/cli.js request --key 'example-message-001'
```

Do not create a new key merely because a request timed out.

An intentional new message requires a new key. The program never automatically resubmits uncertain intents, including after a restart.

## Direct PN send routing

For every new direct PN send—text, document, or contact card—the runtime queries the pinned SDK's `executeUSyncQuery` with LIDProtocol.

It does not treat the mapping cache as proof.

### Proven routes

A route is established only when the query returns:

- One exact PN result
- A canonical LID
- No known conflict at either endpoint

The original PN continues to control recipient authorization and `--allow-jid`.

The immutable request retains `operation.jid`, its message ID, and:

```text
route: {status, jid, source, observedAt, limit}
```

A `proven` route records the LID actually passed to `sendMessage`.

Its `limit` is `server-association-at-query-time`.

This establishes a server association at the time of the query. It does not establish permanent ownership, acceptance, delivery, or read status.

`observedAt` is the local query observation time in milliseconds.

SDK messages retain their native LID identity. PN and LID chats are not created or merged by routing.

### Unproven routes

Failed, missing, malformed, ambiguous, or conflicting query results leave the send addressed to the original PN, with its exact receipt rule.

The request records:

- `route.status: unproven`
- A `reason`
- `limit: exact-original-destination-only`

An unproven route grants no authority to use an alias.

Groups and explicit LID sends keep their existing behavior without a PN route lookup.

### Repeated and legacy requests

Repeated keys return their original evidence before any new lookup or send, including concurrent calls and calls after a restart.

A file key retains its original byte manifest even if the contents at that path change.

Legacy requests have no route evidence. Later mappings or queries never backfill their routes.

Unmatched legacy receipts remain available through `events`, but do not promote the original request.

## Receipt correlation

For a proven route, receipt correlation requires:

- The recorded destination
- The exact message ID
- `fromMe: true`
- No group participant

SDK device normalization preserves the JID domain and accepts only supported canonical user/device JIDs.

It never treats PN and LID digits as equivalent.

Recorded routes are immutable. Later mappings neither rewrite them nor retract observed receipts.

Full and compact output both preserve all route and receipt evidence.

## Download media

Download a stored media message:

```sh
node dist/src/cli.js download \
  --jid '12025550101@s.whatsapp.net' \
  --id 'EXAMPLE_MESSAGE_ID' \
  --out ./example-download.pdf
```

If the message ID is ambiguous, use `--from-me true|false` and `--participant EXACT_JID` to identify the message.

The daemon asks Baileys to decrypt and download the media, writes a private output file, and returns its byte count and SHA-256.

Existing output files are never overwritten.

### Download limits

Media downloads are limited to 64 MiB.

Failed downloads report the failure and preserve any partial file.

Expired or unavailable media may require the SDK's reupload request, or may remain unavailable.
