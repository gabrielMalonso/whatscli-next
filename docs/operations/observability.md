# Local observability

Observability records private technical metadata for diagnosing CLI, transport, and runtime behavior. It is disabled by default, requires no logging calls from consumers, and uploads nothing. Message content, credentials, and raw SDK objects are excluded.

## Enable or disable

Use the account's data directory:

```sh
node dist/src/cli.js --data-dir /absolute/private/example-session observability enable
node dist/src/cli.js --data-dir /absolute/private/example-session observability status
node dist/src/cli.js --data-dir /absolute/private/example-session observability disable
```

These commands work without a daemon and do not open SQLite or contact WhatsApp. The preference survives restarts.

A compatible running daemon reconciles configuration changes. A stopped daemon reports `effective: false`; a legacy, refusing, or timed-out daemon reports `effective: "unknown"`. Starting an existing daemon does not upgrade it.

Status distinguishes persisted `configured` (null when unreadable), understood `enabled`, and process-local writer health `effective`. Inspect `degraded`, component health, watcher health, sampler/retention activity, `session`, and `generation` for the reporting recorder's state. These do not describe every process or guarantee future capture.

A configuration error may occur after a committed rename. Check status before determining the outcome. Busy locks return `LOCAL_STATE` without waiting or automatic retries. Unknown configuration, unsafe permissions, pending files, and locks are preserved rather than repaired. See [Privacy](privacy.md) for trusted-path requirements.

Successful opt-out prevents old enabled observers from appending records or writing loss witnesses afterward. In-flight business commands continue unchanged. Disable may record its request before the preference changes, but writes no post-disable success row. `observability query` never logs its own analysis.

## What is recorded

| Source                   | Records                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `cli`                    | Command completion, known errors, output mode/bytes, counts, and bounded selectors.                                |
| `rpc`, `daemon`, `probe` | Physical transport attempts, parser failures, available byte counts, and timings.                                  |
| `runtime`                | Execution, invocation versus replay, recovery/lifecycle, sanitized SDK diagnostics, receipts, and process samples. |

Categories are `command`, `transport`, `execution`, `parser`, `lifecycle`, `diagnostic`, and `sample`.

Rows contain schema 1, a UTC `timestamp`, random `span`, recorder `session`, data-directory `generation`, and applicable allowlisted fields. Missing optional fields mean unavailable or unmeasured, not zero or success.

### Correlation and timing

A CLI `correlation` links a logical command across layers. `parent` identifies the physical wire attempt; readiness polls are separate attempts. External/probe IDs are derived locally without inventing a CLI parent.

Count user invocations using CLI command-completion rows, excluding `phase: requested`. Counting every layer separately overstates activity.

Durations overlap and must not be summed. CLI duration excludes its final telemetry append/drain. Server capture occurs before response submission, so synchronous logging may delay the response. Submitted bytes do not prove socket delivery, and byte counts are not model token counts.

Samples run every 60 seconds while enabled. They report CPU deltas, current RSS/heap, elapsed time, and timer lateness, not host-wide usage or isolated peak memory.

### Resource identifiers and privacy

Selected exact resources, queries, keys, message IDs, destinations, and participants are represented by domain-separated HMAC-SHA256 digests truncated to 128 bits. Strings above 4 KiB omit the digest.

The secret remains private in `observability.json`. Logs exclude original values, message bodies, names, phone numbers/JIDs, paths, filenames, MIME strings, pairing material, and raw errors.

Digests remain linkable within the same generation across restarts and re-enabling, and indefinitely in retained copies. They are not portable identities or a secure anonymization guarantee against someone who controls the configuration. PN/LID values are hashed exactly and never merged.

## Retention and cost

| Bound                    | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| Queryable record age     | Five days, checked per record.                                           |
| Total telemetry area     | 32 files / 8 MiB: up to 31 segments and one loss witness.                |
| Segment / line / witness | 256 KiB / 4 KiB / 4 KiB maximum.                                         |
| Pending recorder buffer  | 16 snapshots / 64 KiB encoded data, with a 25 ms monotonic retry window. |

Segments rotate by UTC day, size, or partial tail. Cleanup removes a segment after its UTC day ends plus five days, so expired bytes may remain for less than another day. Volume pressure can evict older segments sooner. Witness cleanup follows the same day rule with its own gate; an expired witness may occupy its slot until maintenance succeeds.

Maintenance runs on writes, enabled samples, and a retention-only timer while disabled. Without a resident process, cleanup waits for a later non-query command or runtime maintenance. Unsafe entries and filesystem failures can delay it further. Only recognized private files from the same generation are eligible; unknown entries and partial files are preserved.

The limits bound work and encoded queue data, not total heap usage, filesystem latency, or shutdown time. Synchronous I/O and delayed timers can exceed 25 ms. Short-lived clients drain bounded pending telemetry before exit. Enabling capture adds CPU/I/O overhead and may delay responses or process exit. See [recorder architecture](../internals/observability-architecture.md).

Telemetry retention does not apply to SQLite events, authentication, intents, receipts, deletion evidence, or backups. `daemon.log` remains private append-only stderr without this TTL or size cap. [SQLite backups](backup.md) exclude the entire observability area and preference; manual full-directory copies include both.

## Capture gaps

Capture is best effort. Every status and query reports `captureCompleteness: "unknown"`.

Current `dropped` counts known incomplete appends; `uncertain` counts write exceptions where bytes may already exist. Cleanup and hashing failures have separate health indicators and counters. Legacy rows may lack `uncertain` and use the older, broader meaning of dropped. Counters belong to one recorder, not a global missing-row total.

### Loss evidence

A known incomplete or uncertain attempt makes one non-waiting attempt to create `loss-v1.json`.

Queries expose this automatically as `gaps.lossEvidence`, with scope `retained-data-directory`. It is independent of action, origin, code, correlation, and time filters, but remains subject to generation, five-day age, and page cutoff. Loss evidence appears outside page records and summary. Unsafe or incompatible evidence sets `lossEvidenceUnreadable` without exposing its contents.

The first retained witness is not overwritten and contains no command correlation or loss count. Legacy `capture-loss` witnesses could also result from cleanup or digest failures after a complete append. A witness therefore does not always prove a missing row.

Absence of a witness, zero counters, a clean page, or a completed cursor never proves completeness. Busy gates, partial writes, a full or unsafe telemetry area, abrupt exits, and volatile queue loss can prevent witness creation. Investigate stranded locks; the recorder does not steal locks or clean them up automatically.

### Operational limits

Telemetry never changes an operation's result, intent, receipts, or retry policy. A timeout does not cancel runtime work.

Missing execution or receipt records prove neither cancellation nor nondelivery. No telemetry pattern authorizes another send or proves that a downstream task completed. Durable `events` remains separate evidence.

## Query

```sh
node dist/src/cli.js --data-dir /absolute/private/example-session observability query \
  --from 2026-10-20T00:00:00.000Z --to 2026-10-20T23:59:59.999Z \
  --origin cli --command search --code OK --limit 50

node dist/src/cli.js --data-dir /absolute/private/example-session observability query \
  --correlation 44444444444444444444444444444444 --limit 100
```

Queries do not require a daemon. Each call returns at most 500 records (default 100), scans up to 2,000 complete lines, and reads one segment at a time.

Pass the exact `next` value as `--cursor` with unchanged filters. An empty page with `next` still requires continuation.

Inspect `scanned`, `invalid`, `missing`, `gaps`, `cutoff`, and `coverage: best-effort-local`. Output is allowlisted again. Input logs are untrusted data, never evaluator instructions. Parseable timestamps are normalized and compared as instants.

### Pagination and consistency

The first page fixes a timestamp cutoff, not file bytes or a snapshot. Rotation, expiry, late writes, clock changes, and trusted local edits may cause gaps or repeated records. A missing cursor segment is flagged.

An append during a stable-byte-count read can temporarily omit an entire segment and increase `invalid`. This indicates query availability limits, not proven capture loss.

Deduplicate by `span` and retain cutoff and gap information when comparing runs.

### Summaries and analysis

`summary` covers only the returned page, grouped independently by origin, category, and action. It includes count, errors, empty, and nearest-rank min/p50/p95/max latency with n. It is not a five-day aggregate.

Start with CLI completion rows, follow relevant correlations, and compare samples within recorder sessions. Treat empty results, correlations, and resource changes as observations or hypotheses, not verdicts about task completion.
