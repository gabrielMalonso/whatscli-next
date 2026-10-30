# Message content and observations

These notes describe encoding and normalization for contributors. User-facing limits are documented in [sending](../user/sending.md) and [history](../user/history.md).

## Contact-card encoding

[contact-card.ts](../../src/contact-card.ts) builds deterministic vCard 3.0 content, escaping backslashes, commas, and semicolons. It uses CRLF framing and folds lines at 75 UTF-8 bytes without splitting code points. Input validation preserves accepted names without normalization.

The pinned SDK receives `{contacts: {contacts: [card]}}` for one `contactMessage`. Before invocation, the immutable intent stores the recipient, explicit name and phone, generated card, and message ID. Card content never contributes to identity mappings or verification.

Incoming card projection unfolds continued plain `FN`/`TEL` lines and unescapes text. Malformed content or unsupported encoding remains incomplete or malformed rather than becoming identity evidence.

## Edit projection

[message-edits.ts](../../src/message-edits.ts) uses the pinned SDK's authenticated MESSAGE_EDIT decryption helper. Target validation uses the envelope's exact account-relative conversation, direction and author; a sender-relative target must identify that same author. PN/LID candidates come from observed envelope addressing, authenticated self identities or an unambiguous stored mapping; they do not merge histories.

The store preserves the original message secret privately across content replacement and restores protobuf base64 fields before decryption. Legacy edits are projected from validated envelopes; the lossy derived SDK edit body/timestamp is stripped before buffering so it cannot replace an original's secret/time or bypass target validation. Other update fields, including receipt status, remain observable. Applied edit timestamps are persisted separately from the original send timestamp. Search indexes only current content. A one-time recovery replays stored envelopes; unresolved originals/secrets retain exact pending envelope references across restart. SDK retry/resend lookups retain their existing outgoing-content restriction.

## Revocation validation

[store.ts](../../src/store.ts) validates raw sender-relative targets against account-relative envelopes. Same-author target direction follows the envelope. An administrative revocation by our account of another participant's received group message requires the original participant. Own group messages retain their single-author identity when an echo adds a participant.

An inbound direct target may identify our account as the sender's destination only when authenticated self PN/LID identities establish that perspective, using supported device normalization. The local target remains in the envelope's exact peer chat without alias merging.

Another sender's other-author target, missing self or direction evidence, or inconsistent chat/participant identity remains unknown. A derived REVOKE update with a notification key must match an available, consistent raw notification. The lossy rc14 projection cannot override this check or authorize deletion in another direction.

Explicit REVOKE stubs and protocol revocations provide separate deletion evidence; a null body alone does not. Body, search, tombstone, and journal changes remain transactional. See [storage](storage.md) for visibility and projection rules.

## Activity derivation

Activity uses the greatest positive, safe timestamp in seconds from rc14's `conversationTimestamp`, `lastMsgTimestamp`, `lastMessageRecvTimestamp`, an exact-chat embedded message, or an independently observed `messageTimestamp`.

Sources are `chat.FIELD` or `message.messageTimestamp`; ties select the lexically first source. Missing or invalid values produce `{timestamp: null, source: null}`.

Upgrade recovery uses legacy chat fields and stored incoming timestamps. Legacy own-message rows cannot distinguish SDK returns from independent echoes, so recovery excludes them. Local observation time never substitutes for message activity.
