import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const sdkRepository = 'gabrielMalonso/Baileys';
const cliRepository = 'gabrielMalonso/whatscli-next';
const manifestPath = 'baileys.json';
const projectFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

export type SdkRelease = {
  repository: string;
  sourceCommit: string;
  upstreamVersion: string;
  upstreamCommit: string;
  version: string;
  tag: string;
  integrity: string;
  tarball: string;
};

export function sdkRelease(value: unknown): SdkRelease {
  const data = record(value);
  if (
    data.repository !== sdkRepository ||
    typeof data.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.sourceCommit) ||
    typeof data.upstreamCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.upstreamCommit)
  )
    throw new Error('Expected provenance from our Baileys repository');
  if (
    typeof data.upstreamVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(data.upstreamVersion) ||
    data.version !==
      `${data.upstreamVersion}-gabriel.${data.sourceCommit.slice(0, 12)}`
  )
    throw new Error('Expected a commit-specific SDK version');
  if (
    data.tag !== `sdk-${data.sourceCommit}` ||
    data.tarball !==
      `https://github.com/${sdkRepository}/releases/download/${data.tag}/baileys.tgz`
  )
    throw new Error('Expected the immutable owned SDK release URL');
  if (
    typeof data.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(data.integrity)
  )
    throw new Error('Expected SDK package SHA-512 integrity');
  return {
    repository: data.repository,
    sourceCommit: data.sourceCommit,
    upstreamVersion: data.upstreamVersion,
    upstreamCommit: data.upstreamCommit,
    version: data.version,
    tag: data.tag,
    integrity: data.integrity,
    tarball: data.tarball,
  };
}

function json(path: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(path, 'utf8')));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function run(
  root: string,
  executable: string,
  args: string[],
  capture = false,
): string {
  process.stderr.write(`> ${executable} ${args.join(' ')}\n`);
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${executable} failed (${result.status})`);
  return result.stdout ?? '';
}

export function checkInstalledPackage(
  pkg: Record<string, unknown>,
  manifest: SdkRelease,
): void {
  const expected = {
    repository: sdkRepository,
    sourceCommit: manifest.sourceCommit,
    upstreamVersion: manifest.upstreamVersion,
    upstreamCommit: manifest.upstreamCommit,
  };
  if (
    pkg.name !== 'baileys' ||
    pkg.version !== manifest.version ||
    !isDeepStrictEqual(pkg.baileysFork, expected)
  )
    throw new Error('Installed SDK does not match the validated owned release');
}

async function sdkResolution(
  text: string,
  manifest: SdkRelease,
): Promise<Record<string, unknown>> {
  const { parse } = await import('yaml');
  const data = record(parse(text));
  const packages = record(data.packages);
  const matches = Object.entries(packages).filter(
    ([key]) =>
      key === manifest.tarball || key === `baileys@${manifest.tarball}`,
  );
  if (matches.length !== 1)
    throw new Error('Expected one locked owned SDK package');
  return record(record(matches[0]![1]).resolution);
}

export async function checkLockfile(
  text: string,
  manifest: SdkRelease,
): Promise<void> {
  if ((await sdkResolution(text, manifest)).integrity !== manifest.integrity)
    throw new Error('Locked SDK integrity differs from the owned release');
}

export async function pinLockfileIntegrity(
  text: string,
  manifest: SdkRelease,
): Promise<string> {
  const resolution = await sdkResolution(text, manifest);
  if (resolution.integrity !== undefined) {
    await checkLockfile(text, manifest);
    return text;
  }
  // pnpm 10 omits integrity for URL dependencies; record the already-verified release digest.
  const line = `    resolution: {tarball: ${manifest.tarball}}`;
  if (resolution.tarball !== manifest.tarball || text.split(line).length !== 2)
    throw new Error(
      'Unexpected SDK lockfile resolution; preserve it for review',
    );
  return text.replace(
    line,
    `    resolution: {integrity: ${manifest.integrity}, tarball: ${manifest.tarball}}`,
  );
}

async function verify(
  root: string,
  manifest = sdkRelease(json(join(root, manifestPath))),
): Promise<void> {
  if (
    record(json(join(root, 'package.json')).dependencies).baileys !==
    manifest.tarball
  )
    throw new Error('CLI dependency must pin our SDK release URL');
  await checkLockfile(
    readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
    manifest,
  );
  checkInstalledPackage(
    json(join(root, 'node_modules/baileys/package.json')),
    manifest,
  );
  process.stdout.write(
    `Verified owned Baileys ${manifest.version} from ${manifest.sourceCommit}.\n`,
  );
}

async function download(url: string): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': 'whatscli-next-sdk-updater',
  };
  if (new URL(url).hostname === 'api.github.com' && process.env.GH_TOKEN)
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`SDK release request failed: HTTP ${response.status}`);
  return response;
}

export function newestSdkCommit(
  commits: string[],
  mainHistory: string[],
  pinnedCommit?: string,
): string {
  const candidates = new Set([
    ...commits,
    ...(pinnedCommit ? [pinnedCommit] : []),
  ]);
  const newest = mainHistory.find((commit) => candidates.has(commit));
  if (!newest)
    throw new Error('No validated SDK release found in recent main history');
  return newest;
}

async function latestRelease(current?: SdkRelease): Promise<SdkRelease> {
  const values: unknown = await (
    await download(
      `https://api.github.com/repos/${sdkRepository}/releases?per_page=100`,
    )
  ).json();
  if (!Array.isArray(values)) throw new Error('Expected owned SDK releases');
  const releases = values
    .map(record)
    .filter(
      (r) =>
        r.draft === false &&
        r.prerelease === false &&
        typeof r.tag_name === 'string' &&
        /^sdk-[a-f0-9]{40}$/.test(r.tag_name),
    );
  const history: unknown = await (
    await download(
      `https://api.github.com/repos/${sdkRepository}/commits?sha=main&per_page=100`,
    )
  ).json();
  if (!Array.isArray(history)) throw new Error('Expected SDK main history');
  const mainCommits = history.map((value) => {
    const sha = record(value).sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha))
      throw new Error('Invalid SDK history commit');
    return sha;
  });
  // Publication completion order can differ from source order when CI runs overlap.
  const commit = newestSdkCommit(
    releases.map((release) => String(release.tag_name).slice(4)),
    mainCommits,
    current?.sourceCommit,
  );
  const data = sdkRelease(
    await (
      await download(
        `https://github.com/${sdkRepository}/releases/download/sdk-${commit}/sdk-release.json`,
      )
    ).json(),
  );
  if (data.tag !== `sdk-${commit}`)
    throw new Error('Release manifest tag mismatch');
  return data;
}

function output(changed: boolean): void {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

async function update(root: string): Promise<void> {
  const current = existsSync(join(root, manifestPath))
    ? sdkRelease(json(join(root, manifestPath)))
    : undefined;
  const next = await latestRelease(current);
  if (current) {
    if (current.sourceCommit === next.sourceCommit) {
      if (!isDeepStrictEqual(current, next))
        throw new Error(
          'An existing owned release changed provenance or integrity',
        );
      output(false);
      process.stdout.write(
        `Owned SDK ${current.version} is already current.\n`,
      );
      return;
    }
  }
  const bytes = Buffer.from(await (await download(next.tarball)).arrayBuffer());
  if (
    'sha512-' + createHash('sha512').update(bytes).digest('base64') !==
    next.integrity
  )
    throw new Error('Downloaded SDK integrity mismatch');
  mkdirSync(join(root, '.tmp'), { recursive: true });
  const stage = mkdtempSync(join(root, '.tmp/sdk-dependency-'));
  for (const path of projectFiles)
    copyFileSync(join(root, path), join(stage, path));
  const pkg = json(join(stage, 'package.json'));
  record(pkg.dependencies).baileys = next.tarball;
  writeJson(join(stage, 'package.json'), pkg);
  const configured = run(
    stage,
    'pnpm',
    ['config', 'get', 'patchedDependencies', '--json'],
    true,
  ).trim();
  if (configured && configured !== 'undefined') {
    const patches = record(JSON.parse(configured));
    if (Object.keys(patches).some((k) => !k.startsWith('baileys@')))
      throw new Error(
        'Preserve unrelated dependency patches before adopting the owned SDK',
      );
    run(stage, 'pnpm', [
      'config',
      'delete',
      '--location',
      'project',
      'patchedDependencies',
    ]);
  }
  run(stage, 'pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts']);
  const lockPath = join(stage, 'pnpm-lock.yaml');
  writeFileSync(
    lockPath,
    await pinLockfileIntegrity(readFileSync(lockPath, 'utf8'), next),
  );
  writeJson(join(stage, manifestPath), next);
  await verify(stage, next);
  run(stage, 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']);
  for (const path of [...projectFiles, manifestPath])
    copyFileSync(join(stage, path), join(root, path));
  for (const path of [...projectFiles, manifestPath]) {
    const target = join(root, '.tmp/baileys-update', path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  output(true);
  process.stdout.write(
    `Prepared dependency on owned SDK ${next.version}. Run the CLI checks before merging.\n`,
  );
}

export function validateUpdate(
  current: Record<string, unknown>,
  proposed: Record<string, unknown>,
  next: SdkRelease,
): void {
  const expected = structuredClone(current);
  record(expected.dependencies).baileys = next.tarball;
  if (!isDeepStrictEqual(expected, proposed))
    throw new Error('The dependency bot cannot change unrelated CLI settings');
}

function publish(root: string, input: string): void {
  const current = sdkRelease(json(join(root, manifestPath)));
  const next = sdkRelease(json(join(input, manifestPath)));
  validateUpdate(
    json(join(root, 'package.json')),
    json(join(input, 'package.json')),
    next,
  );
  if (
    !readFileSync(join(root, 'pnpm-workspace.yaml')).equals(
      readFileSync(join(input, 'pnpm-workspace.yaml')),
    )
  )
    throw new Error('Dependency update must preserve workspace settings');
  for (const path of ['package.json', 'pnpm-lock.yaml', manifestPath])
    copyFileSync(join(input, path), join(root, path));
  run(root, 'git', [
    'add',
    '--',
    'package.json',
    'pnpm-lock.yaml',
    manifestPath,
  ]);
  if (!run(root, 'git', ['diff', '--cached', '--name-only'], true).trim()) {
    process.stdout.write('No dependency changes to publish.\n');
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
    const c = record(
      JSON.parse(
        run(
          root,
          'gh',
          ['api', `repos/${cliRepository}/commits/${remote}`],
          true,
        ),
      ),
    );
    if (record(c.author).login !== 'github-actions[bot]')
      throw new Error('Preserve the human-edited dependency branch');
  }
  const prs: unknown = JSON.parse(
    run(
      root,
      'gh',
      [
        'api',
        `repos/${cliRepository}/pulls?state=open&head=gabrielMalonso:${branch}`,
      ],
      true,
    ),
  );
  if (
    !Array.isArray(prs) ||
    prs.length > 1 ||
    (prs.length && record(record(prs[0]).user).login !== 'github-actions[bot]')
  )
    throw new Error('Expected a bot-owned dependency PR');
  run(root, 'git', ['checkout', '-B', branch]);
  run(root, 'git', ['config', 'user.name', 'github-actions[bot]']);
  run(root, 'git', [
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  ]);
  const title = `chore(deps): consume owned Baileys ${next.version}`;
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
    `Consume our validated SDK release ${next.version} (previous ${current.version}).\n\nSDK source: https://github.com/${sdkRepository}/commit/${next.sourceCommit}\n\nSDK source maintenance and tests belong to that repository. This PR changes only the pinned CLI dependency and its provenance. Review both required CLI checks before manual squash merge.\n`,
  );
  if (prs.length)
    run(root, 'gh', [
      'pr',
      'edit',
      String(record(prs[0]).number),
      '--repo',
      cliRepository,
      '--title',
      title,
      '--body-file',
      body,
    ]);
  else
    run(root, 'gh', [
      'pr',
      'create',
      '--repo',
      cliRepository,
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      title,
      '--body-file',
      body,
    ]);
  run(root, 'gh', [
    'workflow',
    'run',
    'ci.yml',
    '--repo',
    cliRepository,
    '--ref',
    branch,
  ]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const location = dirname(fileURLToPath(import.meta.url));
  const root = resolve(
    location,
    location.endsWith('/dist/scripts') ? '../..' : '..',
  );
  try {
    switch (process.argv[2]) {
      case 'verify':
        await verify(root);
        break;
      case 'update':
        await update(root);
        break;
      case 'publish':
        if (
          process.env.GITHUB_ACTIONS !== 'true' ||
          process.env.GITHUB_REPOSITORY !== cliRepository ||
          !process.argv[3]
        )
          throw new Error('Publication is restricted to our CLI Action');
        publish(root, resolve(process.argv[3]));
        break;
      default:
        throw new Error(
          'Expected verify, update or publish ARTIFACT_DIRECTORY',
        );
    }
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Owned SDK dependency check failed'}\n`,
    );
    process.exitCode = 1;
  }
}
