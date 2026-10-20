import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Observability } from '../../src/observability.js';

const mode = new URL(import.meta.url).searchParams.get('mode');

function notify(stage: string): void {
  fs.writeSync(3, stage + '\n');
}

// Dedicated child pipes control scheduling, never a telemetry retry or elapsed-time delay.
function gate(stage: string): void {
  notify(stage);
  if (fs.readSync(4, Buffer.alloc(1), 0, 1, null) !== 1)
    throw new Error('Observability fixture gate closed');
}

const write = fs.writeSync;
fs.writeSync = ((
  fd: number,
  data: string | NodeJS.ArrayBufferView,
  ...args: unknown[]
) => {
  const result = Reflect.apply(write, fs, [fd, data, ...args]);
  if (typeof data === 'string' && data.startsWith('{"schema":1,')) {
    if (
      mode === 'daemon-lock' &&
      data.includes('"origin":"daemon"') &&
      data.includes('"action":"send-contact"')
    )
      gate('daemon-locked');
    if (
      mode === 'cli-lock' &&
      data.includes('"origin":"cli"') &&
      data.includes('"action":"help"')
    )
      gate('cli-locked');
  }
  return result;
}) as typeof fs.writeSync;
syncBuiltinESMExports();

const record = Observability.prototype.record;
Observability.prototype.record = function (
  this: Observability,
  category,
  fields = {},
  origin = this.origin,
) {
  if (
    mode === 'rpc-waits' &&
    origin === 'rpc' &&
    fields.action === 'send-contact'
  )
    gate('rpc-before-lock');
  const controlled =
    origin === 'daemon' &&
    ((['daemon-waits', 'daemon-waits-drain', 'daemon-recovery'].includes(mode ?? '') && fields.action === 'send-contact') ||
      (mode === 'daemon-lock' && fields.action === 'send-contact'));
  if (controlled) gate('daemon-before-lock');
  // Only the positive recovery schedule virtualizes the recorder's retry age;
  // business clocks and pipe ordering stay real. The negative keeps real time.
  if (controlled && mode === 'daemon-recovery') Reflect.set(this, 'elapsed', () => 0);
  record.call(this, category, fields, origin);
  if (category === 'lifecycle' && fields.label === 'startup') notify('ready');
  if (controlled) notify('daemon-recorded');
  if (controlled && ['daemon-waits-drain', 'daemon-recovery'].includes(mode ?? ''))
    void this.drain().then(() => notify('daemon-drained'));
};
