# Fixed-version installation and local candidate

The supported reproducibility contract is **source at an exact commit + its lockfile + recorded toolchain/platform + a fresh build**. This is a private local candidate, not an npm publication or GitHub Release. `private: true` remains set. No service, tag or deployment automation is needed. Equal source/dependency graphs do not establish identical build or tarball bytes; compare hashes before making that claim.

## Install from a fixed source

Use Git, Node **24.18.0** and pnpm **10.24.0** for the measured Linux baseline. The supported Node range is `>=24.18.0 <25`; record the exact patch used, OS and architecture. Baileys is **7.0.0-rc14**, TypeScript **5.9.3**. Keep `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` together. The lock includes transitive versions and registry integrity hashes; do not regenerate it, disable integrity checking or enable install scripts to make an installation pass.

Choose the coordinator-approved full 40-character commit. Clone into a **new** destination, then run this in that clone; replace the placeholder before execution:

```sh
git clone --no-checkout https://github.com/gabrielMalonso/whatscli-next.git /absolute/new/source
cd /absolute/new/source
release_commit='FULL_40_CHARACTER_APPROVED_COMMIT'
test "${#release_commit}" -eq 40
git checkout --detach "$release_commit"
test "$(git rev-parse HEAD)" = "$release_commit"
test -z "$(git status --porcelain)"
test ! -e dist
node --version
pnpm --version
pnpm install --frozen-lockfile --ignore-scripts
pnpm lint
pnpm format:check
pnpm build
pnpm check
pnpm test
pnpm verify:build
node dist/src/cli.js help
```

Stop on any failed command (use `set -eu` when running the blocks as a shell program). Use a new source directory for each candidate; `tsc` does not remove old output, so building over an old `dist` is insufficient. The install may use the verified package cache or public registry. No lifecycle scripts are needed for the measured Linux installation. If a different platform needs one, investigate and obtain alignment rather than enabling scripts globally. macOS is unvalidated.

Record outside tracked files: commit, clean working tree, `node --version`, `pnpm --version`, `process.platform`/`process.arch`, lockfile SHA-256, installed Baileys version, CLI/daemon build hashes, check results and timestamps. `sha256sum` is available on the tested Linux host; on another host use its equivalent. A package version such as `0.1.0` is insufficient to identify this candidate.

Also record the `Build fingerprint: sha256:…` printed by a successful `pnpm build`. The stamp is embedded in `dist/src/runtime.js`, which is already covered by the package allowlist; packing preserves it and requires no Git or build tool at runtime. Run `node dist/src/cli.js` directly as above. `tsc` alone emits an unknown/null fingerprint instead of preserving an old stamp. A failed build is not a candidate; use the fresh-directory procedure even though stamping itself is repeatable.

### Verify emitted output before accepting a candidate

Run `pnpm verify:build` after the final build/test and immediately before packing. It recompiles the current project **in memory**, applies the expected first-party JS stamp there, and compares every expected `dist` file (including maps, tests and scripts) byte-for-byte. Missing, modified, obsolete or unexpected files/directories, links and non-regular entries fail. A plain `tsc`/null stamp also fails. This closes a concrete gap: `tsc` and stamping can both succeed while retaining a retired `.js` file, which the package allowlist would include.

The verifier reads source/configuration, compiler/type inputs and build files; it does not write output, execute application code, open SQLite, query a daemon or use the network. It costs another local compiler pass plus output comparison, with compiler memory and emitted bytes held in memory. It is an explicit source-maintenance check, with no added work on CLI/status requests or package lifecycle hooks. Keep the candidate unchanged between verification, inspection and use; the check does not lock files or prevent concurrent changes.

Use the current source's compiled verifier from its source root. To select a different source directory explicitly, `node /absolute/new/source/dist/scripts/verify-build.js /absolute/new/source` also accepts a relative source path. Exit 0 prints `Verified build: FILE_COUNT files; sha256:…` on stdout. Exit 1 prints a safe diagnostic and NEW-directory guidance on stderr; no source text or compiler diagnostic excerpts are printed. Preserve failed output instead of deleting/reusing `dist` or repairing it automatically. If compilation failed or the verifier itself is missing, stop and choose a new directory as well.

This is a correspondence check with **the current source and installed compiler**, not proof of the approved commit, a clean Git tree, the lockfile or installed dependency bytes. No Git is required; an archive without `.git` remains usable, with its source provenance recorded separately. Type-only changes may keep JS labels equal. The fingerprint contract below stays unchanged. The supplemental tarball excludes source/scripts/compiler and cannot run this check; verify its source build first, then audit and smoke the actual archive.

```sh
git rev-parse HEAD
git status --porcelain
node -p 'JSON.stringify({node:process.version,os:process.platform,arch:process.arch})'
node -p 'require("./node_modules/baileys/package.json").version'
sha256sum pnpm-lock.yaml dist/src/cli.js dist/src/daemon.js
```

Invoke `node /absolute/new/source/dist/src/cli.js ...` directly when stdout is consumed by another program. Each CLI invocation emits one JSON object on stdout, including command errors; nonzero exit status indicates failure. Diagnostics use stderr; the background daemon appends its stderr to the private data directory's `daemon.log`.

## Local tarball inspection

After the fresh build, keep generated evidence under ignored `.tmp/`. Packing does not rebuild; disable pack scripts as well:

```sh
pnpm verify:build
mkdir -p .tmp
candidate_dir="$(mktemp -d "$PWD/.tmp/candidate.XXXXXX")"
pnpm --config.ignore-scripts=true pack --pack-destination "$candidate_dir"
tar -tzvf "$candidate_dir/whatscli-next-0.1.0.tgz"
sha256sum "$candidate_dir/whatscli-next-0.1.0.tgz"
```

Audit the **actual archive**, not only `package.json.files`. Its only regular files should be `package/package.json`, `package/README.md`, `package/LICENSE`, `package/AGENTS.md`, the current top-level `docs/*.md`/`docs/*.json`, and each current production `src/*.ts` compiled as `package/dist/src/*.js` and `.js.map`. Check exact names against that source commit, reject links/unexpected paths, and inspect the text/code being included. The leaf file allowlist excludes nested fixture/state directories and unrelated file extensions. It cannot recognize a secret deliberately put into an allowed Markdown/JavaScript file.

Reject any session, credential, database, SQLite WAL/SHM, lock, socket, QR, log, `.env`, test fixture, `dist/test`, `dist/scripts`, `node_modules`, `.private` or `.tmp` content. Exercise exclusions with **fictional canaries only**, in a disposable source copy, including state-like files under `dist/src/` and `docs/`. Never copy private data into a candidate to test exclusions. Keep the listing, per-file sizes/hashes and tarball checksum as the local manifest. No deterministic-tarball claim is made by a single successful pack.

The tarball excludes source, tests, lockfile, workspace configuration and installed dependencies. pnpm also rewrites the packed manifest, including removing `packageManager`; use the separately recorded pnpm version. It is **not a standalone frozen installation**: `pnpm add ./candidate.tgz` can resolve a different transitive graph. Preserve the source commit/lock and toolchain with it. For an isolated payload check, create a new OS temporary directory outside this worktree and all ancestor `node_modules` directories:

```sh
# Continue from the fresh source directory above.
smoke_root="$(env -u NODE_PATH -u NODE_OPTIONS node --input-type=module -e 'import {mkdtempSync,realpathSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; process.umask(0o077); console.log(realpathSync(mkdtempSync(join(tmpdir(), "wcn-package-"))));')"
mkdir "$smoke_root/payload"
tar -xzf "$candidate_dir/whatscli-next-0.1.0.tgz" \
  --strip-components=1 -C "$smoke_root/payload"
cp pnpm-lock.yaml pnpm-workspace.yaml "$smoke_root/payload/"
cd "$smoke_root/payload"
env -u NODE_PATH -u NODE_OPTIONS pnpm install --prod --frozen-lockfile --ignore-scripts
env -u NODE_PATH -u NODE_OPTIONS node --input-type=module -e \
  'for (const p of ["baileys", "pino", "qrcode"]) console.log(p, import.meta.resolve(p))'
```

Require those resolutions to point into this payload's own `node_modules`, with no ancestor package fallback. The copied lock/workspace files are inspection inputs from the exact source, not tarball contents. Preserve integrity verification. Run the next smoke in this payload too, with `NODE_PATH`/`NODE_OPTIONS` unset. Keep external temporary artifacts for inspection; do not recursively delete outside the worktree.

## Offline lifecycle smoke

This block uses only its own new fictional directory and Unix socket. `--offline` must be present on **every start**. Do not substitute an existing data directory, a default session or another task's fixture.

```sh
smoke_data="$(env -u NODE_PATH -u NODE_OPTIONS node --input-type=module -e 'import {mkdtempSync,realpathSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; process.umask(0o077); console.log(realpathSync(mkdtempSync(join(tmpdir(), "wcn-data-"))));')"
env -u NODE_PATH -u NODE_OPTIONS node dist/src/cli.js --data-dir "$smoke_data" help
env -u NODE_PATH -u NODE_OPTIONS node dist/src/cli.js --data-dir "$smoke_data" status
env -u NODE_PATH -u NODE_OPTIONS node dist/src/cli.js --data-dir "$smoke_data" start --offline
env -u NODE_PATH -u NODE_OPTIONS node dist/src/cli.js --data-dir "$smoke_data" status
env -u NODE_PATH -u NODE_OPTIONS node dist/src/cli.js --data-dir "$smoke_data" stop
env -u NODE_PATH -u NODE_OPTIONS node dist/src/cli.js --data-dir "$smoke_data" status
```

The scratch commands canonicalize only the newly created private directory, accommodating temporary-directory aliases; the existing trusted-ancestor rules still apply. Never put smoke state under a group-writable source worktree or silently canonicalize an existing session. Linux alone is exercised; this path choice does not establish macOS support.

Verify JSON/exit codes: initially and finally `running: false`; while started `running: true`, a PID, `connection: offline`, `recovery.state: offline`, `data.networkEnabled: false`, no linked credentials/account/QR. A successful stop releases the writer; confirm the recorded PID exits normally. Keep stdout/stderr separately and preserve the fictional directory. An offline runtime creates fictional local auth/storage but never invokes the WhatsApp socket factory. This checks imports, local startup, SQLite, transport and stop, not pairing or WhatsApp compatibility.

In both full/compact status and repeated `start --offline` (`alreadyRunning: true`), require `data.build.fingerprint` to match the recorded build fingerprint. Repeat this comparison in the extracted package payload; do not substitute the fingerprint of a different local CLI. No responding daemon means no identity evidence.

## Identify startup and upgrade without losing the session

Only the coordinator-approved deployment may use this procedure with real state. Record the **absolute immutable build path**, exact commit/lock/build hashes, build fingerprint and Node executable before launch. Keep that build directory unchanged while its daemon runs. `status.data.build.fingerprint` comes from a literal in the loaded runtime module and stays stable for that process, including when another checkout or rebuilt CLI queries it. `start` with `alreadyRunning: true` returns that same process; it does not upgrade it. The JSONL probe reports its own loaded build on status too. No status-time filesystem/Git lookup or hash computation occurs.

The `sha256:` label fingerprints the sorted top-level `dist/src/*.js` names and bytes at build time, with length-framed entries and the embedded fingerprint normalized to null to avoid self-reference. It covers emitted first-party JS, excluding source maps, TypeScript source, package version, lockfile, installed dependencies, Node and configuration/state. It is an informational build label, **not** cryptographic authenticity, verification of currently loaded dependencies, or a runtime integrity check. Preserve the separate commit/lock/toolchain/hash record. Manually editing a stamped artifact invalidates its label; it is not revalidated on startup.

No Git/commit/dirty-state claim is made: a source archive without `.git` builds normally; modified source that changes emitted JS changes the fingerprint, while type-only/unemitted changes can keep it equal. Old `dist` labels describe old artifacts, never today's source. Direct compilation without the stamping step (or uninstrumented source execution) reports `{fingerprint: null}`; older daemons omit `build`. Both mean the identity is unavailable, and the CLI never fills it from its own build. Version `0.1.0` alone remains insufficient.

The explicit source-side verifier above can detect stale/missing/unexpected build output at candidate preparation time. A matching daemon fingerprint alone still does not perform that check or identify the installed CLI's source/dependencies.

1. Query the current daemon using its recorded CLI path and the explicit private data directory. Record its PID and account. Arrange that no supervisor/operator restarts it concurrently. Do not run the probe or a second daemon against that directory.
2. Call `stop` with that same directory. Wait for successful shutdown **and the recorded old PID's normal exit** before launching new code. On Linux, an operator can inspect `ps -p OLD_PID -o pid=,stat=,args=` until that process is absent; do not signal it. A timeout/error, or a live PID after an older socket disappears, requires investigation and waiting. `running: false` alone cannot prove an old daemon finished cleanup. Preserve locks, databases and credentials; never force cleanup.
3. Build/install the chosen source in its new directory as above. After the previous writer has exited, use the new absolute CLI path with the **same** data directory and approved `--allow-jid EXACT_JID`. For offline inspection use `start --offline` instead; switching modes also requires normal stop/exit first. Record returned PID and startup time. `alreadyRunning: true` means an existing runtime answered, not that an upgrade happened; investigate before claiming this build is running.
4. Inspect `status` from that path/directory. Require `data.build.fingerprint` to match the recorded intended build; mismatch/unknown requires investigation, not an upgrade claim. For live work, require `hasLinkedCredentials`, `connection: open`, and the account JID approved by the owner; do not use raw `registered` as the pairing verdict. Confirm network mode/restriction and preserve `source: local`, `coverage: partial`, `appState: unknown`, `receiveContinuity.status: unproven`. Unexpected identity or QR pauses the procedure; do not pair a replacement automatically.
5. Query known request keys and local observations. Repetition uses the same exact keys/arguments, preserving original IDs/routes/uncertainty without a new attempt. Preserve all state across restart. Stop normally and confirm PID exit before a private manual backup of the whole data directory; do not copy a live SQLite file alone. The explicit runtime `backup --out NEW_DIRECTORY` offers a verified SQLite-only alternative; [scope and NEW-directory offline recovery](backup.md) exclude locks/logs/QR/external files and preserve uncertainty. Recovery evidence is fictional/offline, without automatic downgrade, real-account restore or credential-validity guarantees.

For disconnections, inspect current `recovery.reason`/`code` separately from historical issues. Known transient 408/428/503/515 retry at 1–30 seconds without an attempt limit. Terminal/unknown and socket creation/cleanup failures require investigation. An approved explicit `reconnect` or normal restart is a new connection attempt using retained credentials, never an excuse to resend uncertain intents. Open/pending-notification completion does not prove catch-up or resolve the historical decryption gap. See the [recovery contract](../README.md#recovery) and [pilot runbook](pilot.md) for the acceptance boundary.
