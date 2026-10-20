import { generateMessageIDV2 } from 'baileys';
import type { WAMessage } from 'baileys';
import { isPn, recipientJid } from './identity.js';
import type { Operation, RequestRecord, Store } from './store.js';
import { isSendOperation } from './store.js';
import { unprovenRoute } from './send-route.js';
import type { SendRoute } from './send-route.js';
import { CommandError } from './errors.js';
import { sameQuote } from './quoted-text.js';
import type { QuoteSnapshot } from './quoted-text.js';

function sameOperation(prior: Operation, operation: Operation): boolean {
  if (prior.jid !== operation.jid) return false;
  switch (prior.kind) {
    case 'send': return operation.kind === 'send' && prior.text === operation.text && sameQuote(prior.quote, operation.quote);
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
  invoke: (messageId: string | null, destination: string, record: RequestRecord) => Promise<WAMessage | undefined | void>,
  preparation?: { pending: Map<string, Promise<void>>; route: (jid: string) => Promise<SendRoute>; quote?: () => QuoteSnapshot },
): Promise<RequestRecord> {
  recipientJid(operation.jid);
  if (!key || key.length > 200) throw new CommandError('INVALID_ARGUMENT', 'A nonempty idempotency key (up to 200 characters) is required');
  const previous = store.request(key);
  if (previous) {
    if (!sameOperation(previous.operation, operation)) throw new CommandError('KEY_CONFLICT', 'Idempotency key already used with different arguments');
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
    const quote = preparation?.quote?.();
    if (preparation && isSendOperation(operation) && isPn(operation.jid)) {
      route = await preparation.route(operation.jid);
      validate();
      if (quote && JSON.stringify(preparation.quote?.()) !== JSON.stringify(quote)) {
        throw new CommandError('PRECONDITION_FAILED', 'Quote changed during route preparation; no send was attempted');
      }
      if (route.status === 'proven' && store.hasMappingConflict(operation.jid, route.jid)) {
        route = unprovenRoute(operation.jid, route.observedAt, 'conflicting-identities');
      }
    }
    if (quote && route && route.jid !== operation.jid) {
      // rc14 would emit the original peer JID as a cross-chat context.remoteJid.
      throw new CommandError('PRECONDITION_FAILED', 'Quote transport route differs from the exact stored conversation; cross-domain quotes are unsupported');
    }
    // Commit before invoking the send. A crash afterward stays uncertain and is never retried.
    record = {
      key, operation, messageId: isSendOperation(operation) ? generateMessageIDV2() : null,
      ...(route ? { route } : {}),
      ...(quote ? { quote } : {}),
      attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false,
    };
    try { store.transaction(() => {
      store.saveRequest(record);
      store.invalidateChatState(key, operation);
      store.event('operation-attempt', { key, kind: operation.kind, jid: operation.jid, messageId: record.messageId });
    }); } catch (cause) {
      throw new CommandError('LOCAL_STATE', 'Local operation intent could not be persisted; inspect the original idempotency key', { cause });
    }
  } finally {
    preparation?.pending.delete(key);
    release();
  }
  let outcome: { returned: true; message: WAMessage | undefined | void } | { returned: false };
  try {
    const destination = record.route?.jid ?? operation.jid;
    const message = await invoke(record.messageId, destination, record);
    if (isSendOperation(operation) && (!message || message.key.id !== record.messageId || message.key.remoteJid !== destination || message.key.fromMe !== true)) {
      throw new Error('SDK did not return the expected message');
    }
    outcome = { returned: true, message };
  } catch { outcome = { returned: false }; }
  // Local persistence errors must escape, not become SDK uncertainty. Commit the
  // body, request outcome and journal together, preserving earlier independent receipts.
  try { return store.transaction(() => {
    // An SDK return is local outgoing evidence, not an independently observed conversation.
    if (outcome.returned && outcome.message) store.observeMessage(outcome.message, false);
    const latest = store.request(key) ?? record;
    if (outcome.returned) latest.attempt = 'sdk-returned';
    else latest.errorObserved = true;
    store.saveRequest(latest);
    store.event(outcome.returned ? 'operation-sdk-returned' : 'operation-uncertain', { key });
    return latest;
  }); } catch (cause) {
    throw new CommandError('LOCAL_STATE', 'Local operation completion could not be persisted; inspect the original idempotency key', { cause });
  }
}
