# Pinned Baileys patch

`baileys@7.0.0-rc14` remains pinned in package.json. pnpm applies `baileys@7.0.0-rc14.patch` during frozen installation, including `--ignore-scripts`; the patch and its hash are recorded in the lockfile. This uses [pnpm's dependency patch mechanism](https://pnpm.io/10.x/cli/patch), so installation needs neither a private experimental tarball nor an SDK build step.

The patch contains the 32 compiled JavaScript, declaration and source-map files that differ between the published rc14 package and the SDK build described below. The base is `f5cd20ff83176c41a021e9ec0735e978dc3ff9b6`, whose source tree matches [gabrielMalonso/Baileys at 43055207616cac61c8c4ae95f7c29506df4a1f8c](https://github.com/gabrielMalonso/Baileys/commit/43055207616cac61c8c4ae95f7c29506df4a1f8c). Existing sources are proposed in [SDK PR #1](https://github.com/gabrielMalonso/Baileys/pull/1), [SDK PR #2](https://github.com/gabrielMalonso/Baileys/pull/2) and [SDK PR #3](https://github.com/gabrielMalonso/Baileys/pull/3), with the review correction in [SDK PR #4](https://github.com/gabrielMalonso/Baileys/pull/4). The fork also includes upstream's WIN_HYBRID platform change. The preflight sync commits outside the outgoing patch transaction, so a listener follow-up cannot reuse an already committed transaction context. Direct-chat receipt times now use `message-receipt.update`, leaving message timestamps unchanged. No dependency versions, credentials, Signal flows, MAC-verification defaults or generated WAProto bindings are changed by the patch.

`baileys-typed-echo.source.patch` is a reviewable source-and-test diff against that exact base. It makes the typed `app-state.update` chat action with `source: 'local-echo'` independent of `emitOwnEvents`; only legacy `processSyncAction` events remain gated. The patch is decoded once, preserving response evidence, request IDs, versions, ranges and transaction behavior. Local echo remains local evidence, separate from independently observed sync state.

To regenerate, start with a clean isolated SDK checkout at `f5cd20ff83176c41a021e9ec0735e978dc3ff9b6`. Set `cli_dir` to an absolute CLI checkout path and `sdk_dir` to the isolated SDK path, then run:

```sh
cd "$sdk_dir"
git apply --check "$cli_dir/patches/baileys-typed-echo.source.patch"
git apply "$cli_dir/patches/baileys-typed-echo.source.patch"
corepack yarn install --immutable --mode=skip-build
corepack yarn build
```

In an isolated CLI checkout with its dependencies installed, regenerate using pnpm 10.24.0:

```sh
pnpm patch baileys@7.0.0-rc14 --ignore-existing --edit-dir .tmp/baileys-patch
cp -R "$sdk_dir/lib/." .tmp/baileys-patch/lib/
npm_config_ignore_scripts=true npm_config_lockfile_only=true pnpm patch-commit .tmp/baileys-patch --patches-dir patches
```

This updates the compiled patch and the three patch-hash references in `pnpm-lock.yaml`. Review and copy only those files back to the working CLI checkout. Do not edit an installed package in place. Validate the regenerated patch in the isolated CLI checkout with `pnpm install --frozen-lockfile --ignore-scripts` and the contributor checks.

`test/baileys-patch.test.ts` exercises the installed package with fictional encrypted fixtures and MAC verification enabled. It checks that retiring an old record cannot reverse the new read/archive action, including the final hash/map. The source patch includes SDK tests covering read/unread and archive/unarchive with `emitOwnEvents` both disabled and enabled. They assert exactly one typed echo, preserved response/request correlation and ranges, and legacy events only when enabled. CLI tests separately cover the response event integration and queue projection. No live session is used by these tests.
