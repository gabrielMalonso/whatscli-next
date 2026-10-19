# Roadmap to a useful downstream deployment

The initial runtime and CLI are implemented. Live evidence and limits are in [validation.md](validation.md). The baseline has 32 passing offline tests. This roadmap extends that baseline; it does not claim parity with every browser operation.

Work sequentially, with one feature PR at a time and the independent-review process in [AGENTS.md](../AGENTS.md). Adjust later briefs when earlier findings change the actual constraint. A downstream organization must remain a consumer of this generic tool.

## Delivery order

- [x] **01 — Recipient resolution and contact identity.** Resolve an explicitly international telephone number to a WhatsApp-confirmed recipient; retain authoritative PN/LID associations and their provenance; expose unknown/ambiguous cases. Allow intentional first contact only after separate persisted verification, without inventing chat history. Cover offline behavior, conflicting mappings, exact identity and immutable request keys. Implemented with offline fixtures; real 1:1/media evidence remains checkpoint 06.
- [ ] **02 — Message context and deletion consistency.** Expose safe quoted-message context and received contact-card data. Reflect deletion/revocation in ordinary history/search projections, while keeping private audit evidence distinct. Preserve the cryptographic-material exclusion tests.
- [ ] **03 — Pending conversations.** Query unread/archived conversations with activity ordering and pagination. Preserve unknown/pending fields, manual unread state and incomplete coverage; do not interpret an empty local result as an empty remote queue.
- [ ] **03a — Compact JSON responses for agents.** Output is already minified. Reduce the content agents consume through small command-specific projections, fewer redundant fields and explicit pagination/text limits, with detailed output available on request. Preserve exact recipient/message/request IDs, actionable errors and local/partial/unknown evidence; make truncation explicit. Compare representative fictional responses before/after, measuring token usage with the same tokenizer when available and distinguishing token counts from byte counts. Avoid shortening field names or dropping evidence without a demonstrated benefit. Deliver this as a separate feature PR after message context and pending-conversation queries, before the pilot.
- [ ] **04 — Prolonged disconnections.** Exercise sustained outages and restart with offline fixtures. Revisit the retry limit and explicit intervention state. Preserve terminal-disconnect handling and uncertain sends, and report unproven receive gaps.
- [ ] **05 — Send contact cards.** Add generic contact-card sending with explicit content, exact recipient, durable intent and idempotency. Approved-contact choices belong to the downstream consumer.
- [ ] **06 — Media and 1:1 validation.** Agree on live test targets before testing text receipts, document sending, audio/attachment downloads, phone changes and restart. Fix demonstrated defects and add offline regressions. Record phone effects separately from SDK-derived evidence; do not manufacture delivery/read verdicts.
- [ ] **07 — Downstream adapter and transcription.** In the downstream repository, route the correct account/data directory, adapt command calls and invoke the existing external transcriber on downloaded audio. Keep business permissions, records, templates and documentation there. Follow that repository's own instructions and review workflow.
- [ ] **08 — Controlled pilot and reproducible release.** Agree on the deployment account and limited pilot conversations. Verify a complete work round with explicit uncertainty handling. Document installation, startup, recovery and the exact version used; retain private evidence outside public sources.

## Initial acceptance boundary

A useful version must support a supervised round: identify the exact recipient, read available text/quote/audio context, send text/documents/contact cards, preserve pending conversations, and recover the session without duplicating uncertain sends. Missing history or observations must remain visible and actionable.

Live validation requiring a phone owner or a new account/conversation is a separate checkpoint. Offline feature work can proceed first; a passing mock is not a substitute for that checkpoint.

Favorites, group administration, advanced filtering, operating-system service installation and multiple-account orchestration are deferred. Browser tabs, visual parking and compositor drafts do not need replacement commands.
