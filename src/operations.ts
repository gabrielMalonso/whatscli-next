import { generateMessageIDV2 } from 'baileys';
import type { WAMessage } from 'baileys';
import { isPn, recipientJid } from './identity.js';
import type { Operation, RequestRecord, Store } from './store.js';
import { isSendOperation } from './store.js';
import { unprovenRoute } from './send-route.js';
import type { SendRoute } from './send-route.js';

function sameOperation(prior: Operation, operation: Operation): boolean {
  if (prior.jid !== operation.jid) return false;
  switch (prior.kind) {
    case 'send': return operation.kind === 'send' && prior.text === operation.text;
    // The original byte snapshot remains authoritative even if the path changes later.
    case 'send-file': return operation.kind === 'send-file' && prior.path === operation.path && prior.mime === operation.mime && prior.caption === operation.caption;
    case 'send-contact': return operation.kind === 'send-contact' && prior.name === operation.name && prior.phone === operation.phone && prior.vcard === operation.vcard;
    case 'archive': case 'mark-read': return operation.kind === prior.kind && prior.value === operation.value;
  }
}

/** A return from the SDK is not a server acknowledgment or a phone-side verification. */
export async function perform(
  store: Store,
  key: string,
  operation: Operation,
  validate: () => void,
  invoke: (messageId: string | null, destination: string) => Promise<WAMessage | undefined | void>,
  preparation?: { pending: Map<string, Promise<void>>; route: (jid: string) => Promise<SendRoute> },
): Promise<RequestRecord> {
  recipientJid(operation.jid);
  if (!key || key.length > 200) throw new Error('A nonempty idempotency key (up to 200 characters) is required');
  const previous = store.request(key);
  if (previous) {
    if (!sameOperation(previous.operation, operation)) throw new Error('Idempotency key already used with different arguments');
    return previous;
  }
  const pending = preparation?.pending.get(key);
  if (pending) {
    await pending;
    return perform(store, key, operation, validate, invoke, preparation);
  }
  let release = () => {};
  if (preparation) preparation.pending.set(key, new Promise<void>(resolve => { release = resolve; }));
  let route: SendRoute | undefined;
  let record: RequestRecord;
  try {
    validate();
    if (preparation && isSendOperation(operation) && isPn(operation.jid)) {
      route = await preparation.route(operation.jid);
      validate();
      if (route.status === 'proven' && store.hasMappingConflict(operation.jid, route.jid)) {
        route = unprovenRoute(operation.jid, route.observedAt, 'conflicting-identities');
      }
    }
    // Commit before invoking the send. A crash afterward stays uncertain and is never retried.
    record = {
      key, operation, messageId: isSendOperation(operation) ? generateMessageIDV2() : null,
      ...(route ? { route } : {}),
      attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false,
    };
    store.transaction(() => {
      store.saveRequest(record);
      store.invalidateChatState(key, operation);
      store.event('operation-attempt', { key, kind: operation.kind, jid: operation.jid, messageId: record.messageId });
    });
  } finally {
    preparation?.pending.delete(key);
    release();
  }
  try {
    const destination = record.route?.jid ?? operation.jid;
    const message = await invoke(record.messageId, destination);
    if (isSendOperation(operation) && (!message || message.key.id !== record.messageId || message.key.remoteJid !== destination || message.key.fromMe !== true)) {
      throw new Error('SDK did not return the expected message');
    }
    // An SDK return is local outgoing evidence, not an independently observed conversation.
    if (message) store.observeMessage(message, false);
    const latest = store.request(key) ?? record;
    latest.attempt = 'sdk-returned';
    store.saveRequest(latest);
    store.event('operation-sdk-returned', { key });
    return latest;
  } catch {
    const latest = store.request(key) ?? record;
    latest.errorObserved = true;
    store.saveRequest(latest);
    store.event('operation-uncertain', { key });
    return latest;
  }
}
