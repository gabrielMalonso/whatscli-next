import { readSync, writeSync } from 'node:fs';
import { Observability, queryObservability } from '../../src/observability.js';
import type { ObsFields } from '../../src/observability.js';

process.umask(0o077);
const [directory, mode] = process.argv.slice(2);
if (!directory) throw new Error('Missing fictional fixture directory');
let now = Date.now();
let elapsed = 0;
const observer = new Observability(
  directory,
  'runtime',
  () => now,
  mode === 'real-expired' ? undefined : () => elapsed,
);
const timestamp = new Date(now).toISOString();
const started = performance.now();
const identities: string[] = [];
for (let index = 0; index < (mode === 'overflow' ? 17 : 2); index++) {
  const query = (index + 1).toString(16).padStart(32, '0');
  identities.push(query);
  const fields: ObsFields & { text: string } = {
    action: 'chats',
    query,
    text: 'FICTIONAL_BUFFER_PRIVATE_CANARY',
  };
  observer.record('execution', fields);
  fields.action = 'search';
  fields.query = 'f'.repeat(32);
}
writeSync(3, 'admitted\n');
// A pipe gate prevents retries until the parent has released the independent
// holder and optionally committed an opt-out. No elapsed-time scheduling trick.
if (readSync(4, Buffer.alloc(1), 0, 1, null) !== 1)
  throw new Error('Closed fictional fixture gate');
now = mode === 'real-expired' ? Date.now() : now + 1000;
if (mode === 'expired') elapsed = 25;
await observer.close();
const page = queryObservability(directory, { limit: 500 });
process.stdout.write(
  JSON.stringify({
    timestamp,
    identities,
    elapsedMs: performance.now() - started,
    status: observer.status(),
    records: page.records.filter((row) => identities.includes(row.query ?? '')),
    gaps: page.gaps,
  }) + '\n',
);
