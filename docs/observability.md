# Persistent, local opt-in observability

New data directories have observability **off**. Enable once for the selected directory; the preference survives CLI exit and normal daemon stop/start:

```sh
node dist/src/cli.js --data-dir /absolute/private/example-session observability enable
node dist/src/cli.js --data-dir /absolute/private/example-session observability status
node dist/src/cli.js --data-dir /absolute/private/example-session observability disable
```

These commands work while stopped and do not open SQLite, pair, connect to WhatsApp or start a daemon. Ordinary consumers keep using the existing commands without logging calls, extra prompts or success reports. Nothing is uploaded. Full/compact response content and error/exit behavior remain the same, with additive observability diagnostics in `status.data.observability`.

Configuration is an owned 0600 `observability.json` in the selected private data directory. Its versioned preference, generation and random local HMAC secret are atomically replaced through one exclusively created pending file, synchronized before rename. Concurrent updates either serialize through the tiny non-waiting critical section or return `LOCAL_STATE`; there is no silent lost update or retry. A failure can leave a pending file, or a preference already renamed before cleanup failed: inspect status; the error explicitly says persistence may have happened. Existing unknown/incompatible configuration, permissions, pending files and locks are preserved. The secret is never returned by status/query or copied into telemetry.

The runtime watches the data directory for preference replacement and rechecks at command admission and immediately before each log write. `enable`/`disable` also asks an existing compatible daemon to reconcile before reporting its state. A disable cannot race a log append past the configuration commit: both use the same short critical section. An already executing command continues with its original semantics; it does not produce new telemetry after disable. The sampler stops on reconciliation, including shutdown. A file-notification failure is exposed as `preferenceWatchDegraded`; command admission still reconciles and a sample always rechecks before writing.

`configured` is the persisted preference (`null` if unreadable/incompatible), `enabled` is this build's understood preference, and `effective` is this process's current best-effort writer health. `degraded`, process-local dropped/expired/evicted counters, `samplerActive`, `retentionActive` and watcher health expose limits. These are observations, not a future write guarantee. The local configuration command reports a stopped daemon as `effective: false`, or a legacy/refusing/timed-out daemon as `effective: "unknown"`; it never attributes support to an old process. CLI capture can still be enabled while that daemon's execution capture is unknown. The nested `daemon` field keeps the responding process's own assessment. Building a newer CLI does not upgrade a daemon.

There is no environment-variable opt-in, global preference, SQLite schema change or operational ownership change. OFF still costs a small preference read and existing private-path checks at capture boundaries; a running runtime also has one nonpersistent filesystem watcher. Missing/default-off configuration creates no telemetry files, sampler or retention timer. Disable writes a request observation **before** changing the preference if currently on, without a success claim; its final result is not logged after it turns capture off. Configuration/status calls are observable; `observability query` is excluded at every layer so analysis cannot feed itself.

## Layout, bounds and failure policy

```text
example-session/
  observability.json                persistent preference + private HMAC secret
  observability.lock/               short critical section; normally absent
  observability.pending.json        only during config update; preserve a remnant
  observability/
    v1-<UTC milliseconds>-<UUID>.jsonl
```

There is one chronological stream with explicit `origin`/`category`, shared by short clients and the runtime. A client does not get its own file. Segments rotate at 256 KiB or after 30 minutes, and each complete JSONL line is at most 4 KiB. The directory admits at most **32 segments / 8 MiB**; the in-memory write queue is **zero**. Files are opened/appended/closed within a synchronous filesystem critical section, never held open across rotation or expiration. Each record does bounded metadata/header inspection of at most 32 entries and one small append; request/response bodies are not serialized again for logging. Filesystem I/O is synchronous: work/counts are bounded, not an operating-system I/O deadline. Slow or stalled filesystems can add latency; use local storage and the measured limits below, without a zero-overhead claim.

Expiry is **five days from segment creation**, evaluated against UTC wall time. A segment can contain up to 30 minutes of younger entries, so those may be evicted early. The byte/file cap can evict the oldest recognized segment earlier still. Clocks moving affect the cutoff; monotonic duration measurements are separate. Expiry runs on enabled writes and 60-second process samples, and a retention-only timer handles existing logs while disabled (no CPU/RAM sampling or new logs). With no resident process, physical expiration is deferred to the next non-query CLI invocation/runtime maintenance. Queries always exclude expired segments even before physical removal. No tool can remove files at a wall-clock deadline while no process runs.

The critical section uses exclusive `mkdir`, never waits or retries, and always removes only its own empty lock on ordinary completion. Contention drops that observation. There is deliberately no PID probing, lease/heartbeat, lock stealing, background job or recovery cleanup. An abrupt exit inside the section can leave a lock and block further capture/configuration until the owner investigates it; normal stop/start preserves capture. Unknown lock contents are never removed. This conservative failure mode preserves ordinary WhatsApp operations and existing state, with `degraded` status and a fixed safe stderr warning. It is a real capture limitation.

TTL/cap removal is confined to the new area and recognized schema-1/generated filenames, private regular files with one link, and a matching local generation. Unknown entries, symlinks, hardlinks, invalid first-line headers and unsafe paths cause degradation and are preserved. Namespace admission uses the existing trusted-ancestor/0700/0600 rules; it never repairs permissions or follows symlinks. Same UID/root remain trusted; this is not isolation, encryption or an authenticity claim. Directory iteration, record size, scan size and segment count are bounded even on foreign input.

A partial tail is preserved and a later append rotates away from it. A failed first write can leave an empty/unrecognized segment; it is preserved and capture degrades instead of deleting an unproven file. Corrupt complete lines in a recognized segment are skipped by query without echoing their content. Unknown headers/namespace entries make the query fail safely. Readers never consume an unterminated line as evidence. A reader racing expiry can lose a segment; pagination/cutoff is bounded best effort, not a snapshot or durable cursor.

Write, retention, hashing or sampler failure cannot change a send intent, receipt, command result, original error or retry behavior. Failed capture has a fixed `OBSERVABILITY_DEGRADED` stderr warning, no exception/body/stack fallback. `dropped` on a later successful record reports that recorder's preceding lost observations. Status counters are per process/recorder; short clients that exit without a successful write can leave **unquantified losses**, so neither a clean page nor zero counters proves complete capture. Evicted/expired counts describe that successful maintenance pass; a crash or failed pass can leave additional unquantified gaps. There is no persistent work queue or shutdown drain: the bounded synchronous append is finished before returning, timers/watchers stop before operational shutdown waits, and the SQLite writer lock retains its existing mandatory cleanup order.

**Other files keep their existing policies.** `daemon.log` remains private sanitized stderr and append-only, without this five-day TTL/cap. Essential SQLite `events`, intents, receipts, auth, tombstones, identity/recovery evidence and backups have no telemetry TTL. The existing SQLite-only backup excludes this entire area, preference, log, lock and pending configuration. A full-directory manual backup naturally includes them and remains a separately explicit operation.

## Schema and correlation

Each line has `schema: 1`, UTC ISO `timestamp`, `origin`, `category`, random `span`, recorder `session`, data-dir `generation`, and `dropped`/`expired`/`evicted`. Optional fields are allowlisted; absence means unavailable/unmeasured, never zero/success. For example, these are fictional observations:

```json
{"schema":1,"timestamp":"2026-10-20T12:00:00.000Z","origin":"cli","category":"command","span":"11111111111111111111111111111111","session":"22222222222222222222222222222222","generation":"33333333333333333333333333333333","correlation":"44444444444444444444444444444444","action":"search","durationMs":52.3,"stdoutBytes":160,"count":0,"empty":true,"output":"compact","ok":true,"code":"OK","dropped":0,"expired":0,"evicted":0}
```

| Fields | Meaning and limit |
| --- | --- |
| `origin` | `cli` total command; `rpc` client physical transport; `daemon` server socket; `probe` JSONL transport; `runtime` execution/observations/samples |
| `category` | `command`, `transport`, `execution`, `parser`, `lifecycle`, `diagnostic`, `sample` |
| `correlation`, `parent` | One CLI command root; a distinct physical wire attempt. The existing wire `id` carries two random components, no new body fields. `parent` is the derived full wire id shared by client/server/runtime. Arbitrary external/probe ids are derived locally and do not claim a CLI parent. |
| `action`, `operation`, `phase` | Recognized action; observability enable/disable/status; `phase: requested` is a pre-disable request, not completion |
| `durationMs` | Monotonic wall duration at that boundary. CLI total includes command processing/formatting, excludes its final telemetry append; RPC includes preflight/serialization/socket/JSON decoding, excludes final logging; server includes waiting for the line and execution; runtime includes execution. These overlap and must not be summed. No invented separate one-way network or SDK-only duration. |
| `requestBytes`, `responseBytes`, `stdoutBytes` | Client submitted UTF-8 request bytes and actual socket bytes read; server request bytes read and serialized response bytes submitted (zero if already disconnected); CLI actual encoded output bytes including newline; probe line bytes exclude input newline. Submission is not socket delivery. Bytes are not tokens or exact model-context cost. |
| `count`, `empty`, `limit`, `offset`, `after`, `unread`, `archived`, `output`, `quoted`, `value` | Public result array count/null absence, bounded pagination and tri-state filters, presentation/operation shape. Empty is a valid local observation; no task-success/comprehension judgment. |
| `ok`, `code`, `attempt`, `errorObserved`, `acceptance`, `delivery`, `read` | Known command code and separate existing operation/receipt evidence; unrecognized error codes become `UNKNOWN` in telemetry while ordinary responses still forward them. `ok: true` can contain `attempt: uncertain`. |
| `invoked`, `replay` | Actual operation callback invocation versus existing immutable-intent replay at the runtime. Replays do not become new SDK attempts; `request` only inspects evidence. Concurrent replay can return uncertain while the original continues. |
| `resource`, `query`, `key`, `message`, `destination`, `participant` | Domain-separated HMAC-SHA256 truncated to 128 bits of exact selected strings, with the private data-dir random secret. Maximum selected input 4 KiB; larger selectors omit the digest. No original input is stored. Message observations must be joined with exact derived destination/direction/participant when available; message id alone cannot establish identity. |
| `connection`, `recovery`, `coverage`, `appState`, `build` | Recognized local states and loaded runtime build fingerprint/null. A newer CLI cannot change the daemon's label. Local/partial/unknown remains the evidence boundary; missing build stays unknown. |
| `label`, `issue` | Fixed lifecycle/dependency/SDK/connection/receipt labels and bounded sync/decryption issue categories. Arbitrary SDK warning text and fields are discarded. |
| `elapsedMs`, `cpuUserUs`, `cpuSystemUs`, `rssBytes`, `heapBytes`, `lagMs` | Samples every 60 seconds while enabled: CPU deltas over monotonic elapsed time, **current RSS**, current heap used and nonnegative timer lateness. No maxRSS, post-exec isolated peak, forced GC, external process or host-wide CPU/RAM claim. |

HMACs permit equality grouping across clients/restarts of the **same data-dir generation**, including re-enable. They deliberately remain linkable longer than the retention window if an operator retains copies: there is no automatic key rotation or crypto-isolation claim. Another data directory has an independent secret; digests are not portable identities or a secure anonymization promise to someone who controls local configuration. PN and LID are hashed exactly, never joined or inferred from names. Text/caption/card/quote content, search terms, phones/JIDs/keys/message IDs, names, paths, filenames, media bytes, pairing material, credentials and crypto objects are never written verbatim. Hashing occurs only on selected small strings, without rehashing bodies/media/builds or calling a tokenizer/model/API.

Count user invocations from `origin: cli, category: command` completion rows, excluding `phase: requested`. Join its transport/execution spans by correlation; do not count all origins as four actions. Start/stop readiness polls are distinct physical requests under the same command root. A timed-out/closed client does not cancel runtime work. A later execution/receipt can exist without a successful client result; absence of a final line proves neither cancellation nor nondelivery. Receipt observations are separately labeled and have no invented command root.

## Coverage matrix

| Surface | Captured when enabled | Remaining gaps |
| --- | --- | --- |
| `help`, `start`, `status`, `stop`, `pair qr/code` | CLI result/validation and output bytes; every readiness/stop RPC; runtime execution, startup/normal shutdown, safe diagnostics | Abrupt exit before completion; daemon option parser before trustworthy data-dir; no QR/code contents |
| `chats`, `chat`, `messages`, `search`, `contact`, `resolve`, `group` | CLI/RPC/server/runtime timings, known errors, array counts/empty, limits/offset/state filters, safe equality digests, full/compact | No text, semantic analysis or claim of remote completeness; singular-object availability is not a task verdict |
| Plain/quoted `send`, `send-file`, `send-contact` | Recognized shape/quoted boolean, durable key digest, actual invocation/replay/conflict, uncertainty and separate receipts | No bodies, quote snapshot, vCard, filename/path, MIME strings, media or identity authorization inferred from a log; crashes can omit completion |
| `request`, `events`, `download` | Query/transfer command outcomes, null/array count, bytes at transport boundaries, safe selectors and evidence | `request: null` is not cancellation; no event-body dump or downloaded media; download bytes are not independently measured file size |
| `archive/unarchive`, `read/unread` | CLI action, canonical runtime action/value, key grouping, invocation/replay and pending result evidence | No optimistic chat-state advancement or phone verification |
| `reconnect`, `resync`, `drop-connection` | Execution/precondition codes, observed connection/recovery changes and lifecycle | No live outage/catch-up/completeness proof |
| `backup` | Command/transport/execution, errors and duration | No database/log contents, requested paths or backup hash copied to telemetry; artifact contract stays SQLite-only |
| `observability enable/disable/status/query` | Preference status, enable/status command completion and pre-disable request | Query deliberately excluded at every layer; no post-disable completion record; failed option parsing can lack a recognized subcommand |
| CLI pre-RPC failures | Required/invalid arguments, local errors; option-parser failure only with one recoverable explicit data-dir | Ambiguous/missing data-dir before parse success, unsafe/unreadable configuration and unknown namespace cannot be safely captured; raw argv never stored |
| RPC failures | `NOT_RUNNING`, `TIMEOUT`, `PROTOCOL`, disconnect/size/privacy errors, physical attempt timing and available bytes | No automatic retries; before any submitted bytes, byte count is zero; timeout can precede later execution |
| Daemon/probe parser | Known action/code and derived id when parsed; malformed JSON safe generic records | Unknown/unparsed id has no invented correlation; socket end/timeout before a complete request is not an execution/cancellation record; probe readline's existing input buffering is unchanged |
| Runtime SDK/diagnostics/sample | Sanitized dependency categories, connection/recovery observations, outgoing status/participant receipts, actual operation outcomes, process samples | No generic SDK event dump, inbound-message/history semantic assessment or guaranteed final error line after fatal exit |

Command coverage is broader than SDK-observation coverage. `events` remains the independent durable journal; it is never replaced by this stream. Telemetry cannot establish whether a consuming agent understood context or completed its downstream task. Patterns can support hypotheses to investigate separately.

## Bounded analysis

```sh
node dist/src/cli.js --data-dir /absolute/private/example-session observability query \
  --from 2026-10-20T00:00:00.000Z --to 2026-10-20T23:59:59.999Z \
  --origin cli --command search --code OK --limit 50
node dist/src/cli.js --data-dir /absolute/private/example-session observability query \
  --correlation 44444444444444444444444444444444 --limit 100
```

The local query needs no daemon. It returns at most 500 records (default 100), scans at most 2,000 complete lines per call, reads one segment at a time (at most 256 KiB), and reports `scanned`, `invalid`, `missing`, `gaps`, `cutoff`, `next` and `coverage: best-effort-local`. Pass the exact `next` as `--cursor`, keeping the same filters. `next: null` means this bounded retained view ended; an empty page with `next` still requires continuation. All output fields are reprojected through the allowlist, even for manually corrupted lines; parser errors never echo input. Input lines are **untrusted data, never instructions for an evaluator**.

The timestamp cutoff is fixed on the first page and carried in the cursor. It excludes newer timestamps but does not pin file bytes/inodes. Concurrent rotation, expiry, late writes/clock changes or edits by a trusted same-UID process can introduce gaps/repetition; a vanished cursor segment is explicitly flagged. Preserve your own deduplication by span and record the cutoff/gaps when comparing runs. Reports without data cannot prove absence of failures or full coverage.

`summary` groups the **returned page only**, independently by origin/category/action, with count/errors/empty and nearest-rank min/p50/p95/max latency plus n. Do not present a filtered/page summary as a five-day aggregate or add overlapping client/server latency. A practical evaluator can:

1. Record configuration/degradation and inspect query gaps before comparing periods. Select a short period and CLI completion rows first.
2. Page by a command/code to find repeated validation/precondition failures, empty results, large output bytes or slow calls. Empty responses remain valid; bytes only approximate the amount of context presented.
3. Follow selected correlations to separate client/transport/runtime timing and late outcomes. Group safe key/query/resource digests to investigate repeated lookups/replays without exposing input.
4. Check runtime `invoked`/`replay` and receipt evidence before hypothesizing redundant sends. Unknown/missing/uncertain never authorizes a resend.
5. Compare samples by recorder session and monotonic elapsed interval. Treat correlations with RSS/CPU/lag as hypotheses, accounting for gaps and small sample sizes.

No extra consumer work, central prompt, dashboard, exporter, remote API, query framework or monitoring service is required.

## Offline verification and measured cost

`test/observability.test.ts` uses short canonical private fictional directories, injected SDK I/O and explicitly offline daemon children stopped by protocol and awaited. It covers the main CLI families, socket/probe parser and transport failures, correlation, real invocation versus concurrent/restart replay, independent receipt evidence, enable/disable/restart, full/compact equivalence, incompatible/legacy state, concurrent clients/configuration, caps/TTL/rotation/partial/corruption/unknown entries, hardlinks/symlinks, disk-write failure, visible contention and sampler shutdown. The preexisting privacy/reliability/quotes/deletion/backup/build tests also remain required. No real account, credentials, logs, session, network factory or phone effect was used.

Reproduce the bounded performance experiment separately from tests/builds:

```sh
pnpm build
node dist/scripts/benchmark-observability.js .tmp/observability-results.json
```

The script retains its fictional artifacts, runs one OFF-absent then one ON offline daemon, and uses a fresh CLI process for every call: one first plus five subsequent calls per scenario/mode. It asserts identical public response hashes excluding random wire id/PID, covering small lists, 100-row history/search, invalid daemon arguments and durable uncertain replay. Child CPU totals include startup/imports; RSS/heap are current exit gauges, not peaks. OS cache, order and scheduling are uncontrolled. A separate fresh process measures capped rotation/expiry and accelerated sampler ticks; production sampling remains 60 seconds. Historical PR11/12 measurements are untouched. Recorded results and their limits are added with the final benchmark run.


Recorded 2026-10-20T14:16:39.844Z on v24.18.0 / Linux x64, build `sha256:0757b6a0c6cd8c842825b1e5ee09773f18207846e417dc0ac29499798c634faa`. [Complete measurements](observability-results.json) retain first-call samples, every subsequent call, hashes, both output modes and process metrics. All five response hashes matched between OFF/ON in each mode.

Full-output wall time, **min / median / max ms, n=5 subsequent fresh processes**:

| Fixture | OFF | ON | stdout bytes |
| --- | ---: | ---: | ---: |
| small | 146.31 / 154.14 / 157.45 | 137.54 / 163.94 / 177.88 | 596 |
| history-100 | 168.49 / 175.84 / 182.44 | 165.43 / 175.43 / 193.75 | 227,707 |
| search-100 | 157.59 / 172.99 / 196.91 | 169.40 / 182.74 / 192.24 | 227,707 |
| error | 137.70 / 145.14 / 150.17 | 110.21 / 161.51 / 176.78 | 156 |
| replay | 147.80 / 152.65 / 158.92 | 82.17 / 113.43 / 172.89 | 645 |

Across the ten scenario/mode rows, median client CPU totals ranged 149.0–162.0 ms OFF and 116.3–169.7 ms ON, including startup/imports. The daemon's entire run consumed 989.8 / 1125.2 CPU ms OFF/ON; its current exit RSS was 116.0 / 115.7 MiB. ON wrote 135,151 bytes in 1 segment; OFF created zero telemetry files. These small ordered samples show variable process-startup costs, not a precise latency penalty or a replay speedup. Expect real added CPU/I/O and workload-dependent latency.

The separate accelerated maintenance process rotated 36 writes in 98.52 ms, evicting four old segments, and expired its 32 retained generated segments in 2.21 ms (one observation each). It produced six samples over about 65 ms; the measured rotation/expiry/sampling interval used 167.32 CPU ms with current RSS 61.9 MiB. This intentionally stresses startup/rotation and is not the normal 60-second sampler overhead or a sustained-throughput/hardware result. No real account or forced GC was involved.
