# Message content and observations

These notes describe encoding and normalization for contributors. User-facing limits are documented in [sending](../user/sending.md) and [history](../user/history.md).

## Contact-card encoding

[contact-card.ts](../../src/contact-card.ts) builds deterministic vCard 3.0 content, escaping backslashes, commas, and semicolons. It uses CRLF framing and folds lines at 75 UTF-8 bytes without splitting code points. Input validation preserves accepted names without normalization.

The pinned SDK receives `{contacts: {contacts: [card]}}` for one `contactMessage`. Before invocation, the immutable intent stores the recipient, explicit name and phone, generated card, and message ID. Card content never contributes to identity mappings or verification.

Incoming card projection unfolds continued plain `FN`/`TEL` lines and unescapes text. Malformed content or unsupported encoding remains incomplete or malformed rather than becoming identity evidence.

## Revocation validation

[store.ts](../../src/store.ts) validates raw sender-relative targets against account-relative envelopes. Same-author target direction follows the envelope. An administrative revocation by our account of another participant's received group message requires the original participant. Own group messages retain their single-author identity when an echo adds a participant.

An inbound direct target may identify our account as the sender's destination only when authenticated self PN/LID identities establish that perspective, using supported device normalization. The local target remains in the envelope's exact peer chat without alias merging.

Another sender's other-author target, missing self or direction evidence, or inconsistent chat/participant identity remains unknown. A derived REVOKE update with a notification key must match an available, consistent raw notification. The lossy rc14 projection cannot override this check or authorize deletion in another direction.

Explicit REVOKE stubs and protocol revocations provide separate deletion evidence; a null body alone does not. Body, search, tombstone, and journal changes remain transactional. See [storage](storage.md) for visibility and projection rules.

## Activity derivation

Activity uses the greatest positive, safe timestamp in seconds from rc14's `conversationTimestamp`, `lastMsgTimestamp`, `lastMessageRecvTimestamp`, an exact-chat embedded message, or an independently observed `messageTimestamp`.

Sources are `chat.FIELD` or `message.messageTimestamp`; ties select the lexically first source. Missing or invalid values produce `{timestamp: null, source: null}`.

Upgrade recovery uses legacy chat fields and stored incoming timestamps. Legacy own-message rows cannot distinguish SDK returns from independent echoes, so recovery excludes them. Local observation time never substitutes for message activity.
