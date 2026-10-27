import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const upstream = 'https://github.com/WhiskeySockets/Baileys.git';
const manifestPath = 'patches/baileys-source.json';
const projectFiles = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
const packageFields = [
  'name',
  'version',
  'type',
  'main',
  'types',
  'exports',
  'engines',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'files',
] as const;

export type SdkManifest = {
  version: string;
  commit: string;
  integrity: string;
  patches: string[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

export function sdkVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(value)
  )
    throw new Error('Expected an exact Baileys release version');
  return value;
}

export function sdkManifest(value: unknown): SdkManifest {
  const data = object(value);
  const version = sdkVersion(data.version);
  if (typeof data.commit !== 'string' || !/^[a-f0-9]{40}$/.test(data.commit))
    throw new Error('Expected the upstream release commit');
  if (
    typeof data.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(data.integrity)
  )
    throw new Error('Expected the published package SHA-512 integrity');
  if (
    !Array.isArray(data.patches) ||
    !data.patches.every(
      (path: unknown) =>
        typeof path === 'string' &&
        /^baileys-source\/[0-9A-Za-z-]+\.patch$/.test(path),
    ) ||
    new Set(data.patches).size !== data.patches.length
  )
    throw new Error(
      'Expected unique source patches inside patches/baileys-source',
    );
  return {
    version,
    commit: data.commit,
    integrity: data.integrity,
    patches: data.patches,
  };
}

function readJson(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(path, 'utf8')));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function command(
  cwd: string,
  name: string,
  args: string[],
  capture = false,
  env: NodeJS.ProcessEnv = process.env,
): string {
  process.stderr.write(`> ${name} ${args.join(' ')}\n`);
  const result = spawnSync(name, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${name} failed (${result.status ?? result.signal})`);
  return result.stdout ?? '';
}

function files(directory: string, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const key = prefix + name;
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const [child, file] of files(path, key + '/'))
        result.set(child, file);
    } else if (stat.isFile()) result.set(key, path);
    else throw new Error(`Unexpected non-regular SDK file: ${key}`);
  }
  return result;
}

export function sameSdkBytes(
  name: string,
  left: Buffer,
  right: Buffer,
): boolean {
  if (left.equals(right)) return true;
  // pnpm can add a terminal newline when applying a one-line source-map patch.
  if (!name.endsWith('.map')) return false;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (left[leftEnd - 1] === 10) leftEnd--;
  while (right[rightEnd - 1] === 10) rightEnd--;
  return left.subarray(0, leftEnd).equals(right.subarray(0, rightEnd));
}

export function compareSdkFiles(left: string, right: string): void {
  const expected = files(left);
  const actual = files(right);
  if (!isDeepStrictEqual([...expected.keys()], [...actual.keys()]))
    throw new Error('SDK package file inventory differs from its source build');
  for (const [name, path] of expected) {
    if (
      !sameSdkBytes(name, readFileSync(path), readFileSync(actual.get(name)!))
    )
      throw new Error(`SDK package differs from source: ${name}`);
  }
}

export function comparePackageMetadata(
  source: Record<string, unknown>,
  published: Record<string, unknown>,
): void {
  for (const field of packageFields) {
    if (!isDeepStrictEqual(source[field], published[field]))
      throw new Error(
        `Published SDK metadata differs from release source: ${field}`,
      );
  }
}

function registryManifest(
  root: string,
  version: string,
  patches: string[],
): SdkManifest {
  if (version !== 'latest') sdkVersion(version);
  const data = object(
    JSON.parse(
      command(
        root,
        'npm',
        [
          'view',
          `baileys@${version}`,
          'version',
          'gitHead',
          'dist.integrity',
          '--registry=https://registry.npmjs.org',
          '--json',
        ],
        true,
      ),
    ),
  );
  return sdkManifest({
    version: data.version,
    commit: data.gitHead,
    integrity: data['dist.integrity'],
    patches,
  });
}

function patchedDependencies(root: string): Record<string, unknown> {
  return object(
    JSON.parse(
      command(
        root,
        'pnpm',
        ['config', 'get', 'patchedDependencies', '--json'],
        true,
      ),
    ),
  );
}

export function setSdkPatch(
  root: string,
  version: string,
  enabled = true,
  run = command,
): void {
  run(root, 'pnpm', [
    'config',
    'set',
    '--location',
    'project',
    '--json',
    'patchedDependencies',
    JSON.stringify(
      enabled
        ? {
            [`baileys@${sdkVersion(version)}`]: `patches/baileys@${version}.patch`,
          }
        : {},
    ),
  ]);
}

function temporaryDirectory(root: string): string {
  mkdirSync(join(root, '.tmp'), { recursive: true });
  return mkdtempSync(join(root, '.tmp', 'baileys-'));
}

function prepareSdk(root: string, work: string, manifest: SdkManifest): string {
  const sdk = join(work, 'source');
  command(work, 'git', ['init', '--quiet', sdk]);
  command(sdk, 'git', ['fetch', '--depth=1', upstream, manifest.commit]);
  command(sdk, 'git', ['checkout', '--detach', 'FETCH_HEAD']);
  if (
    command(sdk, 'git', ['rev-parse', 'HEAD'], true).trim() !== manifest.commit
  )
    throw new Error('Fetched SDK commit does not match the manifest');
  if (readJson(join(sdk, 'package.json')).version !== manifest.version)
    throw new Error('SDK source version does not match the published release');
  const changed = new Set<string>();
  for (const patch of manifest.patches) {
    const path = join(root, 'patches', patch);
    for (const row of command(sdk, 'git', ['apply', '--numstat', path], true)
      .trim()
      .split('\n')) {
      const file = row.split('\t')[2];
      if (
        !file ||
        (!file.startsWith('src/') && file !== 'APP_STATE.md') ||
        !/^[\w./-]+$/.test(file) ||
        file.split('/').includes('..')
      )
        throw new Error(
          `Source patches must not change SDK packaging or dependencies: ${file}`,
        );
      changed.add(file);
    }
    try {
      command(sdk, 'git', ['apply', '--check', path]);
      command(sdk, 'git', ['apply', path]);
    } catch {
      throw new Error(
        `Source patch ${patch} no longer applies. Review upstream equivalence; retain regression tests when retiring a patch. Work preserved at ${work}`,
      );
    }
  }
  command(sdk, 'git', ['diff', '--check']);
  command(sdk, 'corepack', [
    'yarn',
    'install',
    '--immutable',
    '--mode=skip-build',
  ]);
  if (changed.size)
    command(sdk, 'corepack', [
      'yarn',
      'prettier',
      '--check',
      ...[...changed].filter((path) => existsSync(join(sdk, path))),
    ]);
  command(sdk, 'corepack', ['yarn', 'lint']);
  command(sdk, 'corepack', ['yarn', 'test', '--runInBand']);
  command(sdk, 'corepack', ['yarn', 'build']);
  return sdk;
}

function generatePackage(
  root: string,
  work: string,
  sdk: string,
  next: SdkManifest,
): string {
  const stage = join(work, 'package');
  mkdirSync(join(stage, 'patches'), { recursive: true });
  for (const path of projectFiles)
    copyFileSync(join(root, path), join(stage, path));
  const pkg = readJson(join(stage, 'package.json'));
  object(pkg.dependencies).baileys = next.version;
  writeJson(join(stage, 'package.json'), pkg);
  command(stage, 'pnpm', [
    'config',
    'set',
    '--location',
    'project',
    '--json',
    'patchedDependencies',
    '{}',
  ]);
  command(stage, 'pnpm', ['install', '--ignore-scripts']);
  const edit = join(work, 'edit');
  command(stage, 'pnpm', [
    'patch',
    `baileys@${next.version}`,
    '--ignore-existing',
    '--edit-dir',
    edit,
  ]);
  comparePackageMetadata(
    readJson(join(sdk, 'package.json')),
    readJson(join(edit, 'package.json')),
  );
  compareSdkFiles(join(sdk, 'WAProto'), join(edit, 'WAProto'));
  if (
    !readFileSync(join(sdk, 'engine-requirements.js')).equals(
      readFileSync(join(edit, 'engine-requirements.js')),
    )
  )
    throw new Error('Published SDK engine requirements differ from source');
  const original = files(join(edit, 'lib'));
  const generated = files(join(sdk, 'lib'));
  for (const [name, path] of original)
    if (!generated.has(name)) unlinkSync(path);
  for (const [name, path] of generated) {
    const target = join(edit, 'lib', name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
  }
  command(
    stage,
    'pnpm',
    ['patch-commit', edit, '--patches-dir', 'patches'],
    false,
    {
      ...process.env,
      npm_config_ignore_scripts: 'true',
      npm_config_lockfile_only: 'true',
    },
  );
  // Check the integrity actually recorded by pnpm, not only the registry response.
  const lock = readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8');
  const escapedVersion = next.version.replaceAll('.', '\\.');
  const resolution = new RegExp(
    `^  baileys@${escapedVersion}:\\n    resolution: \\{integrity: ([^}]+)\\}`,
    'm',
  ).exec(lock);
  if (resolution?.[1] !== next.integrity)
    throw new Error(
      'pnpm SDK integrity does not match the pinned registry metadata',
    );
  command(stage, 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']);
  compareSdkFiles(join(sdk, 'lib'), join(stage, 'node_modules/baileys/lib'));
  return stage;
}

function artifact(root: string, manifest: SdkManifest): void {
  const directory = join(root, '.tmp/baileys-update');
  const paths = [
    ...projectFiles,
    manifestPath,
    `patches/baileys@${manifest.version}.patch`,
  ];
  for (const path of paths) {
    if (!existsSync(join(root, path))) continue;
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
}

export function maintainSdk(
  root: string,
  mode: 'verify' | 'update',
  version?: string,
): void {
  const current = sdkManifest(readJson(join(root, manifestPath)));
  const pkg = readJson(join(root, 'package.json'));
  if (object(pkg.dependencies).baileys !== current.version)
    throw new Error('CLI dependency and source manifest versions differ');
  const patches = patchedDependencies(root);
  const currentPatch = `patches/baileys@${current.version}.patch`;
  const expectedPatchCount = existsSync(join(root, currentPatch)) ? 1 : 0;
  if (
    Object.keys(patches).length !== expectedPatchCount ||
    (expectedPatchCount && !patches[`baileys@${current.version}`])
  )
    throw new Error('Expected exactly the pinned Baileys dependency patch');
  const next = registryManifest(
    root,
    mode === 'verify' ? current.version : (version ?? 'latest'),
    current.patches,
  );
  if (next.version === current.version && !isDeepStrictEqual(current, next))
    throw new Error('An existing SDK release must not change provenance');
  if (mode === 'verify' && !isDeepStrictEqual(current, next))
    throw new Error(
      'Published release provenance differs from the pinned manifest',
    );
  if (
    mode === 'update' &&
    (version === undefined || version === 'latest') &&
    next.version === current.version
  ) {
    process.stdout.write(
      `Baileys ${current.version} is already the latest published release.\n`,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, 'changed=false\n');
    return;
  }
  const work = temporaryDirectory(root);
  process.stderr.write(`SDK verification workspace: ${work}\n`);
  const sdk = prepareSdk(root, work, next);
  const stage = generatePackage(root, work, sdk, next);
  const nextPatch = `patches/baileys@${next.version}.patch`;
  if (mode === 'verify') {
    if (
      existsSync(join(root, currentPatch)) !==
      existsSync(join(stage, nextPatch))
    )
      throw new Error(
        'Generated SDK patch presence differs from the committed patch',
      );
    for (const path of [
      ...projectFiles,
      ...(existsSync(join(stage, nextPatch)) ? [nextPatch] : []),
    ]) {
      if (
        !readFileSync(join(root, path)).equals(readFileSync(join(stage, path)))
      )
        throw new Error(
          `Generated ${path} differs; run pnpm sdk:update ${current.version} and review the result`,
        );
    }
    compareSdkFiles(join(sdk, 'lib'), join(root, 'node_modules/baileys/lib'));
    process.stdout.write(
      `Verified Baileys ${current.version}: source tests, build, patch and installed package.\n`,
    );
    return;
  }
  for (const path of [
    ...projectFiles,
    ...(existsSync(join(stage, nextPatch)) ? [nextPatch] : []),
  ])
    copyFileSync(join(stage, path), join(root, path));
  writeJson(join(root, manifestPath), next);
  if (
    existsSync(join(root, currentPatch)) &&
    (current.version !== next.version || !existsSync(join(stage, nextPatch)))
  )
    unlinkSync(join(root, currentPatch));
  artifact(root, next);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, 'changed=true\n');
  process.stdout.write(
    `Prepared Baileys ${current.version} → ${next.version}. Install frozen dependencies and run the CLI checks before merging.\n`,
  );
}

export function validateSdkUpdate(
  current: SdkManifest,
  next: SdkManifest,
  currentPackage: Record<string, unknown>,
  nextPackage: Record<string, unknown>,
): void {
  if (!isDeepStrictEqual(current.patches, next.patches))
    throw new Error('The update bot cannot change canonical source patches');
  const expected = structuredClone(currentPackage);
  object(expected.dependencies).baileys = next.version;
  if (!isDeepStrictEqual(expected, nextPackage))
    throw new Error(
      'The update bot can only change the Baileys dependency in package.json',
    );
  if (
    current.version === next.version &&
    (current.commit !== next.commit || current.integrity !== next.integrity)
  )
    throw new Error('An existing SDK release must not change provenance');
}

export function publishUpdate(
  root: string,
  input: string,
  repository: string,
  run = command,
): void {
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Expected GITHUB_REPOSITORY');
  const current = sdkManifest(readJson(join(root, manifestPath)));
  const next = sdkManifest(readJson(join(input, manifestPath)));
  validateSdkUpdate(
    current,
    next,
    readJson(join(root, 'package.json')),
    readJson(join(input, 'package.json')),
  );
  const patch = `patches/baileys@${next.version}.patch`;
  const oldPatch = `patches/baileys@${current.version}.patch`;
  // Only data files cross from the build job into this job with write access.
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    manifestPath,
    ...(existsSync(join(input, patch)) ? [patch] : []),
  ]) {
    const source = join(input, path);
    if (!lstatSync(source).isFile())
      throw new Error(`Expected regular update artifact: ${path}`);
    copyFileSync(source, join(root, path));
  }
  setSdkPatch(root, next.version, existsSync(join(input, patch)), run);
  if (
    !readFileSync(join(root, 'pnpm-workspace.yaml')).equals(
      readFileSync(join(input, 'pnpm-workspace.yaml')),
    )
  )
    throw new Error(
      'Update artifact changes unrelated pnpm workspace settings',
    );
  if (
    existsSync(join(root, oldPatch)) &&
    (current.version !== next.version || !existsSync(join(input, patch)))
  )
    unlinkSync(join(root, oldPatch));
  const paths = [...projectFiles, manifestPath, oldPatch, patch].filter(
    (p, i, all) => all.indexOf(p) === i,
  );
  const trackedOldPatch = run(
    root,
    'git',
    ['ls-files', '--', oldPatch],
    true,
  ).trim();
  run(root, 'git', [
    'add',
    '--all',
    '--',
    ...paths.filter((p) => existsSync(join(root, p)) || p === trackedOldPatch),
  ]);
  if (!run(root, 'git', ['diff', '--cached', '--name-only'], true).trim()) {
    process.stdout.write('No SDK update changes to publish.\n');
    return;
  }
  const branch = 'automation/baileys-update';
  run(root, 'gh', ['auth', 'setup-git']);
  const remote =
    run(
      root,
      'git',
      ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
      true,
    ).split(/\s+/)[0] ?? '';
  if (remote) {
    const commit = object(
      JSON.parse(
        run(root, 'gh', ['api', `repos/${repository}/commits/${remote}`], true),
      ),
    );
    if (object(commit.author).login !== 'github-actions[bot]')
      throw new Error(
        'Refusing to replace an update branch edited by someone else',
      );
  }
  const owner = repository.split('/')[0]!;
  const prs: unknown = JSON.parse(
    run(
      root,
      'gh',
      ['api', `repos/${repository}/pulls?state=open&head=${owner}:${branch}`],
      true,
    ),
  );
  if (!Array.isArray(prs) || prs.length > 1)
    throw new Error('Expected at most one SDK update PR');
  if (prs.length && object(object(prs[0]).user).login !== 'github-actions[bot]')
    throw new Error('Expected a bot-owned update PR');
  run(root, 'git', ['checkout', '-B', branch]);
  run(root, 'git', ['config', 'user.name', 'github-actions[bot]']);
  run(root, 'git', [
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  ]);
  const title = `chore(deps): update Baileys to ${next.version}`;
  run(root, 'git', ['commit', '-m', title]);
  run(root, 'git', [
    'push',
    `--force-with-lease=refs/heads/${branch}:${remote}`,
    'origin',
    `HEAD:refs/heads/${branch}`,
  ]);
  const body = join(root, '.tmp/baileys-update-body.md');
  mkdirSync(dirname(body), { recursive: true });
  writeFileSync(
    body,
    `Update the pinned Baileys release from ${current.version} to ${next.version}, retaining the canonical source patches.\n\nUpstream source: https://github.com/WhiskeySockets/Baileys/commit/${next.commit}\n\nThe SDK source passed lint, regression tests and build during preparation. Required CI rebuilds it, checks the generated patch and installed package, and runs the CLI checks. Merge manually with squash only after both required checks pass.\n`,
  );
  if (prs.length) {
    const pr = object(prs[0]);
    run(root, 'gh', [
      'pr',
      'edit',
      String(pr.number),
      '--title',
      title,
      '--body-file',
      body,
    ]);
  } else
    run(root, 'gh', [
      'pr',
      'create',
      '--head',
      branch,
      '--base',
      'main',
      '--title',
      title,
      '--body-file',
      body,
    ]);
  // GITHUB_TOKEN PR events can require approval; explicit dispatch always starts CI.
  run(root, 'gh', ['workflow', 'run', 'ci.yml', '--ref', branch]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, version, ...extra] = process.argv.slice(2);
  if (
    (mode !== 'verify' && mode !== 'update' && mode !== 'publish') ||
    extra.length ||
    (mode === 'verify' && version) ||
    (mode === 'publish' && !version)
  ) {
    process.stderr.write(
      'Usage: node scripts/baileys.ts verify | update [latest|VERSION] | publish ARTIFACT_DIRECTORY\n',
    );
    process.exitCode = 1;
  } else {
    const location = dirname(fileURLToPath(import.meta.url));
    const root = resolve(
      location,
      location.endsWith('/dist/scripts') ? '../..' : '..',
    );
    if (
      !existsSync(join(root, manifestPath)) ||
      relative(root, process.cwd()).startsWith('..')
    )
      throw new Error(
        'Run the SDK maintenance command inside this CLI checkout',
      );
    try {
      if (mode === 'publish') {
        if (process.env.GITHUB_ACTIONS !== 'true')
          throw new Error('PR publication is restricted to GitHub Actions');
        publishUpdate(
          root,
          resolve(version!),
          process.env.GITHUB_REPOSITORY ?? '',
        );
      } else maintainSdk(root, mode, version);
    } catch (error: unknown) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'SDK maintenance failed'}\n`,
      );
      process.exitCode = 1;
    }
  }
}
