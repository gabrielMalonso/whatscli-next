import type { Command } from './protocol.js';
import { Observability, obsAction } from './observability.js';
import type { ObsFields } from './observability.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Hash only selected small selectors, never bodies, file bytes, quotes or entire responses. */
export function commandFields(observer: Observability, command: Command): ObsFields {
  const fields: ObsFields = { action: obsAction(command.command) };
  if (!observer.enabled) return fields;
  if ('jid' in command) { const id = observer.opaque('resource', command.jid); if (id) fields.resource = id; }
  if ('key' in command) { const id = observer.opaque('key', command.key); if (id) fields.key = id; }
  if ('query' in command) { const id = observer.opaque('query', command.query); if (id) fields.query = id; }
  if ('limit' in command) fields.limit = command.limit;
  if ('offset' in command) fields.offset = command.offset;
  if ('after' in command) fields.after = command.after;
  if ('value' in command) fields.value = command.value;
  if (command.command === 'chats') {
    if (command.unread !== undefined) fields.unread = command.unread;
    if (command.archived !== undefined) fields.archived = command.archived;
  }
  if (command.command === 'send') fields.quoted = command.quote !== undefined;
  return fields;
}

export function resultFields(data: unknown, observer?: Observability): ObsFields {
  const fields: ObsFields = {};
  if (Array.isArray(data)) { fields.count = data.length; fields.empty = data.length === 0; }
  else if (data === null) fields.empty = true;
  const value = record(data);
  const intent = record(value?.request) ?? value;
  if (intent?.attempt === 'uncertain' || intent?.attempt === 'sdk-returned') {
    fields.attempt = intent.attempt;
    if (observer && typeof intent.messageId === 'string') {
      const message = observer.opaque('message', intent.messageId); if (message) fields.message = message;
      const operation = record(intent.operation);
      const route = record(intent.route);
      const jid = typeof route?.jid === 'string' ? route.jid : operation?.jid;
      if (typeof jid === 'string') { const destination = observer.opaque('resource', jid); if (destination) fields.destination = destination; }
    }
    if (typeof intent.errorObserved === 'boolean') fields.errorObserved = intent.errorObserved;
    if (intent.acceptance === 'unknown' || intent.acceptance === 'server-ack') fields.acceptance = intent.acceptance;
    if (intent.delivery === 'unknown' || intent.delivery === 'delivered') fields.delivery = intent.delivery;
    if (intent.read === 'unknown' || intent.read === 'read') fields.read = intent.read;
  }
  return fields;
}

/** The existing opaque wire id carries a command root and a distinct physical attempt.
 * Arbitrary external ids are HMACed, never copied, and have no claimed CLI parent.
 */
export function wireFields(observer: Observability, id: string | null): ObsFields {
  if (!id) return {};
  const root = /^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(id) ? id.slice(0, 32) : id;
  const correlation = observer.opaque('correlation', root);
  const parent = observer.opaque('correlation', id);
  return { ...(correlation ? { correlation } : {}), ...(parent ? { parent } : {}) };
}
