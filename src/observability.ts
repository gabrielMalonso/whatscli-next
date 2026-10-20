import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandError } from './errors.js';
import { checkAncestors, checkPrivatePath, ensurePrivateDirectory, isMissing } from './private-paths.js';

export const OBS_LIMITS = { days: 5, bytes: 8 * 1024 * 1024, files: 32, segment: 256 * 1024, line: 4096, sampleMs: 60_000 } as const;
const segmentName = /^v1-(\d{13})-([a-f0-9-]{36})\.jsonl$/;
const codes = ['OK', 'INVALID_ARGUMENT', 'KEY_CONFLICT', 'PRECONDITION_FAILED', 'LOCAL_STATE', 'UNKNOWN', 'NOT_RUNNING', 'TIMEOUT', 'PROTOCOL'] as const;
const actions = ['unknown', 'help', 'start', 'status', 'stop', 'backup', 'pair', 'pair-qr', 'pair-code', 'chats', 'chat', 'messages', 'search', 'contact', 'resolve', 'group', 'send', 'send-file', 'send-contact', 'request', 'events', 'download', 'archive', 'unarchive', 'read', 'unread', 'mark-read', 'reconnect', 'resync', 'drop-connection', 'observability'] as const;
export type ObsAction = typeof actions[number];
export type ObsOrigin = 'cli' | 'rpc' | 'daemon' | 'probe' | 'runtime';
export type ObsCategory = 'command' | 'transport' | 'execution' | 'parser' | 'lifecycle' | 'diagnostic' | 'sample';
type Preference = { version: 1; enabled: boolean; generation: string; secret: string };
type Configuration = { preference: Preference | null; configured: boolean | null; degraded: boolean };
export type ObsFields = {
  action?: ObsAction; correlation?: string; parent?: string; durationMs?: number; code?: string; ok?: boolean;
  requestBytes?: number; responseBytes?: number; stdoutBytes?: number; count?: number; empty?: boolean;
  output?: 'full' | 'compact'; limit?: number; offset?: number; after?: number; unread?: boolean | 'unknown'; archived?: boolean | 'unknown';
  resource?: string; query?: string; key?: string; message?: string; destination?: string; participant?: string; fromMe?: boolean; quoted?: boolean; value?: boolean;
  attempt?: 'uncertain' | 'sdk-returned'; replay?: boolean; invoked?: boolean; errorObserved?: boolean;
  acceptance?: 'unknown' | 'server-ack'; delivery?: 'unknown' | 'delivered'; read?: 'unknown' | 'read';
  connection?: string; recovery?: string; build?: string | null; label?: string;
  issue?: string; operation?: 'enable' | 'disable' | 'status'; phase?: 'requested'; coverage?: 'partial'; appState?: 'unknown';
  cpuUserUs?: number; cpuSystemUs?: number; elapsedMs?: number; rssBytes?: number; heapBytes?: number; lagMs?: number;
};
export type ObsRecord = ObsFields & {
  schema: 1; timestamp: string; origin: ObsOrigin; category: ObsCategory; span: string; generation: string; session: string;
  dropped: number; evicted: number; expired: number;
};

export function obsAction(value: unknown): ObsAction { return actions.find(action => action === value) ?? 'unknown'; }
export function obsCode(value: unknown): string { return codes.find(code => code === value) ?? 'UNKNOWN'; }

function safeDirectory(directory: string): void { checkAncestors(directory); checkPrivatePath(directory, 'directory'); }
function readPrivate(path: string, max: number): string {
  checkPrivatePath(path, 'file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > max) throw new Error('Unsafe observability file');
    const bytes = Buffer.alloc(max + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > max) throw new Error('Oversized observability file');
    return bytes.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
export function readObservability(directory: string): Configuration {
  try {
    safeDirectory(directory);
    let text: string;
    try { text = readPrivate(join(directory, 'observability.json'), 512); }
    catch (error) { if (isMissing(error)) return { preference: null, configured: false, degraded: false }; throw error; }
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('enabled' in value) || typeof value.enabled !== 'boolean' || !('generation' in value) || typeof value.generation !== 'string' || !/^[a-f0-9]{32}$/.test(value.generation)
      || !('secret' in value) || typeof value.secret !== 'string' || !/^[a-f0-9]{64}$/.test(value.secret)
      || Object.keys(value).sort().join(',') !== 'enabled,generation,secret,version') throw new Error('Unsupported preference');
    return { preference: value as Preference, configured: value.enabled, degraded: false };
  } catch (error) {
    if (isMissing(error)) {
      try { checkAncestors(directory, undefined, true); return { preference: null, configured: false, degraded: false }; } catch { /* Unknown namespace is never admitted. */ }
    }
    return { preference: null, configured: null, degraded: true };
  }
}

/** One non-waiting filesystem critical section across processes. Never steal an existing lock.
 * A crash in this short section leaves a visible degradation, rather than unsafe lock recovery.
 */
function exclusive<T>(directory: string, work: () => T): T {
  safeDirectory(directory);
  const lock = join(directory, 'observability.lock');
  mkdirSync(lock, { mode: 0o700 });
  try { return work(); } finally { rmdirSync(lock); }
}

export function configureObservability(directory: string, enabled: boolean): void {
  try {
    ensurePrivateDirectory(directory);
    exclusive(directory, () => {
      const current = readObservability(directory);
      if (current.degraded) throw new Error('Unsupported preference');
      // Fixed pending name bounds crash remnants; an existing pending file is preserved.
      const pending = join(directory, 'observability.pending.json');
      const fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const preference: Preference = current.preference ? { ...current.preference, enabled }
        : { version: 1, enabled, generation: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex') };
      try { writeSync(fd, JSON.stringify(preference) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      // Validate again before replacing a known preference. No permissions are repaired.
      if (current.preference) readPrivate(join(directory, 'observability.json'), 512);
      renameSync(pending, join(directory, 'observability.json'));
    });
  } catch { throw new CommandError('LOCAL_STATE', 'Observability configuration could not be completed; the preference may have persisted. Inspect the private configuration/lock before retrying'); }
}

type Segment = { name: string; time: number; bytes: number; generation: string; partial: boolean };
function segments(directory: string, onMissing?: () => void): Segment[] {
  safeDirectory(directory);
  const entries: string[] = [];
  const dir = opendirSync(directory);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      entries.push(entry.name);
      if (entries.length > OBS_LIMITS.files) throw new Error('Observability file cap or unexpected entries');
    }
  } finally { dir.closeSync(); }
  return entries.flatMap(name => {
    try {
      const match = segmentName.exec(name);
      if (!match) throw new Error('Unrecognized observability entry');
      const stat = checkPrivatePath(join(directory, name), 'file');
      if (stat.nlink !== 1 || stat.size > OBS_LIMITS.segment) throw new Error('Unsafe segment');
      const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const head = Buffer.alloc(OBS_LIMITS.line);
        const count = readSync(fd, head, 0, head.length, 0);
        const end = head.subarray(0, count).indexOf(10);
        if (end < 0) throw new Error('Unrecognized segment header');
        const first: unknown = JSON.parse(head.subarray(0, end).toString('utf8'));
        if (!first || typeof first !== 'object' || !('schema' in first) || first.schema !== 1
          || !('generation' in first) || typeof first.generation !== 'string' || !/^[a-f0-9]{32}$/.test(first.generation)) throw new Error('Unrecognized segment header');
        const tail = Buffer.alloc(1);
        const partial = stat.size > 0 && (readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10);
        return [{ name, time: Number(match[1]), bytes: stat.size, generation: first.generation, partial }];
      } finally { closeSync(fd); }
    } catch (error) { if (isMissing(error)) { onMissing?.(); return []; } throw error; }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Allowlist projection also applies when reading logs: corrupted lines cannot become prompts. */
export function safeObsFields(input: ObsFields): ObsFields {
  const output: ObsFields = {};
  if (input.action !== undefined) output.action = obsAction(input.action);
  if (input.code !== undefined) output.code = obsCode(input.code);
  for (const name of ['correlation', 'parent', 'resource', 'query', 'key', 'message', 'destination', 'participant'] as const) {
    const value = input[name];
    if (typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)) output[name] = value;
  }
  for (const name of ['durationMs', 'requestBytes', 'responseBytes', 'stdoutBytes', 'count', 'limit', 'offset', 'after', 'cpuUserUs', 'cpuSystemUs', 'elapsedMs', 'rssBytes', 'heapBytes', 'lagMs'] as const) {
    const value = input[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) output[name] = value;
  }
  for (const name of ['ok', 'empty', 'quoted', 'value', 'replay', 'invoked', 'errorObserved', 'fromMe'] as const) if (typeof input[name] === 'boolean') output[name] = input[name];
  for (const name of ['unread', 'archived'] as const) if (typeof input[name] === 'boolean' || input[name] === 'unknown') output[name] = input[name];
  if (input.output === 'full' || input.output === 'compact') output.output = input.output;
  if (input.attempt === 'uncertain' || input.attempt === 'sdk-returned') output.attempt = input.attempt;
  if (input.acceptance === 'unknown' || input.acceptance === 'server-ack') output.acceptance = input.acceptance;
  if (input.delivery === 'unknown' || input.delivery === 'delivered') output.delivery = input.delivery;
  if (input.read === 'unknown' || input.read === 'read') output.read = input.read;
  if (input.build === null || (typeof input.build === 'string' && /^sha256:[a-f0-9]{64}$/.test(input.build))) output.build = input.build;
  if (typeof input.connection === 'string' && ['offline', 'connecting', 'open', 'close'].includes(input.connection)) output.connection = input.connection;
  if (typeof input.recovery === 'string' && ['offline', 'connecting', 'open', 'waiting-retry', 'intervention-required', 'stopping'].includes(input.recovery)) output.recovery = input.recovery;
  if (typeof input.label === 'string' && ['startup', 'shutdown', 'sdk', 'dependency', 'fatal', 'connection', 'receipt', 'observation'].includes(input.label)) output.label = input.label;
  if (typeof input.issue === 'string' && ['app-state-sync-incomplete', 'initial-sync-timed-out', 'decryption-or-integrity-failure'].includes(input.issue)) output.issue = input.issue;
  if (input.operation === 'enable' || input.operation === 'disable' || input.operation === 'status') output.operation = input.operation;
  if (input.phase === 'requested') output.phase = input.phase;
  if (input.coverage === 'partial') output.coverage = input.coverage;
  if (input.appState === 'unknown') output.appState = input.appState;
  return output;
}

export class Observability {
  private configuration: Configuration = { preference: null, configured: false, degraded: false };
  private dropped = 0;
  private totalDropped = 0;
  private failed = false;
  private evicted = 0;
  private expired = 0;
  private warned = false;
  readonly session = randomBytes(16).toString('hex');
  constructor(readonly directory: string, readonly origin: ObsOrigin, private readonly now = Date.now) { this.refresh(); }
  refresh(): void { this.configuration = readObservability(this.directory); }
  get enabled(): boolean { return this.configuration.configured === true && !this.configuration.degraded; }
  status() {
    this.refresh();
    let blocked = false;
    try { checkPrivatePath(join(this.directory, 'observability.lock'), 'directory'); blocked = true; } catch (error) { blocked = !isMissing(error); }
    return { configured: this.configuration.configured, enabled: this.enabled, effective: this.enabled && !this.failed && !blocked,
      degraded: this.configuration.degraded || this.failed || blocked, dropped: this.totalDropped, evicted: this.evicted, expired: this.expired,
      limits: OBS_LIMITS, directory: join(resolve(this.directory), 'observability'), scope: 'process-counters' };
  }
  opaque(domain: 'resource' | 'query' | 'key' | 'correlation' | 'message', value: string): string | undefined {
    const preference = this.configuration.preference;
    if (!this.enabled || !preference || Buffer.byteLength(value) > 4096) return undefined;
    try { return createHmac('sha256', Buffer.from(preference.secret, 'hex')).update(domain + '\0').update(value).digest('hex').slice(0, 32); }
    catch { this.failure(); return undefined; }
  }
  failure(): void {
    this.failed = true; this.dropped++; this.totalDropped++;
    if (!this.warned) {
      this.warned = true;
      try { process.stderr.write('{"level":"diagnostic","code":"OBSERVABILITY_DEGRADED","message":"Optional telemetry lost; inspect observability status"}\n'); } catch { /* No fallback. */ }
    }
  }
  /** Expiration also runs while disabled, without generating telemetry. No daemon means
   * physical deletion waits for the next tool invocation; queries always enforce the TTL.
   */
  maintain(): boolean {
    this.refresh();
    if (!this.configuration.preference) return false;
    try {
      const directory = join(this.directory, 'observability');
      safeDirectory(directory);
      return exclusive(this.directory, () => {
        const files = segments(directory);
        if (files.some(file => file.generation !== this.configuration.preference?.generation)) throw new Error('Unrecognized generation');
        let retained = 0;
        for (const file of files) {
          if (file.time <= this.now() - OBS_LIMITS.days * 86400000) { unlinkSync(join(directory, file.name)); this.expired++; }
          else retained++;
        }
        return retained > 0;
      });
    } catch (error) { if (isMissing(error)) return false; this.failed = true; return true; }
  }
  record(category: ObsCategory, fields: ObsFields = {}, origin: ObsOrigin = this.origin): void {
    this.refresh();
    if (!this.enabled) return;
    try {
      exclusive(this.directory, () => {
        this.refresh();
        if (!this.enabled || !this.configuration.preference) return;
        const directory = join(this.directory, 'observability');
        ensurePrivateDirectory(directory);
        let files = segments(directory);
        let expired = 0;
        let evicted = 0;
        const now = this.now();
        const remove = (file: Segment): void => {
          // Only generated recognized regular entries under this exclusive area are eligible.
          const path = join(directory, file.name);
          const stat = checkPrivatePath(path, 'file');
          if (stat.nlink !== 1) throw new Error('Unsafe segment');
          unlinkSync(path);
          files = files.filter(item => item !== file);
        };
        if (files.some(file => file.generation !== this.configuration.preference?.generation)) throw new Error('Unrecognized segment generation');
        for (const file of [...files]) if (file.time <= now - OBS_LIMITS.days * 86400000) { remove(file); expired++; }
        let last = files.at(-1);
        // Reserve a maximum line, so aggregate file/byte limits hold across short clients.
        if (last && (last.partial || last.bytes + OBS_LIMITS.line > OBS_LIMITS.segment || last.time < now - 1800000)) last = undefined;
        while (files.length && (files.reduce((sum, file) => sum + file.bytes, 0) + OBS_LIMITS.line > OBS_LIMITS.bytes || (!last && files.length >= OBS_LIMITS.files))) {
          const first = files[0]!; remove(first); evicted++; if (last === first) last = undefined;
        }
        const record: ObsRecord = { schema: 1, timestamp: new Date(now).toISOString(), origin, category,
          span: randomBytes(16).toString('hex'), generation: this.configuration.preference.generation, session: this.session,
          ...safeObsFields(fields), dropped: this.dropped, evicted, expired };
        const line = JSON.stringify(record) + '\n';
        if (Buffer.byteLength(line) > OBS_LIMITS.line) throw new Error('Oversized record');
        const path = join(directory, last?.name ?? `v1-${now}-${randomUUID()}.jsonl`);
        if (last) {
          // Never append after an interrupted/partial line.
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { const tail = Buffer.alloc(1); if (last.bytes && (readSync(fd, tail, 0, 1, last.bytes - 1) !== 1 || tail[0] !== 10)) throw new Error('Partial segment'); } finally { closeSync(fd); }
        }
        const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | (last ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
        try { if (writeSync(fd, line) !== Buffer.byteLength(line)) throw new Error('Partial write'); } finally { closeSync(fd); }
        this.dropped = 0; this.failed = false; this.evicted += evicted; this.expired += expired;
      });
    } catch { this.failure(); }
  }
}

export type ObsQuery = { from?: string; to?: string; action?: string; origin?: string; code?: string; correlation?: string; limit?: number; cursor?: string };
export function queryObservability(directory: string, query: ObsQuery) {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new CommandError('INVALID_ARGUMENT', 'Observability limit must be 1..500');
  for (const time of [query.from, query.to]) if (time !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)) throw new CommandError('INVALID_ARGUMENT', 'Use UTC ISO timestamps with milliseconds');
  if (query.from && query.to && query.from > query.to) throw new CommandError('INVALID_ARGUMENT', 'Observability from must precede to');
  if ((query.action && obsAction(query.action) !== query.action) || (query.code && obsCode(query.code) !== query.code)
    || (query.origin && !['cli', 'rpc', 'daemon', 'probe', 'runtime'].includes(query.origin))
    || (query.correlation && !/^[a-f0-9]{32}$/.test(query.correlation))) throw new CommandError('INVALID_ARGUMENT', 'Invalid observability filter');
  let cutoff = Date.now();
  let position = '';
  if (query.cursor) {
    if (!/^\d{13}:v1-\d{13}-[a-f0-9-]{36}\.jsonl:\d{1,7}$/.test(query.cursor)) throw new CommandError('INVALID_ARGUMENT', 'Invalid observability cursor');
    cutoff = Number(query.cursor.slice(0, 13)); position = query.cursor.slice(14);
  }
  safeDirectory(directory);
  const root = join(directory, 'observability');
  let files: Segment[];
  let missing = 0;
  try { files = segments(root, () => { missing++; }); } catch (error) { if (isMissing(error)) files = []; else throw new CommandError('LOCAL_STATE', 'Observability area cannot be safely read; entries preserved'); }
  const records: ObsRecord[] = [];
  let invalid = 0;
  let scanned = 0;
  let next: string | null = null;
  let lastPosition = position;
  const maximumScan = 2000;
  outer: for (const file of files) {
    if (file.time > cutoff || file.time <= Date.now() - OBS_LIMITS.days * 86400000 || (position && file.name < position.split(':')[0]!)) continue;
    let text: string;
    try { text = readPrivate(join(root, file.name), OBS_LIMITS.segment); } catch (error) { if (isMissing(error)) { missing++; continue; } invalid++; continue; }
    const lines = text.split('\n');
    if (lines.pop()) invalid++; // Only complete JSONL lines are evidence.
    for (let index = 0; index < lines.length; index++) {
      const at = `${file.name}:${String(index).padStart(7, '0')}`;
      if (at <= position) continue;
      if (scanned >= maximumScan || records.length >= limit) { next = `${cutoff}:${lastPosition}`; break outer; }
      lastPosition = at; scanned++;
      const line = lines[index]!;
      if (Buffer.byteLength(line) > OBS_LIMITS.line) { invalid++; continue; }
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object') throw new Error();
        const row = value as Partial<ObsRecord>;
        if (row.schema !== 1 || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp)) || !/^[a-f0-9]{32}$/.test(row.span ?? '') || !/^[a-f0-9]{32}$/.test(row.generation ?? '') || !/^[a-f0-9]{32}$/.test(row.session ?? '')
          || !['cli', 'rpc', 'daemon', 'probe', 'runtime'].includes(row.origin ?? '') || !['command', 'transport', 'execution', 'parser', 'lifecycle', 'diagnostic', 'sample'].includes(row.category ?? '')) throw new Error();
        if (Date.parse(row.timestamp) > cutoff || (query.from && row.timestamp < query.from) || (query.to && row.timestamp > query.to)) continue;
        const record: ObsRecord = { schema: 1, timestamp: new Date(Date.parse(row.timestamp)).toISOString(), origin: row.origin!, category: row.category!, span: row.span!, generation: row.generation!, session: row.session!,
          ...safeObsFields(row), dropped: safeCounter(row.dropped), evicted: safeCounter(row.evicted), expired: safeCounter(row.expired) };
        if ((query.action && record.action !== query.action) || (query.origin && record.origin !== query.origin) || (query.code && record.code !== query.code) || (query.correlation && record.correlation !== query.correlation)) continue;
        records.push(record);
      } catch { invalid++; }
    }
  }
  const groups = new Map<string, { origin: ObsOrigin; category: ObsCategory; action: ObsAction; count: number; errors: number; empty: number; durations: number[] }>();
  for (const row of records) {
    const key = `${row.origin}:${row.category}:${row.action ?? 'unknown'}`;
    const group = groups.get(key) ?? { origin: row.origin, category: row.category, action: row.action ?? 'unknown', count: 0, errors: 0, empty: 0, durations: [] };
    group.count++; if (row.ok === false) group.errors++; if (row.empty) group.empty++;
    if (row.durationMs !== undefined) group.durations.push(row.durationMs);
    groups.set(key, group);
  }
  const summary = [...groups.values()].map(({ durations, ...group }) => {
    durations.sort((a, b) => a - b);
    return { ...group, latencyMs: durations.length ? { n: durations.length, min: durations[0], p50: durations[Math.ceil(durations.length * 0.5) - 1], p95: durations[Math.ceil(durations.length * 0.95) - 1], max: durations.at(-1) } : null };
  });
  return { records, next, cutoff: new Date(cutoff).toISOString(), scanned, invalid, missing, summary, summaryScope: 'returned-page-only',
    gaps: { retentionOrCapPossible: true, cursorSegmentMissing: !!position && !files.some(file => position.startsWith(file.name + ':') && file.time > Date.now() - OBS_LIMITS.days * 86400000) },
    coverage: 'best-effort-local', untrustedData: true };
}
function safeCounter(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
