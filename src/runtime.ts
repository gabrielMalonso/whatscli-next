import { Writable } from 'node:stream';
import makeWASocket, { ALL_WA_PATCH_NAMES, areJidsSameUser, assertMediaContent, downloadMediaMessage, normalizeMessageContent, toNumber } from 'baileys';
import { basename } from 'node:path';
import type { WASocket } from 'baileys';
import { pino } from 'pino';
import { hasLinkedCredentials, sqliteAuth } from './auth.js';
import { diagnosticIssue, reconnectDelay } from './health.js';
import { internationalPhone, recipientJid } from './identity.js';
import type { RecipientCheck } from './identity.js';
import { perform } from './operations.js';
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
export function createRuntime(options: RuntimeOptions, socketFactory = makeWASocket) {
  const allowedJid = options.allowedJid === undefined ? undefined : recipientJid(options.allowedJid);
  const store = new Store(options.dataDir);
  const auth = sqliteAuth(store);
  let socket: WASocket | undefined;
  let connection = 'offline';
  let receivedPendingNotifications = false;
  let attempts = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ending: Promise<void> | undefined;
  let qr: string | undefined;
  const issues = new Set(store.get<string[]>('probe', 'issues') ?? []);
  const issue = (name: string): void => {
    issues.add(name);
    store.set('probe', 'issues', [...issues]);
    store.event('diagnostic', { issue: name });
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
  function connected(): WASocket {
    if (!socket || connection !== 'open') throw new Error('WhatsApp connection is not open');
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
    if (stopped) return;
    qr = undefined;
    receivedPendingNotifications = false;
    connection = 'connecting';
    const current = socketFactory({
      auth: auth.state, logger,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      syncFullHistory: false,
      enableRecentMessageCache: false,
      // The SDK can re-relay outgoing messages on retry receipts. Withhold that content
      // to prevent automatic resend of uncertain requests. Inbound decryption retries remain enabled.
      getMessage: async key => key.fromMe === true ? undefined : store.message(key)?.message ?? undefined,
    });
    socket = current;
    const persist = (action: () => void): void => {
      if (socket !== current || stopped) return;
      try { action(); } catch (error) { fatal(error); }
    };
    current.ev.on('creds.update', update => persist(() => auth.save(update)));
    current.ev.on('connection.update', update => persist(() => {
      if ('qr' in update) qr = update.qr;
      if (update.receivedPendingNotifications !== undefined) receivedPendingNotifications = update.receivedPendingNotifications;
      if (update.connection) connection = update.connection;
      store.event('connection', {
        connection, receivedPendingNotifications,
        disconnectCode: disconnectCode(update.lastDisconnect?.error) ?? null,
      });
      if (update.connection === 'open') { qr = undefined; attempts = 0; }
      if (update.connection === 'close') {
        qr = undefined;
        const delay = reconnectDelay(disconnectCode(update.lastDisconnect?.error), attempts++);
        if (delay === undefined) issue('connection-stopped-review-required');
        else {
          clearTimeout(timer);
          timer = setTimeout(() => { try { open(); } catch (error) { fatal(error); } }, delay);
        }
      }
    }));
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
        clearTimeout(timer);
        const previous = socket;
        socket = undefined;
        await previous?.end(new Error('Probe reconnect requested'));
        attempts = 0;
        open();
        return { reconnecting: true };
      case 'send': return perform(store, command.key, { kind: 'send', jid: command.jid, text: command.text },
        () => validateTarget(command.jid, true), async messageId => {
          if (!messageId) throw new Error('Missing persisted message ID');
          return connected().sendMessage(command.jid, { text: command.text, linkPreview: null }, { messageId });
        });
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
  function fatal(error: unknown): void {
    process.stderr.write(encode({ error: error instanceof Error ? error.message : 'Fatal persistence failure' }) + '\n');
    // Do not keep operating with failed credential/event persistence.
    process.exit(1);
  }
  function shutdown(): Promise<void> {
    if (ending) return ending;
    stopped = true;
    clearTimeout(timer);
    const current = socket;
    socket = undefined;
    ending = current?.end(new Error('Probe stopped')) ?? Promise.resolve();
    return ending;
  }
  let closed = false;
  return {
    directory: store.directory,
    execute,
    start() { if (options.connect) open(); },
    snapshot() {
      return { connection, source: 'local' as const, coverage: 'partial' as const, appState: 'unknown' as const, receivedPendingNotifications, issues: [...issues] };
    },
    stop: shutdown,
    async close() {
      if (closed) return;
      await shutdown();
      auth.save({});
      store.close();
      closed = true;
    },
  };
}

function disconnectCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('output' in error)) return undefined;
  const output = object(error.output);
  return typeof output.statusCode === 'number' ? output.statusCode : undefined;
}
