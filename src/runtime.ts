import { Writable } from 'node:stream';
import makeWASocket, { ALL_WA_PATCH_NAMES, areJidsSameUser, assertMediaContent, downloadMediaMessage, normalizeMessageContent, toNumber } from 'baileys';
import { basename } from 'node:path';
import type { AuthenticationCreds, WASocket } from 'baileys';
import { pino } from 'pino';
import { hasLinkedCredentials, sqliteAuth } from './auth.js';
import { diagnosticIssue, disconnectReason, reconnectDelay } from './health.js';
import type { ReceiveInterruption, Recovery, RecoveryClock } from './health.js';
import { internationalPhone, recipientJid } from './identity.js';
import type { RecipientCheck } from './identity.js';
import { perform } from './operations.js';
import { contactCard } from './contact-card.js';
import { MAX_FILE_BYTES, prepareFile, saveMedia } from './media.js';
import { savePairingQr } from './pairing.js';
import { decode, encode, Store } from './store.js';

import { object } from './protocol.js';
import type { Command } from './protocol.js';

export type RuntimeOptions = {
  dataDir: string;
  connect: boolean;
  allowedJid?: string;
  requireAllowedJid?: boolean;
};

/** The one Baileys connection and the one database writer shared by both transports. */
export function createRuntime(options: RuntimeOptions, socketFactory = makeWASocket, clock: RecoveryClock = {
  now: Date.now,
  schedule(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
}) {
  const allowedJid = options.allowedJid === undefined ? undefined : recipientJid(options.allowedJid);
  const store = new Store(options.dataDir);
  const auth = sqliteAuth(store);
  let socket: WASocket | undefined;
  let socketClosed: Promise<void> | undefined;
  let connection = 'offline';
  let receivedPendingNotifications = false;
  let attempts = 0;
  let stopped = false;
  let started = false;
  let owner: object | undefined;
  let cancelTimer: (() => void) | undefined;
  let retryToken: object | undefined;
  let replacing: Promise<void> | undefined;
  let ending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let recovery: Recovery = { state: 'offline', reason: null, code: null, attempt: 0, nextRetryAt: null };
  let lastInterruption = store.get<ReceiveInterruption>('runtime', 'receive-interruption') ?? null;
  let qr: string | undefined;
  const issues = new Set(store.get<string[]>('probe', 'issues') ?? []);
  const issue = (name: string): void => {
    issues.add(name);
    try {
      store.set('probe', 'issues', [...issues]);
      store.event('diagnostic', { issue: name });
    } catch { fatal(); }
  };
  const diagnostics = new Writable({
    write(chunk: Buffer, _encoding, next) {
      try {
        const record = object(decode<unknown>(chunk.toString()));
        const message = typeof record.msg === 'string' ? record.msg : 'SDK diagnostic';
        const problem = diagnosticIssue(message);
        if (problem && !stopped) issue(problem);
        // Discard SDK fields that may include message bodies or authentication material.
        process.stderr.write(encode({ level: record.level, message }) + '\n');
        next();
      } catch (error) { next(error instanceof Error ? error : new Error('Diagnostic write failed')); }
    },
  });
  const logger = pino({ level: 'warn' }, diagnostics);
  function interrupt(reason: ReceiveInterruption['reason']): void {
    lastInterruption = { at: clock.now(), reason };
    try { store.set('runtime', 'receive-interruption', lastInterruption); } catch { fatal(); }
  }
  function cancelRetry(): void {
    retryToken = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
  }
  function intervention(reason: Extract<Recovery, { state: 'intervention-required' }>['reason'], code: number | null): void {
    cancelRetry();
    connection = 'close';
    recovery = { state: 'intervention-required', reason, code, attempt: attempts, nextRetryAt: null };
    issue('connection-stopped-review-required');
  }
  function connected(): WASocket {
    if (stopped || !socket || connection !== 'open') throw new Error('WhatsApp connection is not open');
    return socket;
  }
  function validateTarget(jid: string, sending = false): void {
    if ((options.requireAllowedJid || allowedJid !== undefined) && jid !== allowedJid) throw new Error('Mutation requires the exact --test-jid / allowed recipient JID');
    if (!store.chat(jid)) {
      if (!sending || store.recipientCheck(jid)?.status !== 'confirmed') throw new Error('Recipient requires an observed conversation or, for sending, persisted WhatsApp verification via resolve --phone');
      if (store.contactView(jid).mapping.status === 'conflict') throw new Error('Recipient has conflicting PN/LID associations');
    }
    connected();
  }
  function open(): void {
    if (stopped || socket) return;
    qr = undefined;
    receivedPendingNotifications = false;
    connection = 'connecting';
    const token = {};
    owner = token;
    let current: WASocket;
    try { current = socketFactory({
      // rc14 mutates its creds object before emitting/handling updates. Isolate each
      // socket, and copy only updates from the current owner into durable auth state.
      auth: { creds: decode<AuthenticationCreds>(encode(auth.state.creds)), keys: {
        get(category, ids) {
          if (stopped || owner !== token) throw new Error('Socket no longer owns authentication storage');
          try { return auth.state.keys.get(category, ids); } catch { fatal(); }
        },
        set(data) {
          if (stopped || owner !== token) throw new Error('Socket no longer owns authentication storage');
          try { return auth.state.keys.set(data); } catch { fatal(); }
        },
      } }, logger,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      syncFullHistory: false,
      enableRecentMessageCache: false,
      // The SDK can re-relay outgoing messages on retry receipts. Withhold that content
      // to prevent automatic resend of uncertain requests. Inbound decryption retries remain enabled.
      getMessage: async key => stopped || owner !== token || key.fromMe === true ? undefined : store.message(key)?.message ?? undefined,
    }); } catch (error) {
      // The factory may fail after allocating resources, without returning a handle to end.
      // Do not retry it or classify configuration/authentication/persistence failures as outages.
      owner = undefined;
      intervention('socket-creation-failed', disconnectCode(error) ?? null);
      return;
    }
    socket = current;
    let closed!: () => void;
    socketClosed = new Promise<void>(resolve => { closed = resolve; });
    const persist = (action: () => void): void => {
      if (socket !== current || owner !== token || stopped) return;
      try { action(); } catch { fatal(); }
    };
    current.ev.on('creds.update', update => persist(() => {
      // Keep explicit undefined clears while detaching every mutable field from the SDK.
      auth.save({ ...update, ...decode<Partial<AuthenticationCreds>>(encode(update)) });
    }));
    current.ev.on('connection.update', update => {
      // Observe SDK cleanup separately from the transport: rc14 can emit this while
      // ws.isClosing, or return early from end() while another end is still running.
      if (update.connection === 'close') closed();
      persist(() => {
        if ('qr' in update) qr = update.qr;
        if (update.receivedPendingNotifications !== undefined) receivedPendingNotifications = update.receivedPendingNotifications;
        if (update.connection) connection = update.connection;
        store.event('connection', {
          connection, receivedPendingNotifications,
          disconnectCode: disconnectCode(update.lastDisconnect?.error) ?? null,
        });
        if (update.connection === 'open') {
          qr = undefined; attempts = 0;
          recovery = { state: 'open', reason: null, code: null, attempt: 0, nextRetryAt: null };
        }
        if (update.connection === 'close') {
          qr = undefined;
          receivedPendingNotifications = false;
          // Retain the handle until replacement/shutdown proves transport closure too.
          // Invalidating ownership prevents duplicate/late events from owning recovery.
          owner = undefined;
          interrupt('connection-closed');
          const code = disconnectCode(update.lastDisconnect?.error);
          const reason = disconnectReason(code);
          const delay = reconnectDelay(code, attempts);
          if (delay === undefined || code === undefined) intervention(reason, code ?? null);
          else {
            attempts++;
            recovery = { state: 'waiting-retry', reason, code, attempt: attempts, nextRetryAt: clock.now() + delay };
            const pending = {};
            retryToken = pending;
            cancelTimer = clock.schedule(() => {
              if (stopped || retryToken !== pending) return;
              cancelRetry();
              recovery = { state: 'connecting', reason, code, attempt: attempts, nextRetryAt: null };
              void reconnect(false).catch(() => {
                process.stderr.write(encode({ error: 'Socket cleanup failed; recovery requires intervention' }) + '\n');
              });
            }, delay);
          }
        }
      });
    });
    current.ev.on('messaging-history.set', history => persist(() => store.transaction(() => {
      for (const chat of history.chats) store.observeChat(chat);
      for (const contact of history.contacts) store.observeContact(contact, 'messaging-history.set');
      for (const mapping of history.lidPnMappings ?? []) store.observeMapping(mapping.pn, mapping.lid, 'messaging-history.set');
      for (const message of history.messages) store.observeMessage(message);
      store.event('history-chunk', {
        chats: history.chats.length, messages: history.messages.length,
        progress: history.progress ?? null, isLatest: history.isLatest ?? null, syncType: history.syncType ?? null,
      });
    })));
    current.ev.on('messaging-history.status', status => persist(() => {
      store.event('history-status', status);
      if (status.status === 'paused' || !status.explicit) issue('history-completion-not-explicit');
    }));
    current.ev.on('chats.upsert', chats => persist(() => store.transaction(() => {
      for (const chat of chats) store.observeChat(chat);
      store.event('chats.upsert', chats.map(chat => ({ id: chat.id })));
    })));
    current.ev.on('chats.update', chats => persist(() => store.transaction(() => {
      for (const chat of chats) store.observeChat(chat);
      store.event('chats.update', chats);
    })));
    current.ev.on('chats.delete', jids => persist(() => {
      // Keep historical records, but signal that their current existence is no longer known.
      for (const jid of jids) store.db.prepare('DELETE FROM chats WHERE jid=?').run(jid);
      store.event('chats.delete', jids);
    }));
    current.ev.on('messages.upsert', event => persist(() => store.transaction(() => {
      for (const message of event.messages) store.observeMessage(message);
      store.event('messages.upsert', { type: event.type, keys: event.messages.map(message => message.key) });
    })));
    current.ev.on('messages.update', updates => persist(() => store.transaction(() => {
      for (const { key, update } of updates) {
        store.updateMessage({ key, update });
      }
      store.event('messages.update', updates.map(({ key, update }) => ({ key, status: update.status ?? null })));
    })));
    current.ev.on('contacts.upsert', contacts => persist(() => store.transaction(() => {
      for (const contact of contacts) store.observeContact(contact, 'contacts.upsert');
    })));
    current.ev.on('contacts.update', contacts => persist(() => store.transaction(() => {
      for (const contact of contacts) store.observeContact(contact, 'contacts.update');
    })));
    current.ev.on('lid-mapping.update', mapping => persist(() => store.transaction(() => {
      store.observeMapping(mapping.pn, mapping.lid, 'lid-mapping.update');
      store.event('lid-mapping', { pn: mapping.pn, lid: mapping.lid });
    })));
    current.ev.on('message-receipt.update', receipts => persist(() => store.event('participant-receipts', receipts)));
    current.ev.on('messages.delete', event => persist(() => store.deleteMessages(event)));
  }
  async function execute(command: Command): Promise<unknown> {
    switch (command.command) {
      case 'status': return {
        hasLinkedCredentials: hasLinkedCredentials(auth.state.creds),
        registered: auth.state.creds.registered,
        accountJid: auth.state.creds.me?.id ?? null, accountLid: auth.state.creds.me?.lid ?? null,
        allowedJid: allowedJid ?? null, networkEnabled: options.connect, qrAvailable: qr !== undefined,
      };
      case 'chats': return store.chats(command.limit, command.offset, command);
      case 'chat': return store.chatView(command.jid);
      case 'contact': return store.contactView(command.jid);
      case 'resolve': {
        const phone = internationalPhone(command.phone);
        const current = connected();
        const jid = `${phone.slice(1)}@s.whatsapp.net`;
        let status: RecipientCheck['status'] = 'unknown';
        let reason = 'missing-or-partial-response';
        try {
          const result = await current.onWhatsApp(phone);
          const entry = result?.length === 1 ? result[0] : undefined;
          // Exact PN only. Missing, alternate, ambiguous or malformed responses confer no authority.
          if (entry?.jid === jid && typeof entry.exists === 'boolean') {
            status = entry.exists ? 'confirmed' : 'not-found';
            reason = entry.exists ? 'whatsapp-confirmed' : 'whatsapp-not-found';
          }
        } catch { reason = 'sdk-query-failed'; }
        const check: RecipientCheck = { status, source: 'baileys.onWhatsApp', observedAt: Date.now() };
        store.set('recipient-check', jid, check);
        const contact = store.contactView(jid);
        const conflict = contact.mapping.status === 'conflict';
        return {
          phone, status: conflict ? 'unknown' : status, reason: conflict ? 'conflicting-pn-lid-associations' : reason,
          jid: status === 'confirmed' && !conflict ? jid : null,
          source: 'whatsapp', observedAt: check.observedAt, contact,
        };
      }
      case 'messages': return store.messages(command.jid, command.limit, command.offset).map(message => store.messageView(message));
      case 'search': return store.search(command.query, command.limit, command.offset, command.jid).map(message => store.messageView(message));
      case 'group': {
        const metadata = await connected().groupMetadata(command.jid);
        const self = [auth.state.creds.me?.id, auth.state.creds.me?.lid].filter(id => id !== undefined);
        const onlyThisAccount = metadata.participants.length === 0 ? null : metadata.participants.every(participant =>
          [participant.id, participant.lid, participant.phoneNumber].some(id => id && self.some(own => areJidsSameUser(id, own))));
        return { jid: metadata.id, subject: metadata.subject, participantCount: metadata.participants.length, onlyThisAccount };
      }
      case 'events': return store.events(command.after);
      case 'request': return store.request(command.key) ?? null;
      case 'pair-qr': {
        if (!socket || !qr || hasLinkedCredentials(auth.state.creds)) throw new Error('Wait for qrAvailable on an unpaired connection');
        const payload = qr;
        const imagePath = await savePairingQr(payload, store.directory);
        if (qr !== payload || hasLinkedCredentials(auth.state.creds)) throw new Error('QR changed during rendering; request a fresh pair-qr');
        return { imagePath, sensitive: true, generatedAt: Date.now() };
      }
      case 'pair-code':
        if (!socket || !qr || hasLinkedCredentials(auth.state.creds)) throw new Error('Wait for qrAvailable on an unpaired connection');
        return { code: await socket.requestPairingCode(command.phone), sensitive: true };
      case 'resync':
        await connected().resyncAppState([...ALL_WA_PATCH_NAMES], false);
        store.event('resync-call-returned', { verification: 'unknown' });
        return { sdkReturned: true, verification: 'unknown', note: 'Inspect subsequent events and the phone; the SDK can swallow collection failures' };
      case 'drop-connection':
        // Exercise the normal close/reconnect path without explicitly reopening the socket.
        await connected().ws.close();
        return { socketClosed: true, recovery: 'automatic-close-handler' };
      case 'reconnect':
        if (!options.connect) throw new Error('Network access is disabled; restart without --offline (probe: use --connect)');
        if (stopped) throw new Error('Runtime is stopping');
        if (recovery.state === 'intervention-required'
          && (recovery.reason === 'socket-creation-failed' || recovery.reason === 'socket-end-failed')) {
          throw new Error('Socket creation/cleanup failed; investigate and restart the runtime');
        }
        await reconnect();
        return { reconnecting: true };
      case 'send': return perform(store, command.key, { kind: 'send', jid: command.jid, text: command.text },
        () => validateTarget(command.jid, true), async messageId => {
          if (!messageId) throw new Error('Missing persisted message ID');
          return connected().sendMessage(command.jid, { text: command.text, linkPreview: null }, { messageId });
        });
      case 'send-contact': {
        const card = contactCard(command.name, command.phone);
        return perform(store, command.key, { kind: 'send-contact', jid: command.jid, name: command.name, phone: command.phone, vcard: card.vcard },
          () => validateTarget(command.jid, true), async messageId => {
            if (!messageId) throw new Error('Missing persisted message ID');
            return connected().sendMessage(command.jid, { contacts: { displayName: card.displayName, contacts: [card] } }, { messageId });
          });
      }
      case 'send-file': {
        const previous = store.request(command.key);
        if (previous) {
          const op = previous.operation;
          if (op.kind !== 'send-file' || op.jid !== command.jid || op.path !== command.path || op.mime !== command.mime || op.caption !== command.caption) throw new Error('Idempotency key already used with different arguments');
          return previous;
        }
        validateTarget(command.jid, true);
        const { buffer, bytes, sha256 } = await prepareFile(command.path);
        return perform(store, command.key, { kind: 'send-file', jid: command.jid, path: command.path, mime: command.mime, caption: command.caption, bytes, sha256 },
          () => validateTarget(command.jid, true), async messageId => {
            if (!messageId) throw new Error('Missing persisted message ID');
            return connected().sendMessage(command.jid, { document: buffer, mimetype: command.mime, fileName: basename(command.path), caption: command.caption }, { messageId });
          });
      }
      case 'download': {
        if (!options.connect) throw new Error('Media download requires network access; restart without --offline');
        const message = store.locateMessage(command);
        const media = assertMediaContent(normalizeMessageContent(message.message));
        if (toNumber(media.fileLength ?? 0) > MAX_FILE_BYTES) throw new Error('Media exceeds the 64 MiB limit');
        return saveMedia(command.path, () => downloadMediaMessage(message, 'stream', {}, { logger, reuploadRequest: item => connected().updateMediaMessage(item) }));
      }
      case 'archive': case 'mark-read': {
        const operation = { kind: command.command, jid: command.jid, value: command.value };
        const request = await perform(store, command.key, operation, () => {
          validateTarget(command.jid);
          const last = store.messages(command.jid, 1)[0];
          if (!last || toNumber(last.messageTimestamp ?? 0) === 0) throw new Error('A stored last message with timestamp is required');
        }, async () => {
          const lastMessages = store.messages(command.jid, 1).map(({ key, messageTimestamp }) => ({ key, messageTimestamp: toNumber(messageTimestamp ?? 0) }));
          const patch = command.command === 'archive' ? { archive: command.value, lastMessages } : { markRead: command.value, lastMessages };
          await connected().chatModify(patch, command.jid);
        });
        return { request, verification: 'pending-phone-and-subsequent-client-observation', localChat: store.chatView(command.jid) };
      }
      case 'stop': return { stopping: true };
    }
  }
  function fatal(): never {
    process.stderr.write(encode({ error: 'Fatal persistence failure' }) + '\n');
    // Do not keep operating with failed credential/event persistence.
    process.exit(1);
  }
  function reconnect(manual = true): Promise<void> {
    if (replacing) return replacing;
    cancelRetry();
    const previous = socket;
    const previousClosed = socketClosed;
    socket = undefined;
    socketClosed = undefined;
    owner = undefined;
    qr = undefined;
    receivedPendingNotifications = false;
    connection = 'connecting';
    if (manual) {
      attempts = 0;
      recovery = { state: 'connecting', reason: 'manual-reconnect', code: null, attempt: 0, nextRetryAt: null };
      interrupt('manual-reconnect');
    }
    replacing = (async () => {
      try {
        // end() removes transport listeners synchronously, so subscribe after invoking it.
        const sdkEnd = previous?.end(new Error('Reconnect requested'));
        await Promise.all([sdkEnd, previousClosed, previous && transportClosed(previous.ws)]);
      } catch {
        socket = previous; // Retain the handle for shutdown, but never authorize another connection.
        socketClosed = previousClosed;
        if (!stopped) intervention('socket-end-failed', null);
        throw new Error('Socket cleanup failed; investigate and restart the runtime');
      }
      if (!stopped) open();
    })().finally(() => { replacing = undefined; });
    return replacing;
  }
  function shutdown(): Promise<void> {
    if (ending) return ending;
    stopped = true;
    cancelRetry();
    recovery = { state: 'stopping', reason: null, code: null, attempt: 0, nextRetryAt: null };
    qr = undefined;
    receivedPendingNotifications = false;
    if (started && options.connect) interrupt('runtime-stop');
    const current = socket;
    const currentClosed = socketClosed;
    socket = undefined;
    socketClosed = undefined;
    owner = undefined;
    ending = (async () => {
      const sdkEnd = current?.end(new Error('Runtime stopped'));
      await Promise.all([sdkEnd, currentClosed, current && transportClosed(current.ws)]);
      await replacing;
    })();
    return ending;
  }
  return {
    directory: store.directory,
    execute,
    start() {
      if (started || stopped) return;
      started = true;
      if (options.connect) {
        interrupt('runtime-start');
        recovery = { state: 'connecting', reason: 'startup', code: null, attempt: 0, nextRetryAt: null };
        open();
      }
    },
    snapshot() {
      return { connection, recovery: { ...recovery },
        receiveContinuity: { status: 'unproven' as const, lastInterruption: lastInterruption && { ...lastInterruption } },
        source: 'local' as const, coverage: 'partial' as const, appState: 'unknown' as const, receivedPendingNotifications, issues: [...issues] };
    },
    stop: shutdown,
    close() {
      closing ??= (async () => {
        await shutdown();
        auth.save({});
        store.close();
      })();
      return closing;
    },
  };
}

function transportClosed(ws: WASocket['ws']): Promise<void> {
  if (ws.isClosed) return Promise.resolve();
  return new Promise<void>(resolve => { ws.once('close', resolve); });
}

function disconnectCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('output' in error)) return undefined;
  const output = object(error.output);
  return typeof output.statusCode === 'number' && Number.isSafeInteger(output.statusCode) ? output.statusCode : undefined;
}
