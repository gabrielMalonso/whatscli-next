import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { Store as StoreType } from '../src/store.js';
import { busyJid, chatCount, chatJid, fixtureMessage, fixtureRequest, fixtureVersion } from './store-fixtures.js';

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { n: sorted.length, min: sorted[0]!, median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2, max: sorted.at(-1)! };
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const memory = () => ({ rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, processPeakRss: process.resourceUsage().maxRSS * 1024 });
const elapsed = <T>(action: () => T) => { const start = performance.now(); const result = action(); return { ms: performance.now() - start, result }; };

export async function runWorker(source: string, directory: string, phase: string, count: number, requests: number) {
  process.umask(0o077);
  const loading = performance.now();
  // Versioned baseline/candidate modules share the same installed, pinned dependency graph.
  const { Store } = await import(pathToFileURL(join(source, 'store.js')).href) as { Store: typeof StoreType };
  const importMs = performance.now() - loading;
  const opening = performance.now();
  const store = new Store(directory);
  const openMs = performance.now() - opening;
  const before = memory();
  const snapshots = [before];
  const sample = () => { snapshots.push(memory()); };
  try {
    if (phase === 'seed') {
      const fixtureHash = createHash('sha256');
      let jsonBytes = 0; let maxJsonBytes = 0;
      const ingest = elapsed(() => store.transaction(() => {
        for (let i = 0; i < chatCount; i++) {
          store.observeChat({ id: chatJid(i), name: `Fictional chat ${i}`,
            ...(i % 4 ? { archived: i % 2 === 0 } : {}), ...(i % 5 ? { unreadCount: i % 3 === 0 ? -1 : i % 3 } : {}) });
        }
        for (let i = 0; i < count; i++) {
          const value = fixtureMessage(i);
          const json = JSON.stringify(value);
          const bytes = Buffer.byteLength(json); jsonBytes += bytes; maxJsonBytes = Math.max(maxJsonBytes, bytes);
          fixtureHash.update(json);
          store.observeMessage(value);
        }
        for (let i = 0; i < requests; i++) { const value = fixtureRequest(i); fixtureHash.update(JSON.stringify(value)); store.saveRequest(value); }
        for (let i = 0; i < chatCount; i += 13) store.invalidateChatState(`PENDING-${i}`, { kind: 'mark-read', jid: chatJid(i), value: true });
      }));
      sample();
      return { fixtureVersion, count, chats: chatCount, requests, fixtureHash: fixtureHash.digest('hex'),
        meanMessageJsonBytes: jsonBytes / count, maxMessageJsonBytes: maxJsonBytes, importMs, openMs, ingestMs: ingest.ms, before, after: memory() };
    }
    if (phase === 'upgrade') {
      // Only the candidate's additive backfill is timed by openMs. Input is the seeded baseline DB.
      assert.equal(store.search('100%_literal', 20, 0).length, 20);
      return { importMs, openMs, before, after: memory() };
    }
    if (phase === 'mutate') {
      const updates: number[] = []; const deletions: number[] = []; const singleWrites: number[] = [];
      for (let round = 0; round < 5; round++) {
        const start = round * 50;
        updates.push(elapsed(() => store.transaction(() => {
          for (let i = start; i < start + 50; i++) store.updateMessage({ key: fixtureMessage(i).key, update: { message: { conversation: `Edited fictional text ${i}` } } });
        })).ms);
        deletions.push(elapsed(() => store.deleteMessages({ keys: Array.from({ length: 50 }, (_, i) => fixtureMessage(start + i).key) })).ms);
        singleWrites.push(elapsed(() => store.observeMessage(fixtureMessage(count + round))).ms);
        sample();
      }
      assert.deepEqual(store.search('Edited fictional text', 100, 0), []);
      return { importMs, openMs, updateBatch50Ms: distribution(updates), deleteBatch50Ms: distribution(deletions),
        singleIngestMs: distribution(singleWrites), before, after: memory() };
    }
    if (phase === 'query' || phase === 'restart') {
      const scenarios: [string, () => unknown][] = [
        ['global-miss', () => store.search('never-present-fictional-needle', 20, 0).map(m => store.messageView(m))],
        ['global-result', () => store.search('Fictional', 20, 20).map(m => store.messageView(m))],
        ['unicode', () => store.search('ＣＡＦÉ são', 20, 0).map(m => store.messageView(m))],
        ['short-1', () => store.search('🐈', 20, 0).map(m => store.messageView(m))],
        ['short-2', () => store.search('%_', 20, 0).map(m => store.messageView(m))],
        ['excluded-context', () => store.search('excluded-context-', 20, 0).map(m => store.messageView(m))],
        ['jid-miss', () => store.search('never-present-fictional-needle', 20, 0, busyJid).map(m => store.messageView(m))],
        ['jid-result', () => store.search('Fictional', 20, 5, busyJid).map(m => store.messageView(m))],
        ['history', () => store.messages(busyJid, 20, 100).map(m => store.messageView(m))],
        ['chats-filtered', () => store.chats(50, 20, { unread: true, archived: false }).map(({ observedAt: _at, ...chat }) => chat)],
        ['chats-unknown', () => store.chats(50, 0, { unread: 'unknown', archived: 'unknown' }).map(({ observedAt: _at, ...chat }) => chat)],
        ['receipt', () => {
          const request = fixtureRequest(requests - 1);
          store.receipt({ remoteJid: request.route?.jid ?? request.operation.jid, id: request.messageId, fromMe: true }, 4);
          return store.request(request.key);
        }],
      ];
      const measurements = scenarios.map(([name, action]) => {
        const cold = elapsed(action); sample();
        const warm: number[] = [];
        for (let i = 0; i < 6; i++) {
          const run = elapsed(action); warm.push(run.ms); sample();
          assert.equal(hash(run.result), hash(cold.result), `${name}: changed result`);
        }
        const resultCount = Array.isArray(cold.result) ? cold.result.length : 1;
        return { name, coldFirstMs: cold.ms, warmMs: distribution(warm), resultCount, resultHash: hash(cold.result) };
      });
      const projected = store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='message_text'").get() !== undefined;
      const searchPlan = projected
        ? 'SELECT message_rowid FROM message_text WHERE instr(text,?)>0 ORDER BY timestamp DESC,message_rowid DESC LIMIT 20'
        : "SELECT json FROM messages WHERE json_extract(json,'$.message') IS NOT NULL AND instr(search_text(json),?)>0 ORDER BY timestamp DESC,rowid DESC LIMIT 20";
      const plans = {
        globalSearch: store.db.prepare(`EXPLAIN QUERY PLAN ${searchPlan}`).all('fictional'),
        history: store.db.prepare('EXPLAIN QUERY PLAN SELECT json FROM messages WHERE jid=? ORDER BY timestamp DESC,rowid DESC LIMIT 20 OFFSET 100').all(busyJid),
        receipt: store.db.prepare("EXPLAIN QUERY PLAN SELECT json FROM requests WHERE json_extract(json,'$.messageId')=?").all('OUTBOUND-1'),
      };
      return { importMs, openMs, measurements, plans, before, after: memory(),
        maxSampledHeapUsed: Math.max(...snapshots.map(m => m.heapUsed)), maxSampledRss: Math.max(...snapshots.map(m => m.rss)) };
    }
    if (phase === 'disk') {
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const allocation = store.db.prepare('SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name').all();
      const files = readdirSync(directory).filter(name => name.endsWith('.sqlite') || name.endsWith('-wal') || name.endsWith('-shm'))
        .map(name => ({ name, bytes: statSync(join(directory, name)).size }));
      return { files, totalFileBytes: files.reduce((sum, file) => sum + file.bytes, 0), allocation,
        sqlite: store.db.prepare('SELECT sqlite_version() AS version').get() };
    }
    throw new Error('Unknown benchmark phase');
  } finally { store.close(); }
}
