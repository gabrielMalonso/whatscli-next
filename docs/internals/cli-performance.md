# CLI startup and response assembly

Each invocation starts a new Node process. The client import graph is already small: `cli → rpc/protocol/response → identity/contact-card/paths`, plus Node built-ins. It does not import Baileys, Store, authentication or the runtime. Command validation remains authoritative in the daemon; SDK normalization remains in the SDK-backed runtime/Store. No lazy SDK loader, bundler or persistent client process was added.

The later [command error contract](../user/output.md#command-errors-and-safe-next-steps) adds only the dependency-free `errors` module to this client graph, with no new I/O. Current benchmark reruns separately assert the candidate's additive `INVALID_ARGUMENT` code for the local `client-error` scenario, then omit only that field for comparison with the fixed pre-contract baseline. All other payload comparisons remain exact after removing the random RPC ID. The historical measurements below are unchanged.

Initial profiling showed substantial Node/internal-module startup work. A discarded experiment delaying only `child_process` changed help median from 125.3 to 122.6 ms (20 subsequent new processes, alternating order). That small, variable result did not justify a startup refactor. Ordinary status/help/local queries still pay the process/import cost below. These measurements do not identify the version of an already-running daemon.

The concrete bottleneck was assembling large RPC responses. Previously every received fragment concatenated the entire accumulated string, counted its UTF-8 bytes and searched it from the beginning for a newline. Long Unicode pages repeatedly flattened/scanned earlier text. The client now counts and inspects each decoded fragment once, retains fragments until the first complete line, then joins/parses once. This keeps the existing inclusive 8 MiB response cap, first-line framing, correlation check, full/compact envelopes, errors and one-attempt behavior.

There is no additional persistent state or cache. Fragment references and the joined response are transient client allocations; the client still holds the complete public response for JSON parsing/formatting. Daemon RAM, SQLite schema/disk, ingestion, durability and idempotency are unaffected. This is a client response-assembly change, not a daemon/Store speedup.

## Reproduce

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm benchmark:cli --output .tmp/cli-resource-results.json
```

The driver extracts only committed `src` from exact base `a2d00b2da84e9db09ded1a31829cfa933962f2d4`, builds it with the same installed TypeScript/dependencies and compares its actual CLI/RPC with the freshly built candidate. The extraction adjusts only compiler source inclusion/root directory. It creates no worktree, reads no account data and retains generated scratch files for inspection. The repository report omits local scratch paths.

A typed fictional Unix socket server uses the real `parseRequest` validator and preencoded safe public responses with fresh correlated IDs. It serves status, 20/100 short messages, 20/100 long Unicode messages, localized search, an uncertain immutable request and daemon validation errors. Client validation errors and help perform no socket I/O. Large messages contain about 60,000 UTF-8 bytes of fictional text each, within the send-text limit; these stress pages are deliberately much larger than ordinary conversations. Every base/candidate CLI result is compared with its expected full/compact envelope and SHA256 after removing only the random RPC ID. Raw RPC results have the same assertion.

CLI timing includes spawning Node, imports, socket I/O, presentation, JSON and stdout capture through exit. Each scenario/mode/variant has one first process and ten subsequent **new** processes; variant order alternates within pairs. OS cache is uncontrolled and warmed by builds/prior scenarios: “first” means a first process observation, never cold disk. All phases run sequentially, without concurrent worker builds/tests. The identical small exit-metrics preload reports each CLI's own `process.resourceUsage`: user/system CPU in milliseconds and reported RSS high-water in bytes. It adds instrumentation to both variants; no sampled heap is presented as a peak.

On Linux, `resourceUsage().maxRSS` can retain a pre-`exec` floor influenced by the parent's memory at spawn. These samples therefore do **not** isolate the CLI's post-`exec` RSS peak, particularly for small responses or when the driver has grown after large pages. An independent synthetic check reproduced a child with about 43 MiB current RSS reporting about 101 MiB maxRSS after its parent allocated 96 MiB. Retain the reported values as resource observations with that limitation, not an exact attribution of memory savings to the CLI. This does not affect the wall/CPU intervals. No post-`exec` memory-only benchmark was performed.

Raw RPC runs separately, after imports in a new worker per variant/scenario, with one first call and ten subsequent calls. Its wall/CPU interval covers connection, receiving, assembling and parsing; response hashing runs afterward. Its RSS high-water includes imports and previous result hashing. Node-empty/import observations isolate startup further. The fake server's preencoded body avoids measuring per-call Store queries or body serialization; it is not a daemon benchmark. No WhatsApp socket, runtime, database, credentials or downstream repository is used by this benchmark.

Only the existing offline tests start their own fictional daemons, always with `--offline`; they cover lifecycle, restart and writer/socket release. No account migration or live upgrade was performed. Smaller `--limit` values reduce full body volume. Compact mode reduces agent stdout but preserves full text and receives the same full socket payload.

## Recorded comparison

Run **2026-10-19T20:52:37.572Z**; measured production implementation **`46e0437cbaccaa52f9938d022a287f5db1e3e244`**, against the exact base above. The compiled source hashes in [the complete report](cli-resource-results.json) differ only for `rpc.js`. Later documentation/benchmark-assertion changes do not change that production code. Node v24.18.0, pnpm 10.24.0, TypeScript 5.9.3, Baileys 7.0.0-rc14, Linux x64. Historical [Store results](store-query-results.json) remain a separate round.

CLI warm medians below are milliseconds, **n=10 new processes** per cell. Full and compact are independent process series; do not attribute their variation solely to formatting.

| Scenario                | Full base → candidate ms | Compact base → candidate ms | Socket bytes |
| ----------------------- | -----------------------: | --------------------------: | -----------: |
| help                    |          127.18 → 128.01 |             122.27 → 125.84 |            — |
| status                  |          140.52 → 141.07 |             138.32 → 138.21 |          400 |
| history-20              |          140.24 → 144.14 |             139.33 → 139.05 |         6827 |
| history-100             |          141.42 → 144.92 |             142.69 → 143.30 |        32667 |
| history-large-20        |          201.27 → 188.82 |             195.52 → 189.67 |      1205667 |
| history-large-100       |          529.93 → 232.41 |             541.16 → 238.18 |      6026867 |
| search-20               |          143.92 → 145.22 |             146.34 → 140.78 |         6827 |
| search-large-100        |          531.19 → 160.66 |             511.74 → 181.92 |      6026867 |
| request                 |          138.45 → 142.31 |             142.12 → 140.61 |          652 |
| client-error            |          132.76 → 129.52 |             138.21 → 132.78 |            — |
| daemon-validation-error |          140.58 → 141.02 |             145.46 → 142.14 |            — |

First observations and warm spread for selected CLI cases follow. Each cell is **first; warm min / median / max ms, n=10 warm**. Every case, mode, CPU sample and RSS sample is retained in the report.

| Scenario / mode          |                          Base ms |                     Candidate ms |
| ------------------------ | -------------------------------: | -------------------------------: |
| help / full              |   72.79; 91.64 / 127.18 / 144.84 | 126.91; 109.15 / 128.01 / 132.51 |
| status / full            | 144.75; 129.93 / 140.52 / 160.66 | 145.98; 127.26 / 141.07 / 152.97 |
| history-20 / full        | 148.47; 134.20 / 140.24 / 146.97 | 152.99; 123.64 / 144.14 / 158.36 |
| history-large-20 / full  |  211.68; 77.87 / 201.27 / 280.76 | 183.53; 127.56 / 188.82 / 228.07 |
| history-large-100 / full | 410.30; 387.58 / 529.93 / 691.91 | 104.17; 107.36 / 232.41 / 378.06 |
| search-large-100 / full  | 667.42; 383.30 / 531.19 / 656.85 |  100.94; 94.51 / 160.66 / 267.23 |

Client resources below are reported by each **new CLI process**. CPU includes imports, parsing, presentation and stdout, and is the warm median of user+system milliseconds. RSS is the warm median of reported OS high-water MiB, subject to the Linux pre-`exec` floor above; it cannot be attributed exclusively to post-`exec` CLI allocations. These values do not measure permanent daemon memory.

| Scenario / mode             | CPU base → candidate ms | Reported maxRSS base → candidate MiB |
| --------------------------- | ----------------------: | -----------------------------------: |
| status / full               |         141.19 → 141.82 |                        50.94 → 51.10 |
| history-large-20 / full     |         213.85 → 183.79 |                        71.67 → 64.97 |
| history-large-20 / compact  |         207.96 → 181.95 |                        71.96 → 65.25 |
| history-large-100 / full    |         522.19 → 204.01 |                      202.17 → 134.72 |
| history-large-100 / compact |         554.64 → 233.74 |                      183.15 → 134.89 |
| search-large-100 / full     |         542.48 → 148.11 |                      202.65 → 126.56 |
| search-large-100 / compact  |         528.79 → 168.14 |                      213.53 → 123.71 |

Raw RPC timings (no CLI/Store) are **first; warm min / median / max ms, n=10 warm**, with CPU measured only across each RPC call.

| Scenario          |                          Base ms |                 Candidate ms | CPU median base → candidate ms |
| ----------------- | -------------------------------: | ---------------------------: | -----------------------------: |
| status            |        12.55; 0.56 / 1.01 / 2.05 |    14.73; 0.59 / 1.04 / 1.55 |                    1.43 → 1.41 |
| history-20        |        11.96; 0.80 / 1.19 / 2.80 |    13.73; 0.97 / 1.53 / 3.63 |                    1.79 → 1.70 |
| history-large-20  |     52.90; 14.81 / 16.22 / 17.21 |  35.81; 8.79 / 21.25 / 45.35 |                  17.43 → 21.94 |
| history-large-100 | 303.57; 296.15 / 298.99 / 304.50 | 31.86; 17.20 / 23.69 / 81.12 |                 302.66 → 29.78 |

Startup-only observations use the same metrics preload and new processes. Cells are **first; warm min / median / max ms, n=10 warm**. The protocol/import code is otherwise identical across base/candidate.

| Observation     |                               ms |
| --------------- | -------------------------------: |
| node-empty      |    18.83; 33.28 / 86.63 / 104.08 |
| protocol-import |    95.16; 90.95 / 96.67 / 108.57 |
| rpc-import      | 111.93; 104.20 / 110.01 / 122.82 |

## Interpretation and limits

The 6 MB full history page improved **56% end-to-end** (530 → 232 ms median), with **61% less client CPU**. Reported maxRSS median was **202 → 135 MiB**, subject to the pre-`exec` floor; this is not an isolated post-`exec` CLI memory-savings measurement. Its raw RPC median improved about **12.6×** (299 → 24 ms). Large search improved too; this fixture returns the same page through a different CLI action, so it does not measure search execution in SQLite.

Small responses remain dominated by roughly 125–145 ms of process/import/CLI work and show no demonstrated speedup. The 1.2 MB raw case did **not** improve consistently (16.2 → 21.2 ms median, candidate range 8.8–45.3 ms), despite a modest end-to-end change and lower reported maxRSS. Candidate 6 MB CLI samples also varied widely; first observations were sometimes faster than subsequent processes. Do not infer cold-disk behavior, precise production latency, a small-page win or a memory-leak conclusion from these distributions.

The tradeoff is retaining fragment references until parsing, rather than repeatedly allocating flattened prefixes. Both implementations still require the full response in memory, and the cap remains 8 MiB. There is no new disk use, invalidation policy or persistent cache. No Store/schema/ingestion change justified repeating the heavy Store benchmark. The fake server omits daemon/Store work, so total real-command latency remains unmeasured here.

Validation: all **132 prior tests plus four RPC regressions (136 total)** passed; `pnpm check` and `git diff --check` passed. Regressions cover fragmented multibyte UTF-8 and complete payloads, exact inclusive/overflow byte limits, malformed/mismatched/incomplete responses without retry, first-line framing and unchanged error envelopes. Existing offline CLI tests cover full/compact channels, authoritative validation, correlation versus download message ID, lifecycle, exact identity, visibility and restart. No real account, private snapshot, live socket or downstream data was accessed.
