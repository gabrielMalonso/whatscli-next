# Store queries and schema

SQLite remains the durable store, owned by the single runtime. CLI and full/compact response contracts are unchanged. No additional SDK, dependency, network service or in-memory history cache is used.

`store.ts` owns observation, visibility and identity/intent rules. `store-codec.ts` contains the pinned SDK serialization and enum recovery. `store-schema.ts` declares the SQLite tables and rejects unsupported schema versions before changing the message database.

## Queries

- `messages.json` retains the original current SDK envelope. Redacted bodies become null; private deletion audit remains in `message_deletions.audit_json` and never enters search.
- `message_text` holds only the normalized current top-level text/caption, exact JID, timestamp and message rowid. The shared text selector excludes quoted snapshots, cards, filenames, raw context and SDK key material. Non-text bodies have an empty text value; absent/deleted bodies have no search row.
- Search normalizes the whole string with JavaScript NFKC then lowercase, and uses SQLite `instr` with bound parameters. One/two-character queries, Unicode, punctuation, `%`, `_` and FTS-like input retain literal substring semantics. There is no word tokenizer or input query language.
- Global and exact-JID search scan this narrow table in timestamp/rowid descending order, with offset/limit applied before fetching SDK bodies for the selected page. Worst-case matching remains linear in searchable text. Pagination still observes a changing local store, not a snapshot.
- `message_history(jid,timestamp)` supplies history ordering by reverse index scan; SQLite's implicit rowid gives the existing descending tie break. Equivalent global and per-JID text indexes avoid sorting the full search result.
- `request_message_id` indexes the immutable message ID expression in request JSON. Receipt correlation decodes only candidates with that ID, then applies the existing exact destination/route, direction, participant and monotonic status rules. Identity evidence is never used to rewrite an intent or guess a receipt route.

FTS5/trigram is available in the measured Node build. The narrow scan is deliberately simpler: it preserves all substring cases with one implementation, and the synthetic results below already remove the dominant decode cost. FTS is deferred until a measured workload justifies candidate indexing plus exact verification and short-input fallback.

Body replacement, search-row replacement/removal and tombstones share a synchronous SQLite transaction, joining the surrounding runtime event transaction when present. Updates retain the existing rowid replacement/order behavior. Deletion/revocation/boundary checks remain authoritative for history, quotes, media and SDK getMessage. Audit and immutable send intents cannot restore current content.

Chat filtering retains its existing AND tri-state/pending semantics and maximum activity provenance; it is included in the benchmark without an additional chat projection or cache.

## Schema and upgrade

Schema `PRAGMA user_version=1` is an additive upgrade from the version-0 repository schema. Startup under the writer lock runs existing identity/deletion/activity recovery first, streams current message rows into `message_text`, builds query indexes and commits the backfill plus version atomically. It preserves message rowids, requests, IDs, routes, authentication and audit records. A failed query backfill rolls back and fails startup; it does not reset state or start a socket. Subsequent starts skip the completed backfill.

No import/conversion command or complete historical migration guarantee is provided. Do not edit Store tables directly or run an older runtime against an upgraded directory: older writers do not maintain this projection. Upgrade the runtime and CLI together after the existing runtime has exited normally; building alone does not replace a running daemon. Future/unsupported schema versions fail with an instruction to use a compatible executable or a **NEW `--data-dir`**, preserving the old database. No automatic deletion, re-pairing, parallel account session or intent recreation occurs.

A fresh directory is also supported. Pairing a new session requires separate account authorization, and reconnection/re-pairing cannot guarantee complete history recovery. This feature was verified only with generated offline data.

## Reproducible benchmark

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm benchmark:store --output .tmp/store-query-results.json
```

The driver extracts only versioned source from exact base `9a7f36297b416a0953983e8bb58a0794c85269f6` into its own ignored scratch directory, builds with the same installed TypeScript/dependencies and runs that original Store implementation. Only the compiler include/root directory is adjusted for the source-only extraction. It neither creates a worktree nor reads any account directory. Candidate code comes from the fresh build. Generated databases and reports remain in `.tmp/store-bench-*`; the script does not delete them.

Volumes are 22,973 and 68,919 messages in 726 fictional conversations, with 5,000 and 15,000 requests. Deterministic mixed text, wrapped captions, audio, long excluded quoted contexts, tied timestamps, exact PN/LID/group IDs and a busy conversation exercise the relevant costs. Fixtures use no random/account/wall-clock inputs; SHA256 equality of seeded messages/requests and every benchmark query result is asserted between implementations, before and after mutations. Chat metadata observation times are omitted from comparison.

All phases and variants run sequentially in separate Node processes. Ingestion is one history-sized transaction. Query processes never generate/ingest the history. Each query has one first invocation and six subsequent calls; reports give first latency and warm min/median/max with n. “First” means process/Store first invocation per scenario; OS page cache is uncontrolled and warmed by seed/earlier phases. No forced GC or claims of cold-disk performance. Only the first scenario is also the first query in that process.

Queries include global misses/results, Unicode, one/two-character terms, excluded context, exact-JID misses/results, ordered history, AND/unknown chat filters and receipts. Query timings include safe message projections. Five rounds measure 50 edits, 50 deletions and one standalone insert; a new process checks queries after restart. A separate candidate process times additive upgrade on a closed copy of this run's generated baseline DB. Single ingestion/upgrade observations are n=1, not distributions.

Memory reports use each child process's own RSS high-water mark (including imports), and RSS/heap snapshots between calls; heap snapshots are not a true heap peak. Disk reports use checkpointed file bytes and `dbstat` allocated pages by table/index before/after mutation, with no VACUUM. CLI `help` measures Node/CLI startup separately (one first plus six subsequent processes); direct Store timings exclude CLI, Unix socket and daemon startup. Removing a SQL cost does not remove those costs.

These fixtures expose scaling and tradeoffs, not account-specific performance, leaks, delivery, complete history, sustained concurrency or live WhatsApp behavior. The coordinator must perform any real-data offline comparison separately, outside workers/worktrees.
