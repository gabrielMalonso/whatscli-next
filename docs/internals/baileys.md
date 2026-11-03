# The owned Baileys dependency

[gabrielMalonso/Baileys](https://github.com/gabrielMalonso/Baileys) owns SDK source changes, regression tests, upstream integration and compiled packages. The CLI consumes its validated GitHub Releases. SDK updates do not depend on acceptance of contributions to WhiskeySockets/Baileys.

`baileys.json` identifies the exact SDK source commit, upstream release/commit, package version, GitHub Release URL and SHA-512 integrity. `package.json` pins the compiled tarball URL; the pnpm lockfile records its integrity. Frozen installation with scripts ignored installs the compiled SDK without building it or applying SDK patches in this repository.

## Verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm sdk:verify
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm verify:build
```

`sdk:verify` checks the dependency URL, actual lockfile package resolution and installed package's embedded fork provenance. It is offline after installation. The full SDK source suite, lint/types, build and package preparation run in the SDK repository before a release is published. CLI tests independently verify compatibility, including read/archive evidence, receipt times and authenticated edits, with fictional fixtures and injected I/O. No live WhatsApp account/session is used.

## Updates

The SDK's daily `owned-upstream.yml` opens upstream integration PRs in **gabrielMalonso/Baileys**, preserving fork modifications with a three-way merge. Conflicts stop for manual review. After SDK CI passes and a PR is squash merged, the SDK publishes an immutable compiled package and release manifest in its own GitHub Releases. Existing assets are never overwritten.

The CLI's `update-baileys.yml` only checks those owned releases. It verifies downloaded package integrity, prepares the dependency and lockfile in isolation, and opens a PR in **gabrielMalonso/whatscli-next**. It does not fetch upstream source, maintain SDK patches, publish SDK packages or create upstream PRs. The package and the CLI checks are both required before a manual squash merge; runtime deployment remains separate.

To propose the latest validated owned release manually:

```sh
pnpm sdk:update
pnpm install --frozen-lockfile --ignore-scripts
pnpm sdk:verify
```

Then run the full CLI checks above and review the dependency diff. The update command preserves unrelated package/workspace settings and temporary outputs under ignored `.tmp/`. Use a development checkout, separately from any deployed runtime directory.
