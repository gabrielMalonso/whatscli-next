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

## Recorded synthetic results

Run `2026-10-19T20:26:05.909Z`; measured Store implementation `bc300f1eff311e19ea41ffcc581a4a5d45fe71fa` against the exact base above. Node v24.18.0, pnpm 10.24.0, TypeScript 5.9.3, Baileys 7.0.0-rc14, SQLite 3.53.1, Linux x64. A preliminary full run established the same broad search/memory trend; the recorded run below was sequential with no other worker tests/builds running. [Full report](store-query-results.json) includes first-call timings, restart queries, memory snapshots, query plans, fixture/result hashes and per-index bytes. Local scratch paths are omitted in the repository copy.

Warm latency cells are **min / median / max milliseconds, n=6**. These are direct Store calls including safe message output.

### 22,973 messages, 726 chats, 5,000 requests

| Query | Base ms | Candidate ms |
| --- | ---: | ---: |
| global-miss | 172.304 / 179.529 / 327.247 | 4.359 / 4.463 / 4.472 |
| global-result | 213.302 / 215.395 / 289.749 | 0.654 / 0.706 / 0.731 |
| unicode | 182.783 / 186.518 / 302.041 | 0.628 / 0.638 / 0.756 |
| short-1 | 187.756 / 188.089 / 189.684 | 0.649 / 0.689 / 0.751 |
| short-2 | 187.158 / 187.705 / 191.199 | 0.661 / 0.696 / 0.882 |
| excluded-context | 182.048 / 183.192 / 184.405 | 4.547 / 4.588 / 4.712 |
| jid-miss | 41.149 / 41.806 / 42.462 | 1.284 / 1.314 / 1.329 |
| jid-result | 46.570 / 47.255 / 48.175 | 0.530 / 0.586 / 0.670 |
| history | 8.959 / 9.076 / 9.439 | 0.488 / 0.501 / 0.540 |
| chats-filtered | 2.412 / 2.416 / 2.508 | 4.670 / 12.457 / 18.857 |
| chats-unknown | 2.311 / 2.343 / 2.382 | 5.673 / 9.547 / 13.336 |
| receipt | 23.515 / 29.631 / 85.082 | 2.402 / 2.477 / 2.613 |

| Resource / work | Base | Candidate |
| --- | ---: | ---: |
| Query process peak RSS, MiB | 478.668 | 115.367 |
| Maximum sampled query heap, MiB | 273.725 | 28.810 |
| Checkpointed files before mutation, MiB | 29.730 | 35.176 |
| Checkpointed files after mutation, MiB | 29.730 | 35.176 |
| Bulk ingest, ms (n=1) | 1291.891 | 1351.305 |
| Store open before queries, ms (n=1) | 0.637 | 0.756 |
| Store reopen after mutations, ms (n=1) | 0.949 | 0.727 |
| 50 edits, ms (min/median/max, n=5) | 13.516 / 14.391 / 23.766 | 10.518 / 14.368 / 15.919 |
| 50 deletes, ms (min/median/max, n=5) | 5.230 / 8.311 / 13.464 | 4.460 / 6.192 / 8.096 |
| Standalone insert, ms (min/median/max, n=5) | 4.259 / 4.794 / 5.580 | 2.319 / 2.477 / 2.600 |

Candidate additive upgrade: **408.2 ms, n=1** on this volume's closed, generated baseline DB after mutations; peak RSS 123.0 MiB. Generated mean/max message JSON: 1007.6 / 448,410 bytes.

### 68,919 messages, 726 chats, 15,000 requests

| Query | Base ms | Candidate ms |
| --- | ---: | ---: |
| global-miss | 537.939 / 542.327 / 548.210 | 14.386 / 14.615 / 15.024 |
| global-result | 632.178 / 651.977 / 796.323 | 0.692 / 0.737 / 0.805 |
| unicode | 540.475 / 541.456 / 546.151 | 0.667 / 0.685 / 0.755 |
| short-1 | 541.055 / 543.130 / 556.198 | 0.695 / 0.742 / 0.793 |
| short-2 | 541.095 / 543.525 / 548.519 | 0.697 / 0.779 / 0.952 |
| excluded-context | 532.470 / 533.346 / 541.334 | 15.129 / 15.214 / 15.428 |
| jid-miss | 118.082 / 118.671 / 119.981 | 4.181 / 4.235 / 4.289 |
| jid-result | 137.670 / 137.785 / 138.958 | 0.592 / 0.631 / 0.688 |
| history | 33.170 / 33.700 / 33.917 | 0.523 / 0.540 / 0.552 |
| chats-filtered | 2.305 / 2.340 / 3.494 | 2.551 / 2.604 / 3.763 |
| chats-unknown | 2.151 / 2.215 / 2.233 | 2.471 / 2.479 / 3.200 |
| receipt | 64.533 / 65.915 / 132.347 | 1.890 / 2.187 / 2.527 |

| Resource / work | Base | Candidate |
| --- | ---: | ---: |
| Query process peak RSS, MiB | 707.773 | 116.574 |
| Maximum sampled query heap, MiB | 472.219 | 28.747 |
| Checkpointed files before mutation, MiB | 88.203 | 104.602 |
| Checkpointed files after mutation, MiB | 88.203 | 104.602 |
| Bulk ingest, ms (n=1) | 2967.039 | 4344.348 |
| Store open before queries, ms (n=1) | 0.646 | 0.800 |
| Store reopen after mutations, ms (n=1) | 0.667 | 0.769 |
| 50 edits, ms (min/median/max, n=5) | 12.389 / 14.762 / 20.257 | 12.198 / 14.794 / 17.785 |
| 50 deletes, ms (min/median/max, n=5) | 5.192 / 7.312 / 11.458 | 5.053 / 7.255 / 9.449 |
| Standalone insert, ms (min/median/max, n=5) | 4.015 / 4.929 / 5.029 | 2.321 / 2.420 / 2.789 |

Candidate additive upgrade: **1194.5 ms, n=1** on this volume's closed, generated baseline DB after mutations; peak RSS 156.9 MiB. Generated mean/max message JSON: 995.9 / 448,662 bytes.

### Interpretation and limits

Global misses improved about 40× at 23k and 37× at 69k; the scan remains linear. History no longer uses a temporary B-tree, and receipt candidates use the message-ID index. Matching searches stop at the selected page without decoding unrelated SDK bodies. These gains justify retaining the simple scan instead of adding FTS candidate machinery.

The tradeoff is about **18.6% more allocated/file space**. Bulk ingestion increased about **4.6% at 23k and 46.4% at 69k** in this run (single samples, not stable throughput estimates). The preliminary run showed roughly 21% / 54% overhead, so do not infer a precise ingestion penalty from one sample. Edit/delete batch medians were similar here; standalone writes also change because the whole observation now commits once rather than using several autocommits.

The unchanged chat algorithm had a slower 23k full-sequence sample (filtered median 12.46 ms versus 2.42 ms). A focused fresh-process follow-up on the same generated DBs, with no preceding message searches and 20 warm calls, measured 2.46 versus 2.41 ms (AND filter), and 2.28 versus 2.25 ms (unknown filter). The 69k sequence measured 2.60 versus 2.34 ms. This does not establish the cause of the isolated variation or a chat speedup; both results are retained in the report.

CLI help startup is separate: warm min/median/max, n=6, baseline **119.861 / 121.754 / 130.089 ms**, candidate **115.860 / 129.995 / 139.714 ms**. Its roughly 120–130 ms cost remains. No real daemon/Unix-socket/WhatsApp timing was measured by this benchmark.

All 123 prior tests plus 8 Store regressions passed at this implementation. No account, credentials, private snapshot, real SDK connection, downstream repository or live confirmation was accessed. Real-data offline comparison remains the coordinator’s separate work.
