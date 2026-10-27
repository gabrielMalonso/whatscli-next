# Maintaining the pinned Baileys SDK

The CLI installs the exact npm release in `package.json`, with pnpm applying a generated dependency patch during `--frozen-lockfile --ignore-scripts` installation. Installation does not build the SDK or require a separately published fork package.

## Source of truth

[`baileys-source.json`](baileys-source.json) records the npm release, its upstream Git commit, published SHA-512 integrity and ordered source patches. The npm `gitHead` and the source package version must match this manifest. The source patches include their offline regression tests:

- `01-windows-platform.patch`: upstream's Windows platform correction, preserving the behavior already included in our pinned package.
- `02-app-state.patch`: typed action observations, response evidence, independent local echoes, transaction and event-buffer corrections, including the final review fixes in [upstream PR #2878](https://github.com/WhiskeySockets/Baileys/pull/2878).
- `03-receipts.patch`: separate direct receipt times, preserving original message timestamps and broadcast handling, including the final review fixes in [upstream PR #2879](https://github.com/WhiskeySockets/Baileys/pull/2879).

Edit source patches and their tests rather than the compiled `baileys@VERSION.patch`. The generated patch, dependency version, pnpm workspace mapping, lockfile and manifest belong in the same PR. No installation references a moving Git branch.

## Rebuild and verify

Use the project's pinned Node.js and pnpm versions; Corepack, Git and npm must also be available. With CLI dependencies installed:

```sh
pnpm sdk:verify
```

This fetches the exact upstream commit into a new ignored `.tmp/baileys-*` directory, applies the source patches, installs SDK dependencies with its immutable Yarn lockfile and build scripts skipped, and runs SDK formatting, lint/types, unit/integration tests and build. It then regenerates the pnpm package patch in isolation and compares it, the project dependency files and the installed SDK with the committed result.

Production dependency metadata, exports, package inventory, WAProto and engine requirements are checked against the published release before replacing compiled `lib/` files. Missing, added or changed generated files are accounted for. Source patches cannot modify SDK packaging, dependencies, workflows or generated bindings. Source maps may differ only by terminal newline normalization; executable files and declarations must match exactly.

The existing CLI CI and the SDK CI job run independently and are both required before merging. SDK checks here are offline with respect to WhatsApp: no account, credentials or live session is used. Bartender E2E is not part of this gate.

## Prepare an update

```sh
# No changes when the pinned release is already npm's latest.
pnpm sdk:update

# An exact published version also rebuilds the current release after patch edits.
pnpm sdk:update 7.0.0-rc14

pnpm install --frozen-lockfile --ignore-scripts
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm verify:build
pnpm sdk:verify
```

SDK checks and isolated package validation finish before the command copies generated dependency files into the CLI checkout. It preserves the temporary directories for diagnosis and does not automatically remove them. Run maintenance in a development checkout, separately from any deployed runtime directory.

A failed patch application stops the update with its patch name and workspace path. An application without textual conflicts still requires both CI jobs. When upstream incorporates a fix, review behavioral equivalence, retire only the redundant production hunks and keep the regression tests as a test-only source patch. Patches are never silently skipped or automatically removed.

## Automated proposals

[`update-baileys.yml`](../.github/workflows/update-baileys.yml) checks npm's `latest` release daily and supports manual dispatch with an exact version. The preparation job has read access and builds/tests the SDK. A separate job with write access receives only the proposed dependency data, preserves canonical source patches and unrelated package settings, and opens or updates one PR on `automation/baileys-update`. A branch edited by someone other than the bot is preserved and requires intervention.

The workflow uses the repository's `GITHUB_TOKEN`, without a personal token or GitHub App secret. Repository settings must allow Actions to create PRs. It explicitly dispatches `ci.yml` on the update branch because ordinary PR events created by `GITHUB_TOKEN` can await approval. The dispatched CI runs with read permissions and supplies the same required checks as ordinary PR CI.

The proposal remains open if CLI CI fails; a source conflict or SDK preparation failure leaves a failed update workflow for diagnosis. There is no automatic merge, release publication or runtime deployment. Review the diff and squash merge after both required checks pass. Leave the bot branch to the workflow; make manual patch changes on a separate branch.
