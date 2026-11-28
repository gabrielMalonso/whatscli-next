import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.js';

/**
 * Contact lookup and chats enrichment latency on a large fictional store.
 * Store calls are synchronous in the runtime, so this is time the daemon's
 * event loop is blocked. No account data, network or wall-clock inputs.
 */
process.umask(0o077);
const chats = 2000;
const first = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabi'];
const last = ['Example', 'Fictional', 'Sample', 'Placeholder', 'Testing'];
function run(pairs: number) {
  const directory = mkdtempSync(join(tmpdir(), 'benchmark-contacts-'));
  const store = new Store(directory);
  try {
    const seeded = performance.now();
    store.transaction(() => {
      for (let i = 0; i < pairs; i++) {
        const pn = `1202${String(5000000 + i).padStart(7, '0')}@s.whatsapp.net`;
        const lid = `${900000000 + i}@lid`;
        store.observeMapping(pn, lid, 'lid-mapping.update', 1700000000000);
        const name = `${first[i % first.length]} ${last[(i * 3) % last.length]} ${i}`;
        if (i % 2 === 0)
          store.observeContact({ id: pn, name }, 'contacts.upsert');
        if (i % 3 === 0)
          store.observeContact({ id: lid, notify: name }, 'contacts.update');
        if (i < chats)
          store.observeChat({
            id: i % 2 ? lid : pn,
            unreadCount: 1,
            conversationTimestamp: 1700000000 + i,
          });
      }
    });
    const seedMs = performance.now() - seeded;
    const time = (run: () => unknown[]) => {
      run(); // warm statement caches
      const samples: number[] = [];
      let count = 0;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        count = run().length;
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return {
        results: count,
        medianMs: Number(samples[2]!.toFixed(1)),
        maxMs: Number(samples[4]!.toFixed(1)),
      };
    };
    const result = {
      store: {
        pnLidPairs: pairs,
        contactRecords: Math.ceil(pairs / 2) + Math.ceil(pairs / 3),
        chats,
        seedMs: Math.round(seedMs),
      },
      contacts: {
        'name, broad (an), limit 20': time(() => store.contactSearch('an')),
        'name, broad (an), offset 5000': time(() =>
          store.contactSearch('an', 20, 5000),
        ),
        'name, narrow (fabio sample 12)': time(() =>
          store.contactSearch('fabio sample 12'),
        ),
        'phone digits (1202500), limit 100': time(() =>
          store.contactSearch('1202500', 100),
        ),
        'no match': time(() => store.contactSearch('zzzz-no-match')),
      },
      chats: {
        'limit 100, --include contact,last-message': time(() =>
          store.chats(100, 0, {}, ['contact', 'last-message']),
        ),
        'limit 100, no include': time(() => store.chats(100, 0)),
      },
    };
    return result;
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const sizes = process.argv[2] ? [Number(process.argv[2])] : [20000, 100000];
process.stdout.write(
  JSON.stringify(
    {
      runs: sizes.map(run),
      limits:
        'Fictional data on this machine; median and max of 5 runs after one warm-up. Not a guarantee for other hardware.',
    },
    null,
    2,
  ) + '\n',
);
