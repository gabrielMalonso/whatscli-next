# Builds and upgrades

Install from source using [Getting started](../user/getting-started.md). Use Node.js 24.18+ (24.x), pnpm 10.24.0, and the committed lockfile. No npm package is published.

## Verify a build

Run the [contributor checks](../../CONTRIBUTING.md#setup-and-checks) before using a changed build. `pnpm verify:build` recompiles the current source in memory, applies the build stamp, and compares the complete `dist` file set and bytes, including maps, tests, and scripts. Missing, unexpected, stale, modified, or linked entries fail verification, as does unstamped output from direct `tsc`.

The verifier writes nothing and does not run application code, open a database, or make network calls. It requires source and development dependencies. It verifies correspondence with the current source and compiler, not dependency authenticity, Git provenance, or code loaded by a running daemon.

Use a fresh source directory for upgrades because `tsc` leaves obsolete output behind. Preserve failed candidates for investigation, and keep a running daemon's source and build unchanged. Use an absolute CLI path and explicit data directory to avoid targeting another installation or account.

## Identify the running build

`status.data.build.fingerprint` is the responding process's embedded build label. It covers sorted first-party `dist/src/*.js` filenames and bytes, with the label normalized. Maps, source, dependencies, lockfile, Node, and state are excluded.

The label remains stable for the process but does not prove authenticity, integrity, or source commit. Type-only changes may leave it unchanged, and startup does not revalidate manually modified stamped output.

A null fingerprint means unstamped code; an absent field means a legacy daemon. The client never substitutes its own label.

## Identify startup and upgrade without losing the session

1. Query the existing runtime using its recorded CLI path and data directory. Record the PID and account, and coordinate to prevent concurrent restarts.
2. Stop normally and wait for the old PID to exit. A missing socket, stopped status, or timeout alone does not prove cleanup finished. Preserve credentials and locks; investigate rather than killing the process or starting a second runtime.
3. Start the verified build from its immutable path, using the same data directory and intended restriction. `alreadyRunning: true` means an existing process answered, not that it upgraded.
4. Require the intended build label, account, network mode, restriction, and open connection for live use. Investigate unexpected pairing or identity. The raw registration flag alone is not a pairing verdict.
5. Inspect existing request keys and local evidence. Preserve IDs, routes, receipts, and uncertainty. An upgrade or reconnect neither authorizes resending uncertain intents nor proves complete catch-up.

Changing between offline and network modes also requires a normal stop and PID exit. See [backup/recovery](backup.md) before migration and [runtime recovery](runtime.md) for connection problems.

## Package checks for contributors

Packing does not build the project. After verifying the build, create a local archive:

```sh
mkdir -p .tmp
package_dir="$(mktemp -d "$PWD/.tmp/package.XXXXXX")"
pnpm --config.ignore-scripts=true pack --pack-destination "$package_dir"
tar -tzvf "$package_dir/whatscli-next-0.1.0.tgz"
```

Inspect the actual archive against the source. It should contain only the package manifest, README, license, contributor/repository guides, public Markdown documentation, and production `dist/src/*.js`/`.js.map` files.

Reject links, private state, fixtures, databases, logs, QR files, `.env`, dependencies, tests, and scripts. The allowlist cannot detect secrets placed inside otherwise allowed files.

The tarball excludes source, lock/workspace files, and dependencies. It is not a standalone frozen installation: installing it alone may resolve a different transitive dependency graph.

To check a payload, use an isolated directory, the exact source lock/workspace files, and `--prod --frozen-lockfile --ignore-scripts`. Confirm that dependencies resolve within the payload rather than from an ancestor installation.

Test the lifecycle only with a new fictional, private canonical data directory and `--offline` on every start. Check stopped/running/stopped state, `networkEnabled: false`, no account or QR, the expected build label, and normal PID exit.

This verifies local lifecycle behavior, not WhatsApp compatibility or real-account recovery.
