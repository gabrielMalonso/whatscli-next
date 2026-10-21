# Observability architecture

The recorder uses a shared synchronous JSONL stream and a bounded, recorder-local FIFO to handle lock contention. It requires no additional service, IPC channel, spool, or database. See [the operational guide](../operations/observability.md) for configuration, schema, retention, query behavior, and interpreting capture gaps.

## Append and ownership rules

1. Prepare an immutable allowlisted snapshot outside the append lock, fixing its timestamp, span/context, session, and generation.
2. Keep one read-only `O_NOFOLLOW` preference descriptor for each admitted queued or in-flight snapshot. Under the append or witness gate, compare its exact bigint device/inode identity with the current validated path. Holding the descriptor prevents inode reuse. Rapid disable/re-enable invalidates older snapshots even if the generation and secret match and no watcher event arrives.
3. Acquire the shared append lock through exclusive `mkdir`, without waiting. Recheck preference, ownership/permissions, generation, recognized headers, tail, and caps on every append. No cached scan or batch bypass is allowed.
4. Defer to the FIFO only when lock acquisition returns `EEXIST` before any work begins. Short writes, write exceptions (including later `EEXIST`), and close/release failures never retry an append that may already have written bytes.
5. Limit the FIFO to 16 snapshots, 64 KiB of encoded data, and a 25 ms monotonic retry window. Overflow rejects the newest snapshot. Use at most one retry timer and one active drain, with a fixed admission watermark and deadline that later observations cannot extend. A pass delayed past the deadline makes one final non-waiting append attempt per snapshot, discarding it if the lock is still busy; scheduler delay alone does not prove continuing contention. FIFO order is recorder-local, not global timestamp order.
6. Seal admission and drain once when the owner closes. The CLI owns its shared observer; an RPC closes only an observer it created. Runtime/probe shutdown waits for operational work, records shutdown, drains telemetry, then closes Store and releases writer ownership.

### Failure handling

A complete byte count is evidence of an append, not a power-loss durability guarantee. Cleanup uncertainty remains sticky, and each descriptor close is attempted once; blindly closing a reused descriptor number would be unsafe.

Hash failures omit the affected selector without marking the row lost. Failure carry is sampled at append time and consumes only carried counts, leaving reentrant failures for the next line. Preparation failures and preference invalidations remain distinct from lost admitted rows.

No retry timer runs without pending observations. Normal off mode creates no telemetry files or sampler, although preference/path reads and a runtime watcher remain.

Unknown locks, pending configuration, incomplete headers, partial tails, and unsafe entries are preserved. Buffering cannot repair these conditions or guarantee crash persistence; an abrupt process exit may lose the volatile queue without leaving a witness.

Safe segment expiry may continue despite a degraded witness, but unknown segment entries still block that maintenance pass.

Synchronous filesystem calls and scheduler delays can exceed 25 ms. The window controls retry admission, not syscall duration or process exit. Telemetry never retries or cancels a business command, SDK call, or immutable intent.

## Regression coverage

Use fictional state and injected I/O to cover FIFO contention, expiry/overflow, rapid opt-out, partial/uncertain writes, shutdown, and query gaps. The `observability-buffer`, `observability-capture`, `observability-maintenance`, `observability-query`, and `observability` test suites exercise these boundaries. Response equality and successful capture are separate assertions.
