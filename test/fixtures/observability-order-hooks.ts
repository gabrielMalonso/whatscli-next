import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
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

if (mode === 'ordered') {
  const end = Socket.prototype.end;
  Socket.prototype.end = function (this: Socket, ...args: unknown[]) {
    if (typeof args[0] === 'string' && args[0].startsWith('{"id":')) {
      // Let the daemon finish its synchronous observation and release its lock
      // before making the response available to this coverage fixture's client.
      queueMicrotask(() => Reflect.apply(end, this, args));
      return this;
    }
    return Reflect.apply(end, this, args);
  };
} else {
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
        mode === 'rpc-lock' &&
        data.includes('"origin":"rpc"') &&
        data.includes('"action":"search"')
      )
        gate('rpc-locked');
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
      ((mode === 'daemon-waits' && fields.action === 'search') ||
        (mode === 'daemon-lock' && fields.action === 'send-contact'));
    if (controlled) gate('daemon-before-lock');
    record.call(this, category, fields, origin);
    if (category === 'lifecycle' && fields.label === 'startup') notify('ready');
    if (controlled) notify('daemon-recorded');
  };
}
