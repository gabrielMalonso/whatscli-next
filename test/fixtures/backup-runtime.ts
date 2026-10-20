import { backup } from 'node:sqlite';
import { createBackup } from '../../src/backup.js';
import { createRuntime as actualRuntime } from '../../src/runtime.js';
import type { RuntimeOptions } from '../../src/runtime.js';

export function createRuntime(options: RuntimeOptions) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  process.on('message', (message) => {
    if (message === 'release-backup') release();
  });
  // Started --offline, with the real runtime/SQLite path and only copy timing gated.
  const runtime = actualRuntime(
    options,
    undefined,
    undefined,
    (source, directory) =>
      createBackup(source, directory, async (db, path) => {
        process.send?.('backup-started');
        await gate;
        return backup(db, path);
      }),
  );
  return {
    ...runtime,
    start() {
      runtime.start();
      process.send?.('ready');
    },
    async close() {
      await runtime.close();
      process.disconnect?.();
    },
  };
}
