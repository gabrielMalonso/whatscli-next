import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandError } from './errors.js';
import {
  checkAncestors,
  checkPrivatePath,
  ensurePrivateDirectory,
  isMissing,
} from './private-paths.js';

export const OBS_LIMITS = {
  days: 5,
  bytes: 8 * 1024 * 1024,
  files: 32,
  // One fixed loss witness shares the global cap; clients never get separate files.
  segments: 31,
  segment: 256 * 1024,
  line: 4096,
  sampleMs: 60_000,
} as const;
const captureLimits = { records: 16, bytes: 64 * 1024, retryMs: 25 } as const;
const dayMs = 86400000;
// A segment contains one UTC day's records. Expire only after that whole day
// leaves the query window; per-record timestamps enforce its exact five days.
function segmentEnd(time: number): number {
  return (Math.floor(time / dayMs) + 1) * dayMs;
}
const segmentName = /^v1-(\d{13})-([a-f0-9-]{36})\.jsonl$/;
const lossName = 'loss-v1.json';
const codes = [
  'OK',
  'INVALID_ARGUMENT',
  'KEY_CONFLICT',
  'PRECONDITION_FAILED',
  'LOCAL_STATE',
  'UNKNOWN',
  'NOT_RUNNING',
  'TIMEOUT',
  'PROTOCOL',
] as const;
const actions = [
  'unknown',
  'help',
  'start',
  'status',
  'stop',
  'backup',
  'pair',
  'pair-qr',
  'pair-code',
  'chats',
  'chat',
  'messages',
  'search',
  'contact',
  'resolve',
  'group',
  'send',
  'send-file',
  'send-contact',
  'request',
  'events',
  'download',
  'archive',
  'unarchive',
  'read',
  'unread',
  'mark-read',
  'reconnect',
  'resync',
  'drop-connection',
  'observability',
] as const;
export type ObsAction = (typeof actions)[number];
export type ObsOrigin = 'cli' | 'rpc' | 'daemon' | 'probe' | 'runtime';
export type ObsCategory =
  | 'command'
  | 'transport'
  | 'execution'
  | 'parser'
  | 'lifecycle'
  | 'diagnostic'
  | 'sample';
type Preference = {
  version: 1;
  enabled: boolean;
  generation: string;
  secret: string;
};
type Configuration = {
  preference: Preference | null;
  configured: boolean | null;
  degraded: boolean;
};
export type ObsFields = {
  action?: ObsAction;
  correlation?: string;
  parent?: string;
  durationMs?: number;
  code?: string;
  ok?: boolean;
  requestBytes?: number;
  responseBytes?: number;
  stdoutBytes?: number;
  count?: number;
  empty?: boolean;
  output?: 'full' | 'compact';
  limit?: number;
  offset?: number;
  after?: number;
  unread?: boolean | 'unknown';
  archived?: boolean | 'unknown';
  resource?: string;
  query?: string;
  key?: string;
  message?: string;
  destination?: string;
  participant?: string;
  fromMe?: boolean;
  quoted?: boolean;
  value?: boolean;
  attempt?: 'uncertain' | 'sdk-returned';
  replay?: boolean;
  invoked?: boolean;
  errorObserved?: boolean;
  acceptance?: 'unknown' | 'server-ack';
  delivery?: 'unknown' | 'delivered';
  read?: 'unknown' | 'read';
  connection?: string;
  recovery?: string;
  build?: string | null;
  label?: string;
  issue?: string;
  operation?: 'enable' | 'disable' | 'status';
  phase?: 'requested';
  coverage?: 'partial';
  appState?: 'unknown';
  cpuUserUs?: number;
  cpuSystemUs?: number;
  elapsedMs?: number;
  rssBytes?: number;
  heapBytes?: number;
  lagMs?: number;
};
export type ObsRecord = ObsFields & {
  schema: 1;
  timestamp: string;
  origin: ObsOrigin;
  category: ObsCategory;
  span: string;
  generation: string;
  session: string;
  dropped: number;
  uncertain?: number;
  evicted: number;
  expired: number;
};

export function obsAction(value: unknown): ObsAction {
  return actions.find((action) => action === value) ?? 'unknown';
}
export function obsCode(value: unknown): string {
  return codes.find((code) => code === value) ?? 'UNKNOWN';
}

function safeDirectory(directory: string): void {
  checkAncestors(directory);
  checkPrivatePath(directory, 'directory');
}
type PreferenceFile = Readonly<{ fd: number; dev: bigint; ino: bigint }>;
type PreferenceLease = PreferenceFile & Readonly<{ generation: string }>;

function readPrivate(
  path: string,
  max: number,
  retain?: { file?: PreferenceFile },
): string {
  checkPrivatePath(path, 'file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.nlink !== 1 ||
      stat.size > max
    )
      throw new Error('Unsafe observability file');
    const bytes = Buffer.alloc(max + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > max || count !== stat.size || fstatSync(fd).size !== stat.size)
      throw new Error('Incomplete or changing observability file');
    if (retain) {
      const identity = fstatSync(fd, { bigint: true });
      retain.file = { fd, dev: identity.dev, ino: identity.ino };
    }
    return bytes.subarray(0, count).toString('utf8');
  } finally {
    if (retain?.file?.fd !== fd) closeSync(fd);
  }
}
export function readObservability(directory: string): Configuration {
  return loadObservability(directory).configuration;
}
function loadObservability(
  directory: string,
  retain = false,
): {
  configuration: Configuration;
  lease?: PreferenceLease;
} {
  const opened: { file?: PreferenceFile } = {};
  const release = (): void => {
    const file = opened.file;
    delete opened.file; // Never retry close: its descriptor may already have been reused.
    if (file) closeSync(file.fd);
  };
  try {
    safeDirectory(directory);
    let text: string;
    try {
      text = readPrivate(
        join(directory, 'observability.json'),
        512,
        retain ? opened : undefined,
      );
    } catch (error) {
      if (isMissing(error))
        return {
          configuration: {
            preference: null,
            configured: false,
            degraded: false,
          },
        };
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('enabled' in value) ||
      typeof value.enabled !== 'boolean' ||
      !('generation' in value) ||
      typeof value.generation !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.generation) ||
      !('secret' in value) ||
      typeof value.secret !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.secret) ||
      Object.keys(value).sort().join(',') !==
        'enabled,generation,secret,version'
    )
      throw new Error('Unsupported preference');
    const configuration: Configuration = {
      preference: value as Preference,
      configured: value.enabled,
      degraded: false,
    };
    if (value.enabled && opened.file) {
      const lease: PreferenceLease = {
        ...opened.file,
        generation: value.generation,
      };
      delete opened.file;
      return { configuration, lease };
    }
    release();
    return { configuration };
  } catch (error) {
    try {
      release();
    } catch {
      /* Configuration remains unreadable; no descriptor retry. */
    }
    if (isMissing(error)) {
      try {
        checkAncestors(directory, undefined, true);
        return {
          configuration: {
            preference: null,
            configured: false,
            degraded: false,
          },
        };
      } catch {
        /* Unknown namespace is never admitted. */
      }
    }
    return {
      configuration: { preference: null, configured: null, degraded: true },
    };
  }
}

function samePreference(directory: string, lease: PreferenceLease): boolean {
  const path = join(directory, 'observability.json');
  checkPrivatePath(path, 'file');
  const stat = lstatSync(path, { bigint: true });
  return stat.nlink === 1n && stat.dev === lease.dev && stat.ino === lease.ino;
}

class CaptureBusy extends Error {}

/** One non-waiting filesystem critical section across processes. Never steal an existing lock.
 * A crash in this short section leaves a visible degradation, rather than unsafe lock recovery.
 */
function exclusive<T>(
  directory: string,
  work: () => T,
  name: 'observability.lock' | 'observability-loss.lock' = 'observability.lock',
): T {
  safeDirectory(directory);
  const lock = join(directory, name);
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (
      name === 'observability.lock' &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST'
    )
      throw new CaptureBusy();
    throw error;
  }
  try {
    return work();
  } finally {
    rmdirSync(lock);
  }
}

export function configureObservability(
  directory: string,
  enabled: boolean,
): void {
  try {
    ensurePrivateDirectory(directory);
    exclusive(directory, () =>
      exclusive(
        directory,
        () => {
          const current = readObservability(directory);
          if (current.degraded) throw new Error('Unsupported preference');
          // Fixed pending name bounds crash remnants; an existing pending file is preserved.
          const pending = join(directory, 'observability.pending.json');
          const fd = openSync(
            pending,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              constants.O_NOFOLLOW,
            0o600,
          );
          const preference: Preference = current.preference
            ? { ...current.preference, enabled }
            : {
                version: 1,
                enabled,
                generation: randomBytes(16).toString('hex'),
                secret: randomBytes(32).toString('hex'),
              };
          const line = JSON.stringify(preference) + '\n';
          try {
            if (writeSync(fd, line) !== Buffer.byteLength(line))
              throw new Error('Incomplete preference write');
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          // Validate again before replacing a known preference. No permissions are repaired.
          if (current.preference)
            readPrivate(join(directory, 'observability.json'), 512);
          renameSync(pending, join(directory, 'observability.json'));
        },
        'observability-loss.lock',
      ),
    );
  } catch {
    throw new CommandError(
      'LOCAL_STATE',
      'Observability configuration could not be completed; the preference may have persisted. Inspect the private configuration/lock before retrying',
    );
  }
}

type Segment = {
  name: string;
  time: number;
  bytes: number;
  generation: string;
  partial: boolean;
};

type LossEvidence = {
  schema: 1;
  kind: 'capture-loss';
  timestamp: string;
  generation: string;
  origin: ObsOrigin;
};

/** A single retained witness, never a counter or a list of all affected clients. */
function readLoss(
  directory: string,
  generation: string | undefined,
): LossEvidence | null {
  safeDirectory(directory);
  const root = join(directory, 'observability');
  try {
    safeDirectory(root);
    const text = readPrivate(join(root, lossName), OBS_LIMITS.line);
    if (!text.endsWith('\n')) throw new Error('Incomplete loss witness');
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object')
      throw new Error('Invalid loss witness');
    const row = value as Partial<LossEvidence>;
    if (
      Object.keys(value).sort().join(',') !==
        'generation,kind,origin,schema,timestamp' ||
      row.schema !== 1 ||
      row.kind !== 'capture-loss' ||
      typeof row.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(row.timestamp)) ||
      new Date(row.timestamp).toISOString() !== row.timestamp ||
      typeof row.generation !== 'string' ||
      row.generation !== generation ||
      !['cli', 'rpc', 'daemon', 'probe', 'runtime'].includes(row.origin ?? '')
    )
      throw new Error('Unsupported loss witness');
    return {
      schema: 1,
      kind: 'capture-loss',
      timestamp: row.timestamp,
      generation: row.generation,
      origin: row.origin!,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function expireLoss(directory: string, generation: string, now: number): void {
  const loss = readLoss(directory, generation);
  if (
    !loss ||
    segmentEnd(Date.parse(loss.timestamp)) > now - OBS_LIMITS.days * dayMs
  )
    return;
  exclusive(
    directory,
    () => {
      const current = readLoss(directory, generation);
      if (
        current &&
        segmentEnd(Date.parse(current.timestamp)) <=
          now - OBS_LIMITS.days * dayMs
      )
        unlinkSync(join(directory, 'observability', lossName));
    },
    'observability-loss.lock',
  );
}

function persistLoss(
  directory: string,
  origin: ObsOrigin,
  now: number,
  lease?: PreferenceLease,
  eligible?: () => void,
): void {
  // Separate from the contended append lock. Configuration takes both locks in this order;
  // failure capture takes only this one, rechecks opt-in, and never waits or retries.
  exclusive(
    directory,
    () => {
      const config = readObservability(directory);
      if (!config.preference?.enabled || config.degraded) return;
      if (
        lease &&
        (lease.generation !== config.preference.generation ||
          !samePreference(directory, lease))
      )
        return;
      eligible?.();
      const root = join(directory, 'observability');
      ensurePrivateDirectory(root);
      const previous = readLoss(directory, config.preference.generation);
      if (previous) return; // Even expired evidence awaits ordinary maintenance; never replace it here.
      // Legacy directories can already contain 32 segments. Admit no 33rd file;
      // the ordinary writer reserves this slot on its next successful pass.
      const files = segments(root);
      if (
        files.length > OBS_LIMITS.segments ||
        files.some(
          (file) => file.generation !== config.preference?.generation,
        ) ||
        files.reduce((sum, file) => sum + file.bytes, 0) + OBS_LIMITS.line >
          OBS_LIMITS.bytes
      )
        throw new Error('No safe loss witness capacity');
      const loss: LossEvidence = {
        schema: 1,
        kind: 'capture-loss',
        timestamp: new Date(now).toISOString(),
        generation: config.preference.generation,
        origin,
      };
      const line = JSON.stringify(loss) + '\n';
      const fd = openSync(
        join(root, lossName),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (writeSync(fd, line) !== Buffer.byteLength(line))
          throw new Error('Incomplete loss witness');
      } finally {
        closeSync(fd);
      }
    },
    'observability-loss.lock',
  );
}
function segments(
  directory: string,
  onMissing?: () => void,
  onIncomplete?: () => void,
): Segment[] {
  safeDirectory(directory);
  const entries: string[] = [];
  const dir = opendirSync(directory);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      entries.push(entry.name);
      if (entries.length > OBS_LIMITS.files)
        throw new Error('Observability file cap or unexpected entries');
    }
  } finally {
    dir.closeSync();
  }
  return entries
    .flatMap((name) => {
      if (name === lossName) return [];
      try {
        const match = segmentName.exec(name);
        if (!match) throw new Error('Unrecognized observability entry');
        const stat = checkPrivatePath(join(directory, name), 'file');
        if (stat.nlink !== 1 || stat.size > OBS_LIMITS.segment)
          throw new Error('Unsafe segment');
        const fd = openSync(
          join(directory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const head = Buffer.alloc(OBS_LIMITS.line);
          const count = readSync(fd, head, 0, head.length, 0);
          const end = head.subarray(0, count).indexOf(10);
          if (end < 0) {
            // Readers can race creation before the first append. Preserve the entry and
            // report a gap; collectors still require a complete recognized header.
            if (onIncomplete) {
              onIncomplete();
              return [];
            }
            throw new Error('Unrecognized segment header');
          }
          const first: unknown = JSON.parse(
            head.subarray(0, end).toString('utf8'),
          );
          if (
            !first ||
            typeof first !== 'object' ||
            !('schema' in first) ||
            first.schema !== 1 ||
            !('generation' in first) ||
            typeof first.generation !== 'string' ||
            !/^[a-f0-9]{32}$/.test(first.generation)
          )
            throw new Error('Unrecognized segment header');
          const tail = Buffer.alloc(1);
          const partial =
            stat.size > 0 &&
            (readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10);
          return [
            {
              name,
              time: Number(match[1]),
              bytes: stat.size,
              generation: first.generation,
              partial,
            },
          ];
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if (isMissing(error)) {
          onMissing?.();
          return [];
        }
        throw error;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Allowlist projection also applies when reading logs: corrupted lines cannot become prompts. */
export function safeObsFields(input: ObsFields): ObsFields {
  const output: ObsFields = {};
  if (input.action !== undefined) output.action = obsAction(input.action);
  if (input.code !== undefined) output.code = obsCode(input.code);
  for (const name of [
    'correlation',
    'parent',
    'resource',
    'query',
    'key',
    'message',
    'destination',
    'participant',
  ] as const) {
    const value = input[name];
    if (typeof value === 'string' && /^[a-f0-9]{32}$/.test(value))
      output[name] = value;
  }
  for (const name of [
    'durationMs',
    'requestBytes',
    'responseBytes',
    'stdoutBytes',
    'count',
    'limit',
    'offset',
    'after',
    'cpuUserUs',
    'cpuSystemUs',
    'elapsedMs',
    'rssBytes',
    'heapBytes',
    'lagMs',
  ] as const) {
    const value = input[name];
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER
    )
      output[name] = value;
  }
  for (const name of [
    'ok',
    'empty',
    'quoted',
    'value',
    'replay',
    'invoked',
    'errorObserved',
    'fromMe',
  ] as const)
    if (typeof input[name] === 'boolean') output[name] = input[name];
  for (const name of ['unread', 'archived'] as const)
    if (typeof input[name] === 'boolean' || input[name] === 'unknown')
      output[name] = input[name];
  if (input.output === 'full' || input.output === 'compact')
    output.output = input.output;
  if (input.attempt === 'uncertain' || input.attempt === 'sdk-returned')
    output.attempt = input.attempt;
  if (input.acceptance === 'unknown' || input.acceptance === 'server-ack')
    output.acceptance = input.acceptance;
  if (input.delivery === 'unknown' || input.delivery === 'delivered')
    output.delivery = input.delivery;
  if (input.read === 'unknown' || input.read === 'read')
    output.read = input.read;
  if (
    input.build === null ||
    (typeof input.build === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(input.build))
  )
    output.build = input.build;
  if (
    typeof input.connection === 'string' &&
    ['offline', 'connecting', 'open', 'close'].includes(input.connection)
  )
    output.connection = input.connection;
  if (
    typeof input.recovery === 'string' &&
    [
      'offline',
      'connecting',
      'open',
      'waiting-retry',
      'intervention-required',
      'stopping',
    ].includes(input.recovery)
  )
    output.recovery = input.recovery;
  if (
    typeof input.label === 'string' &&
    [
      'startup',
      'shutdown',
      'sdk',
      'dependency',
      'fatal',
      'connection',
      'receipt',
      'observation',
    ].includes(input.label)
  )
    output.label = input.label;
  if (
    typeof input.issue === 'string' &&
    [
      'app-state-sync-incomplete',
      'initial-sync-timed-out',
      'decryption-or-integrity-failure',
    ].includes(input.issue)
  )
    output.issue = input.issue;
  if (
    input.operation === 'enable' ||
    input.operation === 'disable' ||
    input.operation === 'status'
  )
    output.operation = input.operation;
  if (input.phase === 'requested') output.phase = input.phase;
  if (input.coverage === 'partial') output.coverage = input.coverage;
  if (input.appState === 'unknown') output.appState = input.appState;
  return output;
}

type CaptureOutcome = 'invalidated' | 'not-written' | 'uncertain' | 'captured';
type CaptureBase = Omit<
  ObsRecord,
  'dropped' | 'uncertain' | 'evicted' | 'expired'
>;
type CaptureSnapshot = Readonly<{
  base: Readonly<CaptureBase>;
  lease: PreferenceLease;
  time: number;
  admittedAt: number;
  bytes: number;
}>;
type Admission =
  { kind: 'admitted'; snapshot: CaptureSnapshot } | { kind: 'not-admitted' };
type CaptureResult = { kind: CaptureOutcome } | { kind: 'busy' };
type PendingCapture = {
  snapshot: CaptureSnapshot;
  sequence: number;
  state: 'admitted' | 'deferred';
};
type Drain = {
  deadline: number;
  through: number;
  promise: Promise<void>;
  complete: () => void;
};

export class Observability {
  private configuration: Configuration = {
    preference: null,
    configured: false,
    degraded: false,
  };
  private dropped = 0;
  private totalDropped = 0;
  private uncertain = 0;
  private totalUncertain = 0;
  private failed = false;
  private cleanupFailed = false;
  private cleanupFailures = 0;
  private hashingFailed = false;
  private hashingFailures = 0;
  private maintenanceFailed = false;
  private evicted = 0;
  private expired = 0;
  private warned = false;
  private readonly pending: PendingCapture[] = [];
  private pendingBytes = 0;
  private capturing = false;
  private rejecting = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Drain | undefined;
  private readonly capture = {
    admitted: 0,
    captured: 0,
    deferred: 0,
    invalidated: 0,
    expired: 0,
    overflow: 0,
    schedulerDiscarded: 0,
    lockAttempts: 0,
    busyAttempts: 0,
    preparationFailures: 0,
    maxPending: 0,
    maxBytes: 0,
  };
  readonly session = randomBytes(16).toString('hex');
  constructor(
    readonly directory: string,
    readonly origin: ObsOrigin,
    private readonly now = Date.now,
    private readonly elapsed = () => performance.now(),
  ) {
    this.refresh();
  }
  refresh(): void {
    this.configuration = readObservability(this.directory);
  }
  get enabled(): boolean {
    return (
      this.configuration.configured === true && !this.configuration.degraded
    );
  }
  status() {
    this.refresh();
    let blocked: boolean;
    try {
      checkPrivatePath(join(this.directory, 'observability.lock'), 'directory');
      blocked = true;
    } catch (error) {
      blocked = !isMissing(error);
    }
    const degraded =
      this.configuration.degraded ||
      this.failed ||
      blocked ||
      this.cleanupFailed ||
      this.hashingFailed ||
      this.maintenanceFailed;
    return {
      configured: this.configuration.configured,
      enabled: this.enabled,
      effective: this.enabled && !this.closed && !degraded,
      degraded,
      dropped: this.totalDropped,
      uncertain: this.totalUncertain,
      cleanupFailures: this.cleanupFailures,
      hashingFailures: this.hashingFailures,
      components: {
        captureDegraded: this.failed || blocked,
        cleanupDegraded: this.cleanupFailed,
        hashingDegraded: this.hashingFailed,
        retentionDegraded: this.maintenanceFailed,
      },
      session: this.session,
      generation: this.configuration.preference?.generation ?? null,
      evicted: this.evicted,
      expired: this.expired,
      limits: OBS_LIMITS,
      directory: join(resolve(this.directory), 'observability'),
      scope: 'process-counters',
      captureCompleteness: 'unknown',
      buffer: {
        ...this.capture,
        pending: this.pending.length,
        bytes: this.pendingBytes,
        closed: this.closed,
        limits: captureLimits,
      },
    };
  }
  opaque(
    domain: 'resource' | 'query' | 'key' | 'correlation' | 'message',
    value: string,
  ): string | undefined {
    const preference = this.configuration.preference;
    if (!this.enabled || !preference || Buffer.byteLength(value) > 4096)
      return undefined;
    try {
      const digest = createHmac('sha256', Buffer.from(preference.secret, 'hex'))
        .update(domain + '\0')
        .update(value)
        .digest('hex')
        .slice(0, 32);
      this.hashingFailed = false;
      return digest;
    } catch {
      this.hashingFailed = true;
      this.hashingFailures++;
      this.warn();
      return undefined;
    }
  }
  failure(
    origin: ObsOrigin = this.origin,
    outcome: 'dropped' | 'uncertain' = 'dropped',
    lease?: PreferenceLease,
  ): void {
    this.countFailure(outcome);
    try {
      if (this.enabled) persistLoss(this.directory, origin, this.now(), lease);
    } catch {
      // Witness persistence is also fallible. Query always exposes unknown completeness.
    }
    this.warn();
  }
  private countFailure(outcome: 'dropped' | 'uncertain'): void {
    this.failed = true;
    if (outcome === 'dropped') {
      this.dropped++;
      this.totalDropped++;
    } else {
      this.uncertain++;
      this.totalUncertain++;
    }
  }
  private cleanupFailure(): void {
    this.cleanupFailed = true;
    this.cleanupFailures++;
    this.warn();
  }
  private warn(): void {
    if (!this.warned) {
      this.warned = true;
      try {
        process.stderr.write(
          '{"level":"diagnostic","code":"OBSERVABILITY_DEGRADED","message":"Optional telemetry degraded; inspect observability status"}\n',
        );
      } catch {
        /* No fallback. */
      }
    }
  }
  /** Expiration also runs while disabled, without generating telemetry. No daemon means
   * physical deletion waits for the next tool invocation; queries always enforce the TTL.
   */
  maintain(): boolean {
    this.refresh();
    const preference = this.configuration.preference;
    if (!preference) return false;
    try {
      const directory = join(this.directory, 'observability');
      safeDirectory(directory);
      let witnessFailed = false;
      const retained = exclusive(this.directory, () => {
        this.refresh();
        const current = this.configuration.preference;
        if (!current) throw new Error('Unreadable preference');
        const files = segments(directory);
        if (files.some((file) => file.generation !== current.generation))
          throw new Error('Unrecognized generation');
        // A witness has its own provenance/gate. Preserve a bad witness without
        // coupling it to expiration of recognized segments of this generation.
        try {
          expireLoss(this.directory, current.generation, this.now());
        } catch {
          witnessFailed = true;
        }
        let retained = 0;
        for (const file of files) {
          if (segmentEnd(file.time) <= this.now() - OBS_LIMITS.days * dayMs) {
            unlinkSync(join(directory, file.name));
            this.expired++;
          } else retained++;
        }
        try {
          return (
            retained > 0 ||
            readLoss(this.directory, current.generation) !== null
          );
        } catch {
          witnessFailed = true;
          return true;
        }
      });
      this.maintenanceFailed = witnessFailed;
      if (witnessFailed) this.warn();
      return retained || witnessFailed;
    } catch (error) {
      if (isMissing(error)) return false;
      this.maintenanceFailed = true;
      this.warn();
      return true;
    }
  }
  private admit(
    category: ObsCategory,
    fields: ObsFields,
    origin: ObsOrigin,
  ): Admission {
    if (this.closed || this.rejecting) return { kind: 'not-admitted' };
    const loaded = loadObservability(this.directory, true);
    this.configuration = loaded.configuration;
    if (!loaded.lease) return { kind: 'not-admitted' };
    try {
      const time = this.now();
      const base: Readonly<CaptureBase> = Object.freeze({
        schema: 1,
        timestamp: new Date(time).toISOString(),
        origin,
        category,
        span: randomBytes(16).toString('hex'),
        generation: loaded.lease.generation,
        session: this.session,
        ...safeObsFields(fields),
      });
      const snapshot: CaptureSnapshot = Object.freeze({
        base,
        lease: loaded.lease,
        time,
        admittedAt: this.elapsed(),
        bytes: Buffer.byteLength(JSON.stringify(base)),
      });
      // Preparation can reenter the lifetime owner through an injected boundary.
      if (this.closed || this.rejecting) {
        this.releaseLease(loaded.lease);
        return { kind: 'not-admitted' };
      }
      return { kind: 'admitted', snapshot };
    } catch {
      this.releaseLease(loaded.lease);
      this.preparationFailure();
      return { kind: 'not-admitted' };
    }
  }
  record(
    category: ObsCategory,
    fields: ObsFields = {},
    origin: ObsOrigin = this.origin,
  ): void {
    const admission = this.admit(category, fields, origin);
    if (admission.kind === 'not-admitted') return;
    const snapshot = admission.snapshot;
    this.capture.admitted++;
    if (
      this.pending.length >= captureLimits.records ||
      this.pendingBytes + snapshot.bytes > captureLimits.bytes
    ) {
      this.discard(snapshot, 'overflow');
      this.releaseLease(snapshot.lease);
      return;
    }
    const entry: PendingCapture = {
      snapshot,
      sequence: this.capture.admitted,
      state: 'admitted',
    };
    this.pending.push(entry);
    this.pendingBytes += snapshot.bytes;
    this.capture.maxPending = Math.max(
      this.capture.maxPending,
      this.pending.length,
    );
    this.capture.maxBytes = Math.max(this.capture.maxBytes, this.pendingBytes);
    // Reentrant capture joins the FIFO after the already admitted observation.
    if (this.capturing || this.pending.length > 1) this.defer(entry);
    this.flush();
  }
  private defer(entry: PendingCapture): void {
    if (entry.state === 'deferred') return;
    entry.state = 'deferred';
    this.capture.deferred++;
  }
  private releaseLease(lease: PreferenceLease): void {
    try {
      closeSync(lease.fd);
    } catch {
      this.cleanupFailure();
    }
  }
  private current(snapshot: CaptureSnapshot): boolean {
    try {
      const config = readObservability(this.directory);
      return (
        !config.degraded &&
        config.preference?.enabled === true &&
        config.preference.generation === snapshot.lease.generation &&
        samePreference(this.directory, snapshot.lease)
      );
    } catch {
      return false;
    }
  }
  preparationFailure(): void {
    this.capture.preparationFailures++;
    this.failed = true;
    this.warn();
  }
  private discard(
    snapshot: CaptureSnapshot,
    reason: 'expired' | 'overflow' | 'schedulerDiscarded',
  ): void {
    let counted = false;
    const count = (): void => {
      counted = true;
      this.capture[reason]++;
      this.countFailure('dropped');
      this.warn();
    };
    try {
      persistLoss(
        this.directory,
        snapshot.base.origin,
        this.now(),
        snapshot.lease,
        count,
      );
    } catch {
      // A busy/faulted witness cannot hide a known discard. This fallback only
      // counts a decision; publication still requires the witness gate/token.
      if (!counted && this.current(snapshot)) count();
    }
    if (!counted) this.capture.invalidated++;
  }
  private flush(): void {
    if (this.capturing) return;
    this.capturing = true;
    try {
      // Process only this finite batch. Reentrant arrivals use a later pass.
      let remaining = this.pending.length;
      while (this.pending.length && remaining-- > 0) {
        const entry = this.pending[0]!;
        const snapshot = entry.snapshot;
        const deadline = Math.min(
          snapshot.admittedAt + captureLimits.retryMs,
          this.draining?.deadline ?? Infinity,
        );
        // A delayed callback can outlive contention. Try the non-waiting append
        // once before expiring; only a still-busy lock may consume retry time.
        const result = this.append(snapshot);
        if (result.kind === 'busy') {
          this.defer(entry);
          if (this.elapsed() < deadline) break;
        }
        this.pending.shift();
        this.pendingBytes -= snapshot.bytes;
        if (result.kind === 'busy') this.discard(snapshot, 'expired');
        else if (result.kind === 'invalidated') this.capture.invalidated++;
        else if (result.kind !== 'captured')
          this.failure(
            snapshot.base.origin,
            result.kind === 'uncertain' ? 'uncertain' : 'dropped',
            snapshot.lease,
          );
        this.releaseLease(snapshot.lease);
      }
    } finally {
      this.capturing = false;
      this.finishDrain();
      if (this.pending.length) this.schedule();
    }
  }
  private schedule(): void {
    try {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.flush();
        }, 1);
        this.timer.unref();
      }
      if (this.draining) this.timer.ref();
    } catch {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      const pending = this.pending.splice(0);
      this.pendingBytes = 0;
      this.rejecting = true;
      try {
        for (const { snapshot } of pending) {
          this.discard(snapshot, 'schedulerDiscarded');
          this.releaseLease(snapshot.lease);
        }
      } finally {
        this.rejecting = false;
        this.finishDrain();
      }
    }
  }
  private finishDrain(): void {
    const drain = this.draining;
    if (
      drain &&
      (!this.pending.length || this.pending[0]!.sequence > drain.through)
    ) {
      this.draining = undefined;
      drain.complete();
    }
    if (!this.pending.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  /** Drain already admitted observations once, with a fixed budget and watermark.
   * New arrivals cannot extend it; filesystem calls/scheduling have no wall deadline.
   */
  drain(): Promise<void> {
    if (this.draining) return this.draining.promise;
    if (!this.pending.length) return Promise.resolve();
    let complete = (): void => {};
    const promise = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.draining = {
      promise,
      complete,
      through: this.capture.admitted,
      deadline: this.elapsed() + captureLimits.retryMs,
    };
    this.flush();
    return promise;
  }
  /** The lifetime owner seals admission before awaiting its final drain. */
  close(): Promise<void> {
    this.closed = true;
    return this.drain();
  }

  private append(snapshot: CaptureSnapshot): CaptureResult {
    // A write exception cannot establish how many bytes reached the file. Only a
    // complete byte count proves capture; close/release are separate outcomes.
    const attempt: { outcome: CaptureOutcome } = {
      outcome: 'not-written',
    };
    try {
      this.capture.lockAttempts++;
      exclusive(this.directory, () => {
        this.refresh();
        if (
          !this.enabled ||
          !this.configuration.preference ||
          this.configuration.preference.generation !==
            snapshot.lease.generation ||
          !samePreference(this.directory, snapshot.lease)
        ) {
          attempt.outcome = 'invalidated';
          return;
        }
        const directory = join(this.directory, 'observability');
        ensurePrivateDirectory(directory);
        let files = segments(directory);
        // A busy/unsafe witness must not prevent stream capture; query reports unreadable evidence.
        try {
          expireLoss(
            this.directory,
            this.configuration.preference.generation,
            this.now(),
          );
          this.maintenanceFailed = false;
        } catch {
          this.maintenanceFailed = true;
          this.warn();
        }
        let expired = 0;
        let evicted = 0;
        const now = this.now();
        const recordTime = snapshot.time;
        const remove = (file: Segment): void => {
          // Only generated recognized regular entries under this exclusive area are eligible.
          const path = join(directory, file.name);
          const stat = checkPrivatePath(path, 'file');
          if (stat.nlink !== 1) throw new Error('Unsafe segment');
          unlinkSync(path);
          files = files.filter((item) => item !== file);
        };
        if (
          files.some(
            (file) =>
              file.generation !== this.configuration.preference?.generation,
          )
        )
          throw new Error('Unrecognized segment generation');
        for (const file of [...files])
          if (segmentEnd(file.time) <= now - OBS_LIMITS.days * dayMs) {
            remove(file);
            expired++;
          }
        let last = files.at(-1);
        // Reserve a maximum line, so aggregate file/byte limits hold across short clients.
        if (
          last &&
          (last.partial ||
            last.bytes + OBS_LIMITS.line > OBS_LIMITS.segment ||
            segmentEnd(last.time) !== segmentEnd(recordTime))
        )
          last = undefined;
        while (
          files.length &&
          (files.reduce((sum, file) => sum + file.bytes, 0) + OBS_LIMITS.line >
            OBS_LIMITS.bytes - OBS_LIMITS.line ||
            files.length > OBS_LIMITS.segments ||
            (!last && files.length >= OBS_LIMITS.segments))
        ) {
          const first = files[0]!;
          remove(first);
          evicted++;
          if (last === first) last = undefined;
        }
        // Counters describe failures preceding this APPEND, even when the admitted
        // snapshot is older. Subtract only this carry after a complete write.
        const carry = { dropped: this.dropped, uncertain: this.uncertain };
        const record: ObsRecord = {
          ...snapshot.base,
          ...carry,
          evicted,
          expired,
        };
        const line = JSON.stringify(record) + '\n';
        if (Buffer.byteLength(line) > OBS_LIMITS.line)
          throw new Error('Oversized record');
        const path = join(
          directory,
          last?.name ?? `v1-${recordTime}-${randomUUID()}.jsonl`,
        );
        if (last) {
          // Never append after an interrupted/partial line.
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const tail = Buffer.alloc(1);
            if (
              last.bytes &&
              (readSync(fd, tail, 0, 1, last.bytes - 1) !== 1 || tail[0] !== 10)
            )
              throw new Error('Partial segment');
          } finally {
            closeSync(fd);
          }
        }
        const fd = openSync(
          path,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_NOFOLLOW |
            (last ? 0 : constants.O_CREAT | constants.O_EXCL),
          0o600,
        );
        try {
          attempt.outcome = 'uncertain';
          const count = writeSync(fd, line);
          attempt.outcome =
            count === Buffer.byteLength(line) ? 'captured' : 'not-written';
          if (attempt.outcome !== 'captured') throw new Error('Partial write');
        } finally {
          try {
            closeSync(fd);
          } catch {
            this.cleanupFailure();
          }
        }
        this.dropped -= carry.dropped;
        this.uncertain -= carry.uncertain;
        this.failed = this.dropped > 0 || this.uncertain > 0;
        this.capture.captured++;
        this.evicted += evicted;
        this.expired += expired;
      });
      return { kind: attempt.outcome };
    } catch (error) {
      if (error instanceof CaptureBusy) {
        this.capture.busyAttempts++;
        return { kind: 'busy' };
      }
      if (attempt.outcome === 'captured' || attempt.outcome === 'invalidated')
        this.cleanupFailure();
      return { kind: attempt.outcome };
    }
  }
}

export type ObsQuery = {
  from?: string;
  to?: string;
  action?: string;
  origin?: string;
  code?: string;
  correlation?: string;
  limit?: number;
  cursor?: string;
};
export function queryObservability(directory: string, query: ObsQuery) {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new CommandError(
      'INVALID_ARGUMENT',
      'Observability limit must be 1..500',
    );
  for (const time of [query.from, query.to])
    if (
      time !== undefined &&
      (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) ||
        !Number.isFinite(Date.parse(time)) ||
        new Date(time).toISOString() !== time)
    )
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Use UTC ISO timestamps with milliseconds',
      );
  if (query.from && query.to && query.from > query.to)
    throw new CommandError(
      'INVALID_ARGUMENT',
      'Observability from must precede to',
    );
  const from = query.from ? Date.parse(query.from) : undefined;
  const to = query.to ? Date.parse(query.to) : undefined;
  if (
    (query.action && obsAction(query.action) !== query.action) ||
    (query.code && obsCode(query.code) !== query.code) ||
    (query.origin &&
      !['cli', 'rpc', 'daemon', 'probe', 'runtime'].includes(query.origin)) ||
    (query.correlation && !/^[a-f0-9]{32}$/.test(query.correlation))
  )
    throw new CommandError('INVALID_ARGUMENT', 'Invalid observability filter');
  let cutoff = Date.now();
  const retainedAfter = cutoff - OBS_LIMITS.days * dayMs;
  let position = '';
  if (query.cursor) {
    if (!/^\d{13}:v1-\d{13}-[a-f0-9-]{36}\.jsonl:\d{1,7}$/.test(query.cursor))
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Invalid observability cursor',
      );
    cutoff = Number(query.cursor.slice(0, 13));
    position = query.cursor.slice(14);
  }
  safeDirectory(directory);
  const root = join(directory, 'observability');
  let files: Segment[];
  let missing = 0;
  let incompleteHeaders = 0;
  try {
    files = segments(
      root,
      () => {
        missing++;
      },
      () => {
        incompleteHeaders++;
      },
    );
  } catch (error) {
    if (isMissing(error)) files = [];
    else
      throw new CommandError(
        'LOCAL_STATE',
        'Observability area cannot be safely read; entries preserved',
      );
  }
  const records: ObsRecord[] = [];
  let invalid = 0;
  let scanned = 0;
  let next: string | null = null;
  let lastPosition = position;
  const maximumScan = 2000;
  outer: for (const file of files) {
    if (
      file.time > cutoff ||
      segmentEnd(file.time) <= retainedAfter ||
      (position && file.name < position.split(':')[0]!)
    )
      continue;
    let text: string;
    try {
      text = readPrivate(join(root, file.name), OBS_LIMITS.segment);
    } catch (error) {
      if (isMissing(error)) {
        missing++;
        continue;
      }
      invalid++;
      continue;
    }
    const lines = text.split('\n');
    if (lines.pop()) invalid++; // Only complete JSONL lines are evidence.
    for (let index = 0; index < lines.length; index++) {
      const at = `${file.name}:${String(index).padStart(7, '0')}`;
      if (at <= position) continue;
      if (scanned >= maximumScan || records.length >= limit) {
        next = `${cutoff}:${lastPosition}`;
        break outer;
      }
      lastPosition = at;
      scanned++;
      const line = lines[index]!;
      if (Buffer.byteLength(line) > OBS_LIMITS.line) {
        invalid++;
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object') throw new Error();
        const row = value as Partial<ObsRecord>;
        const timestamp =
          typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
        if (
          row.schema !== 1 ||
          typeof row.timestamp !== 'string' ||
          !Number.isFinite(timestamp) ||
          typeof row.span !== 'string' ||
          !/^[a-f0-9]{32}$/.test(row.span) ||
          typeof row.generation !== 'string' ||
          !/^[a-f0-9]{32}$/.test(row.generation) ||
          typeof row.session !== 'string' ||
          !/^[a-f0-9]{32}$/.test(row.session) ||
          !['cli', 'rpc', 'daemon', 'probe', 'runtime'].includes(
            row.origin ?? '',
          ) ||
          ![
            'command',
            'transport',
            'execution',
            'parser',
            'lifecycle',
            'diagnostic',
            'sample',
          ].includes(row.category ?? '')
        )
          throw new Error();
        if (
          timestamp <= retainedAfter ||
          timestamp > cutoff ||
          (from !== undefined && timestamp < from) ||
          (to !== undefined && timestamp > to)
        )
          continue;
        const record: ObsRecord = {
          schema: 1,
          timestamp: new Date(timestamp).toISOString(),
          origin: row.origin!,
          category: row.category!,
          span: row.span!,
          generation: row.generation!,
          session: row.session!,
          ...safeObsFields(row),
          dropped: safeCounter(row.dropped),
          ...(row.uncertain === undefined
            ? {}
            : { uncertain: safeCounter(row.uncertain) }),
          evicted: safeCounter(row.evicted),
          expired: safeCounter(row.expired),
        };
        if (
          (query.action && record.action !== query.action) ||
          (query.origin && record.origin !== query.origin) ||
          (query.code && record.code !== query.code) ||
          (query.correlation && record.correlation !== query.correlation)
        )
          continue;
        records.push(record);
      } catch {
        invalid++;
      }
    }
  }
  const groups = new Map<
    string,
    {
      origin: ObsOrigin;
      category: ObsCategory;
      action: ObsAction;
      count: number;
      errors: number;
      empty: number;
      durations: number[];
    }
  >();
  for (const row of records) {
    const key = `${row.origin}:${row.category}:${row.action ?? 'unknown'}`;
    const group = groups.get(key) ?? {
      origin: row.origin,
      category: row.category,
      action: row.action ?? 'unknown',
      count: 0,
      errors: 0,
      empty: 0,
      durations: [],
    };
    group.count++;
    if (row.ok === false) group.errors++;
    if (row.empty) group.empty++;
    if (row.durationMs !== undefined) group.durations.push(row.durationMs);
    groups.set(key, group);
  }
  const summary = [...groups.values()].map(({ durations, ...group }) => {
    durations.sort((a, b) => a - b);
    return {
      ...group,
      latencyMs: durations.length
        ? {
            n: durations.length,
            min: durations[0],
            p50: durations[Math.ceil(durations.length * 0.5) - 1],
            p95: durations[Math.ceil(durations.length * 0.95) - 1],
            max: durations.at(-1),
          }
        : null,
    };
  });
  let lossEvidence: LossEvidence | null = null;
  let lossEvidenceUnreadable: boolean;
  try {
    const config = readObservability(directory);
    const witness = readLoss(directory, config.preference?.generation);
    if (
      witness &&
      Date.parse(witness.timestamp) > retainedAfter &&
      Date.parse(witness.timestamp) <= cutoff
    )
      lossEvidence = witness;
    lossEvidenceUnreadable = config.degraded;
  } catch {
    lossEvidenceUnreadable = true;
  }
  return {
    records,
    next,
    cutoff: new Date(cutoff).toISOString(),
    scanned,
    invalid,
    missing,
    summary,
    summaryScope: 'returned-page-only',
    gaps: {
      captureCompleteness: 'unknown',
      lossEvidence,
      lossEvidenceScope: 'retained-data-directory',
      lossEvidenceUnreadable,
      retentionOrCapPossible: true,
      incompleteHeaders,
      cursorSegmentMissing:
        !!position &&
        !files.some(
          (file) =>
            position.startsWith(file.name + ':') &&
            segmentEnd(file.time) > retainedAfter,
        ),
    },
    coverage: 'best-effort-local',
    untrustedData: true,
  };
}
function safeCounter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
