# Storage and queries

SQLite belongs to the single runtime. `store.ts` manages observations, visibility, identity, and intents; `store-codec.ts` handles pinned SDK serialization and enum recovery; `store-schema.ts` defines tables and rejects unsupported versions.

## Query model

- `messages.json` stores the current SDK envelope privately. Deleted bodies are redacted; retained first-body audit data stays in `message_deletions.audit_json` and is never exposed through public history or search.
- `message_text` stores normalized current top-level text/captions, exact JID, timestamp, and message rowid. Quotes, cards, filenames, raw context, and SDK key material are excluded. Nontext bodies have empty text; absent or deleted bodies have no search row.
- Search applies whole-string JavaScript NFKC normalization, then lowercase conversion and bound SQLite `instr`. One- or two-character input, Unicode, punctuation, `%`, `_`, and FTS-like syntax are treated as literal substrings. Global and exact-JID queries scan in descending timestamp/rowid order, applying offset/limit before decoding selected bodies. Worst-case scans remain linear, and pages are not snapshots.
- `message_history(jid,timestamp)` provides reverse-index history ordering, using SQLite rowid as the descending tie-breaker. Text indexes avoid sorting the full result.
- `request_message_id` indexes message IDs within immutable request JSON. Receipt candidates still require the recorded exact route/destination, direction, participant, and monotonic status. Mappings never rewrite an intent.

FTS remains deferred. The narrow projection reduces SDK-body decoding work without changing substring semantics. Observation mutations update bodies, projections, tombstones, and journals in one transaction.

Immutable quoted-send snapshots remain in request JSON, outside current text search and deletion visibility. See [quoted replies](../user/quoted-replies.md) for this distinction.

## Schema and upgrade

`PRAGMA user_version=1` upgrades the repository's version-0 schema under the writer lock. Existing identity, deletion, and activity recovery runs first. Message rows are then streamed into the projection, indexes are built, and backfill and version changes are committed atomically.

Existing rowids, authentication, intents/IDs/routes, audit data, and persisted timestamps—including protobuf Long values—are preserved. A failure rolls back the upgrade and stops startup before socket creation. Later starts skip completed backfill.

Do not edit tables directly or run an older writer against upgraded state; it cannot maintain the projection. Unsupported future versions fail without deleting data.

Use a compatible executable or a new directory. Creating and pairing a fresh session is a separate decision, not history recovery. Follow [normal upgrade](../operations/release.md#identify-startup-and-upgrade-without-losing-the-session) and [SQLite backup/recovery](../operations/backup.md).
