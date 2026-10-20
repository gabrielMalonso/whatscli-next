# Store queries and schema

SQLite remains the durable store, owned by the single runtime. CLI and full/compact response contracts are unchanged. No additional SDK, dependency, network service or in-memory history cache is used.

`store.ts` owns observation, visibility and identity/intent rules. `store-codec.ts` contains the pinned SDK serialization and enum recovery. `store-schema.ts` declares the SQLite tables and rejects unsupported schema versions before changing the message database.

## Backup and recovery

`backup --out NEW_DIRECTORY` uses the runtime-owned handle with Node's SQLite online backup API, preserves committed logical state/schema/rowids and verifies the actual artifact before publishing `backup.json`. SQLite holds auth/key categories, intents/IDs/routes/receipts/pending state, bodies/audit/tombstones, identities, projection and events. Logs, QR PNGs, external media/files, control socket and the separate writer-lock database are excluded. No source VACUUM/checkpoint, schema migration, retention change or restore-over-existing operation is introduced. See [the complete scope, private-output rules, failure handling and offline recovery guide](backup.md). Normal stop/PID exit followed by private full-directory copying remains a valid manual path.

## Queries

- `messages.json` retains the original current SDK envelope. Redacted bodies become null; private deletion audit remains in `message_deletions.audit_json` and never enters search.
- `message_text` holds only the normalized current top-level text/caption, exact JID, timestamp and message rowid. The shared text selector excludes quoted snapshots, cards, filenames, raw context and SDK key material. Non-text bodies have an empty text value; absent/deleted bodies have no search row.
- Search normalizes the whole string with JavaScript NFKC then lowercase, and uses SQLite `instr` with bound parameters. One/two-character queries, Unicode, punctuation, `%`, `_` and FTS-like input retain literal substring semantics. There is no word tokenizer or input query language.
- Global and exact-JID search scan this narrow table in timestamp/rowid descending order, with offset/limit applied before fetching SDK bodies for the selected page. Worst-case matching remains linear in searchable text. Pagination still observes a changing local store, not a snapshot.
- `message_history(jid,timestamp)` supplies history ordering by reverse index scan; SQLite's implicit rowid gives the existing descending tie break. Equivalent global and per-JID text indexes avoid sorting the full search result.
- `request_message_id` indexes the immutable message ID expression in request JSON. Receipt correlation decodes only candidates with that ID, then applies the existing exact destination/route, direction, participant and monotonic status rules. Identity evidence is never used to rewrite an intent or guess a receipt route.

FTS5/trigram is available in the measured Node build. The narrow scan is deliberately simpler: it preserves all substring cases with one implementation, and the synthetic results below already remove the dominant decode cost. FTS is deferred until a measured workload justifies candidate indexing plus exact verification and short-input fallback.

Body replacement, search-row replacement/removal and tombstones share a synchronous SQLite transaction, joining the surrounding runtime event transaction when present. Updates retain the existing rowid replacement/order behavior. Deletion/revocation/boundary checks remain authoritative for history, quotes, media and SDK getMessage. Audit and immutable send intents cannot restore current content.

Operation completion also commits the returned body/projection, request outcome and journal entry together. A local write failure rolls back that completion and reaches the command caller as an error; it is not caught as an SDK failure. The previously committed intent and independently observed receipts remain intact, with no retry authorization. Batched `chats.delete` observations remove the exact chat snapshots and append their journal entry in one transaction; a failure rolls back the whole event before the existing fail-closed exit. Message history remains stored.

Chat filtering retains its existing AND tri-state/pending semantics and maximum activity provenance; it is included in the benchmark without an additional chat projection or cache.

## Schema and upgrade

Schema `PRAGMA user_version=1` is an additive upgrade from the version-0 repository schema. Startup under the writer lock runs existing identity/deletion/activity recovery first, streams current message rows into `message_text`, builds query indexes and commits the backfill plus version atomically. It preserves message rowids, requests, IDs, routes, authentication and audit records. Projection ordering uses the existing SQLite JID/timestamp columns, including full protobuf Long timestamps, rather than recomputing metadata from decoded JSON. A failed query backfill rolls back and fails startup; it does not reset state or start a socket. Subsequent starts skip the completed backfill.

No import/conversion command or complete historical migration guarantee is provided. Do not edit Store tables directly or run an older runtime against an upgraded directory: older writers do not maintain this projection. Upgrade the runtime and CLI together after the existing runtime has exited normally; building alone does not replace a running daemon. Future/unsupported schema versions fail with an instruction to use a compatible executable or a **NEW `--data-dir`**, preserving the old database. No automatic deletion, re-pairing, parallel account session or intent recreation occurs.

A fresh directory is also supported. Pairing a new session requires separate account authorization, and reconnection/re-pairing cannot guarantee complete history recovery. This feature was verified only with generated offline data.

## Reproducible benchmark

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm benchmark:store --output .tmp/store-query-results.json
```

The driver extracts only versioned source from exact base `9a7f36297b416a0953983e8bb58a0794c85269f6` into its own ignored scratch directory, builds with the same installed TypeScript/dependencies and runs that original Store implementation. Only the compiler include/root directory is adjusted for the source-only extraction. It neither creates a worktree nor reads any account directory. Candidate code comes from the fresh build. Generated source/build scratch and reports remain in `.tmp/store-bench-*`; SQLite fixtures use a separate new OS temporary root recorded as `retainedState`, so group-writable source ancestors cannot compromise state. The script does not delete either.

Volumes are 22,973 and 68,919 messages in 726 fictional conversations, with 5,000 and 15,000 requests. Deterministic mixed text, wrapped captions, audio, long excluded quoted contexts, tied timestamps, exact PN/LID/group IDs and a busy conversation exercise the relevant costs. Fixtures use no random/account/wall-clock inputs; SHA256 equality of seeded messages/requests and every benchmark query result is asserted between implementations, before and after mutations. Chat metadata observation times are omitted from comparison.

All phases and variants run sequentially in separate Node processes. Ingestion is one history-sized transaction. Query processes never generate/ingest the history. Each query has one first invocation and six subsequent calls; reports give first latency and warm min/median/max with n. “First” means process/Store first invocation per scenario; OS page cache is uncontrolled and warmed by seed/earlier phases. No forced GC or claims of cold-disk performance. Only the first scenario is also the first query in that process.

Queries include global misses/results, Unicode, one/two-character terms, excluded context, exact-JID misses/results, ordered history, AND/unknown chat filters and receipts. Query timings include safe message projections. Five rounds measure 50 edits, 50 deletions and one standalone insert; a new process checks queries after restart. A separate candidate process times additive upgrade on a closed copy of this run's generated baseline DB. Single ingestion/upgrade observations are n=1, not distributions.

Memory reports use each child process's own RSS high-water mark (including imports), and RSS/heap snapshots between calls; heap snapshots are not a true heap peak. Disk reports use checkpointed file bytes and `dbstat` allocated pages by table/index before/after mutation, with no VACUUM. CLI `help` measures Node/CLI startup separately (one first plus six subsequent processes); direct Store timings exclude CLI, Unix socket and daemon startup. Removing a SQL cost does not remove those costs.

These fixtures expose scaling and tradeoffs, not account-specific performance, leaks, delivery, complete history, sustained concurrency or live WhatsApp behavior. The coordinator must perform any real-data offline comparison separately, outside workers/worktrees.

## Recorded synthetic results

Run `2026-10-19T20:34:37.728Z`; measured Store implementation `3deb998cd22bdb4dde9cfdaa7f3121685d9573f5` after the Long-timestamp backfill correction, against the exact base above. Node v24.18.0, pnpm 10.24.0, TypeScript 5.9.3, Baileys 7.0.0-rc14, SQLite 3.53.1, Linux x64. The recorded run was sequential with no other worker tests/builds running. [Full report](store-query-results.json) includes first-call timings, restart queries, memory snapshots, query plans, fixture/result hashes and per-index bytes. Local scratch paths are omitted in the repository copy.

Warm latency cells are **min / median / max milliseconds, n=6**. These are direct Store calls including safe message output.

### 22,973 messages, 726 chats, 5,000 requests

| Query | Base ms | Candidate ms |
| --- | ---: | ---: |
| global-miss | 170.854 / 174.116 / 319.816 | 4.099 / 4.137 / 4.712 |
| global-result | 210.951 / 211.981 / 213.931 | 0.635 / 0.712 / 2.163 |
| unicode | 178.465 / 179.474 / 184.499 | 0.606 / 0.631 / 0.685 |
| short-1 | 177.517 / 180.070 / 301.983 | 0.700 / 0.707 / 0.736 |
| short-2 | 177.345 / 179.208 / 181.900 | 0.686 / 0.739 / 0.920 |
| excluded-context | 173.076 / 174.636 / 176.251 | 4.678 / 4.707 / 4.882 |
| jid-miss | 38.882 / 39.509 / 40.415 | 1.324 / 1.377 / 1.428 |
| jid-result | 43.861 / 44.826 / 45.757 | 0.590 / 0.628 / 0.680 |
| history | 8.527 / 8.623 / 8.949 | 0.525 / 0.540 / 0.552 |
| chats-filtered | 2.275 / 2.340 / 2.386 | 2.436 / 2.534 / 2.558 |
| chats-unknown | 2.210 / 2.245 / 2.260 | 2.356 / 2.375 / 3.331 |
| receipt | 21.773 / 28.667 / 76.784 | 1.856 / 1.968 / 2.056 |

| Resource / work | Base | Candidate |
| --- | ---: | ---: |
| Query process peak RSS, MiB | 477.961 | 115.164 |
| Maximum sampled query heap, MiB | 273.955 | 28.781 |
| Checkpointed files before mutation, MiB | 29.730 | 35.176 |
| Checkpointed files after mutation, MiB | 29.730 | 35.176 |
| Bulk ingest, ms (n=1) | 1323.212 | 1495.495 |
| Store open before queries, ms (n=1) | 0.686 | 1.145 |
| Store reopen after mutations, ms (n=1) | 0.651 | 0.733 |
| 50 edits, ms (min/median/max, n=5) | 11.133 / 13.549 / 18.095 | 13.758 / 24.941 / 32.308 |
| 50 deletes, ms (min/median/max, n=5) | 4.433 / 6.835 / 9.985 | 4.043 / 13.196 / 27.402 |
| Standalone insert, ms (min/median/max, n=5) | 4.058 / 4.410 / 4.866 | 2.407 / 2.967 / 6.047 |

Candidate additive upgrade: **566.3 ms, n=1** on this volume's closed, generated baseline DB after mutations; peak RSS 121.2 MiB. Generated mean/max message JSON: 1007.6 / 448,410 bytes.

### 68,919 messages, 726 chats, 15,000 requests

| Query | Base ms | Candidate ms |
| --- | ---: | ---: |
| global-miss | 549.992 / 563.253 / 574.038 | 14.383 / 14.431 / 14.850 |
| global-result | 662.561 / 670.549 / 815.317 | 0.694 / 0.737 / 2.418 |
| unicode | 546.477 / 563.821 / 816.876 | 0.651 / 0.673 / 0.725 |
| short-1 | 538.873 / 552.556 / 573.565 | 0.690 / 0.711 / 0.773 |
| short-2 | 546.936 / 569.132 / 664.915 | 0.690 / 0.741 / 0.944 |
| excluded-context | 550.588 / 556.454 / 564.344 | 14.889 / 15.011 / 15.322 |
| jid-miss | 119.533 / 121.168 / 123.304 | 4.230 / 4.247 / 4.266 |
| jid-result | 142.624 / 143.063 / 145.176 | 0.586 / 0.631 / 0.692 |
| history | 34.720 / 35.097 / 35.637 | 0.529 / 0.538 / 0.543 |
| chats-filtered | 2.362 / 2.465 / 2.499 | 2.544 / 2.606 / 3.723 |
| chats-unknown | 2.212 / 2.242 / 2.312 | 2.429 / 2.444 / 3.454 |
| receipt | 67.958 / 69.172 / 69.634 | 1.806 / 1.928 / 2.151 |

| Resource / work | Base | Candidate |
| --- | ---: | ---: |
| Query process peak RSS, MiB | 690.859 | 116.727 |
| Maximum sampled query heap, MiB | 414.055 | 28.698 |
| Checkpointed files before mutation, MiB | 88.203 | 104.602 |
| Checkpointed files after mutation, MiB | 88.203 | 104.602 |
| Bulk ingest, ms (n=1) | 3166.760 | 4286.751 |
| Store open before queries, ms (n=1) | 0.663 | 0.771 |
| Store reopen after mutations, ms (n=1) | 2.300 | 0.777 |
| 50 edits, ms (min/median/max, n=5) | 10.496 / 13.219 / 18.421 | 10.385 / 14.177 / 27.642 |
| 50 deletes, ms (min/median/max, n=5) | 4.047 / 6.358 / 9.964 | 4.707 / 7.017 / 13.128 |
| Standalone insert, ms (min/median/max, n=5) | 3.880 / 4.208 / 6.654 | 1.813 / 2.643 / 3.061 |

Candidate additive upgrade: **1508.4 ms, n=1** on this volume's closed, generated baseline DB after mutations; peak RSS 155.5 MiB. Generated mean/max message JSON: 995.9 / 448,662 bytes.

### Interpretation and limits

Global misses improved about 42× at 23k and 39× at 69k; the scan remains linear. History no longer uses a temporary B-tree, and receipt candidates use the message-ID index. Matching searches stop at the selected page without decoding unrelated SDK bodies. These gains justify retaining the simple scan instead of adding FTS candidate machinery.

The tradeoff is **18.3% / 18.6% more file space** at 23k / 69k. Bulk ingestion increased **13.0% / 35.4%** in this run (single samples, not stable throughput estimates). Earlier same-fixture samples also varied (roughly 5–21% / 46–54% overhead before the backfill correction), so do not infer a precise ingestion penalty from one sample. Edit/delete batch and standalone-write distributions are reported above; an entire observation now commits once rather than using several autocommits.

The unchanged chat algorithm had a slower 23k sample in the previous run (filtered median 12.46 ms versus 2.42 ms). A focused fresh-process follow-up on those same generated DBs, with no preceding message searches and 20 warm calls, measured 2.46 versus 2.41 ms (AND filter), and 2.28 versus 2.25 ms (unknown filter). The final run above did not reproduce that large variation. This does not establish its cause or a chat speedup; the previous observation and follow-up remain in the report.

CLI help startup is separate: warm min/median/max, n=6, baseline **118.770 / 120.509 / 125.320 ms**, candidate **119.137 / 124.089 / 146.599 ms**. Its roughly 120–130 ms cost remains. No real daemon/Unix-socket/WhatsApp timing was measured by this benchmark.

All 123 prior tests plus 9 Store regressions passed, including Long timestamps/ordering/pagination through backfill/restart. Benchmark timestamps use ordinary numeric seconds; the separate regression exercises protobuf Long serialization. No account, credentials, private snapshot, real SDK connection, downstream repository or live confirmation was accessed. Real-data offline comparison remains the coordinator’s separate work.
