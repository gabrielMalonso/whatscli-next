import { generateMessageIDV2 } from 'baileys';
import type { WAMessage } from 'baileys';
import { recipientJid } from './identity.js';
import type { Operation, RequestRecord, Store } from './store.js';

/** A return from the SDK is not a server acknowledgment or a phone-side verification. */
export async function perform(
  store: Store,
  key: string,
  operation: Operation,
  validate: () => void,
  invoke: (messageId: string | null) => Promise<WAMessage | undefined | void>,
): Promise<RequestRecord> {
  recipientJid(operation.jid);
  if (!key || key.length > 200) throw new Error('A nonempty idempotency key (up to 200 characters) is required');
  const previous = store.request(key);
  if (previous) {
    const prior = previous.operation;
    const same = prior.jid === operation.jid && (prior.kind === 'send'
      ? operation.kind === 'send' && prior.text === operation.text
      : prior.kind === 'send-file'
        ? operation.kind === 'send-file' && prior.path === operation.path && prior.mime === operation.mime && prior.caption === operation.caption && prior.sha256 === operation.sha256 && prior.bytes === operation.bytes
        : operation.kind === prior.kind && prior.value === operation.value);
    if (!same) throw new Error('Idempotency key already used with different arguments');
    return previous;
  }
  validate();
  // Commit before calling the network. A crash at any later point stays uncertain and is never retried.
  const record: RequestRecord = {
    key, operation, messageId: ['send', 'send-file'].includes(operation.kind) ? generateMessageIDV2() : null,
    attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: false,
  };
  store.transaction(() => {
    store.saveRequest(record);
    store.invalidateChatState(key, operation);
    store.event('operation-attempt', { key, kind: operation.kind, jid: operation.jid, messageId: record.messageId });
  });
  try {
    const message = await invoke(record.messageId);
    if (['send', 'send-file'].includes(operation.kind) && (!message || message.key.id !== record.messageId || message.key.remoteJid !== operation.jid || message.key.fromMe !== true)) {
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
