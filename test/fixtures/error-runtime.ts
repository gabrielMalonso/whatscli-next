import { EventEmitter } from 'node:events';
import { proto } from 'baileys';
import type { WASocket } from 'baileys';
import { createRuntime as actualRuntime } from '../../src/runtime.js';
import type { RuntimeOptions } from '../../src/runtime.js';

export function createRuntime(options: RuntimeOptions) {
  const events = new EventEmitter();
  // CLI/daemon start remains --offline; this injected socket has no physical transport.
  const runtime = actualRuntime(
    { ...options, connect: true },
    () =>
      ({
        ev: events,
        ws: { isClosed: true },
        end: async () => {
          events.emit('connection.update', { connection: 'close' });
        },
        groupMetadata: async () => {
          throw new Error('FICTIONAL_PRIVATE_SDK_BODY /private/example');
        },
        sendMessage: async (
          jid: string,
          content: Parameters<WASocket['sendMessage']>[1],
          options: Parameters<WASocket['sendMessage']>[2],
        ) => {
          const key = { remoteJid: jid, id: options?.messageId, fromMe: true };
          events.emit('messages.update', [
            {
              key,
              update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK },
            },
          ]);
          if ('text' in content && content.text === 'uncertain')
            throw new Error('FICTIONAL_PRIVATE_SDK_BODY');
          return { key, message: { conversation: 'Fictional return' } };
        },
      }) as unknown as WASocket,
  ); // Deliberately partial SDK boundary, never a real socket factory.
  return {
    ...runtime,
    start() {
      runtime.start();
      events.emit('connection.update', { connection: 'open' });
      process.send?.('ready');
    },
  };
}
