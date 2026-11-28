import { Writable } from 'node:stream';
import makeWASocket, {
  ALL_WA_PATCH_NAMES,
  areJidsSameUser,
  assertMediaContent,
  downloadMediaMessage,
  jidNormalizedUser,
  normalizeMessageContent,
  toNumber,
  USyncQuery,
  USyncUser,
} from 'baileys';
import { basename } from 'node:path';
import type {
  AuthenticationCreds,
  BaileysEventMap,
  ChatUpdate,
  WAMessageKey,
  WASocket,
} from 'baileys';
import { pino } from 'pino';
import { hasLinkedCredentials, sqliteAuth } from './auth.js';
import {
  diagnosticIssue,
  disconnectReason,
  HANDSHAKE_TIMEOUT_MS,
  reconnectDelay,
  retryDelay,
} from './health.js';
import { sdkDiagnostic, writeDiagnostic } from './diagnostics.js';
import type { LogValue } from './diagnostics.js';
import type {
  ReceiveInterruption,
  Recovery,
  RecoveryClock,
  RecoveryState,
  RetryReason,
} from './health.js';
import {
  accountUser,
  internationalPhone,
  isLid,
  recipientJid,
} from './identity.js';
import type { RecipientCheck } from './identity.js';
import { perform as performOperation } from './operations.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Observability } from './observability.js';
import type { ObsFields } from './observability.js';
import { commandFields, resultFields } from './observability-context.js';
import { observeProcess } from './observability-runtime.js';
import { CommandError, errorResponse } from './errors.js';
import { createBackup } from './backup.js';
import { unprovenRoute } from './send-route.js';
import type { SendRoute } from './send-route.js';
import { contactCard } from './contact-card.js';
import { prepareQuote, quotedMessage } from './quoted-text.js';
import { MAX_FILE_BYTES, prepareFile, saveMedia } from './media.js';
import { savePairingQr } from './pairing.js';
import { decode, encode, Store } from './store.js';
import type { PendingChatState, RequestRecord } from './store.js';
import { isUnreadCount } from './output.js';
import { withoutDerivedMessageEdit } from './message-edits.js';

import { object } from './protocol.js';
import type { Command } from './protocol.js';

// pnpm build stamps this literal into the emitted runtime, never a separate mutable sidecar.
// Plain tsc/source execution stays unknown; status does no disk or Git inspection.
const buildFingerprint: string | null = /* @build-fingerprint */ null;

export type AckWait = {
  requestedMs: number;
  waitedMs: number;
  /** What ended the wait. Only `accepted` and `error` reflect request evidence. */
  outcome: 'accepted' | 'error' | 'timeout' | 'interrupted';
};

export type RuntimeOptions = {
  dataDir: string;
  connect: boolean;
  allowedJid?: string;
  requireAllowedJid?: boolean;
  /** Daemon lifecycle log sink; safe scalar fields only. Embedders and tests default to silence. */
  lifecycle?: (record: Record<string, LogValue>) => void;
};

/** The one Baileys connection and the one database writer shared by both transports. */
export function createRuntime(
  options: RuntimeOptions,
  socketFactory = makeWASocket,
  clock: RecoveryClock = {
    now: Date.now,
    schedule(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  },
  backupDatabase = createBackup,
) {
  const allowedJid =
    options.allowedJid === undefined
      ? undefined
      : recipientJid(options.allowedJid);
  const store = new Store(options.dataDir);
  const auth = sqliteAuth(store);
  const observability = new Observability(store.directory, 'runtime');
  const processObservation = observeProcess(observability);
  const execution = new AsyncLocalStorage<{
    invoked: boolean;
    replay: boolean;
  }>();
  function perform(
    ...args: Parameters<typeof performOperation>
  ): ReturnType<typeof performOperation> {
    const context = execution.getStore();
    args[6] = (phase) => {
      if (context) {
        if (phase === 'invoke') context.invoked = true;
        else context.replay = true;
      }
    };
    return performOperation(...args);
  }
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
  let cancelWatchdogTimer: (() => void) | undefined;
  let watchdogToken: object | undefined;
  let replacing: Promise<void> | undefined;
  let ending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let backupWork: ReturnType<typeof createBackup> | undefined;
  let recovery: Recovery = {
    state: 'offline',
    reason: null,
    code: null,
    attempt: 0,
    nextRetryAt: null,
    since: clock.now(),
  };
  /** Every recovery transition goes through here so `since` always matches the current state. */
  const enterRecovery = (next: RecoveryState): void => {
    recovery = { ...next, since: clock.now() };
  };
  let lastInterruption =
    store.get<ReceiveInterruption>('runtime', 'receive-interruption') ?? null;
  /** State, fixed reason label, numeric code and attempt only; never SDK errors or JIDs. */
  const logConnection = (disconnect: number | null): void => {
    try {
      options.lifecycle?.({
        level: 'lifecycle',
        event: 'connection',
        state: connection,
        recovery: recovery.state,
        reason: recovery.reason,
        disconnectCode: disconnect,
        attempt: recovery.attempt,
      });
    } catch {
      /* Logging never changes connection handling. */
    }
  };
  let qr: string | undefined;
  // Response-only waits for locally observed acceptance of an already persisted send.
  // Each settles from committed store state after observed events, never by polling or resending.
  const ackWaiters = new Set<(interrupted: boolean) => void>();
  function settleAckWaits(): void {
    if (ackWaiters.size === 0 || store.db.isTransaction) return;
    const interrupted = stopped || connection !== 'open';
    for (const settle of [...ackWaiters]) settle(interrupted);
  }
  function waitForAck(key: string, requestedMs: number): Promise<unknown> {
    const startedAt = clock.now();
    return new Promise((resolve, reject) => {
      let cancel = () => {};
      const settle = (
        ended: false | 'timeout' | 'interrupted',
      ): RequestRecord | undefined => {
        // The same projection request --key returns at this moment.
        let latest: RequestRecord | undefined;
        try {
          latest = store.request(key);
        } catch (cause) {
          // Never throw into SDK event delivery or a timer; the committed intent stays authoritative.
          ackWaiters.delete(waiter);
          cancel();
          reject(
            new CommandError(
              'LOCAL_STATE',
              'Request state could not be read during the acceptance wait; inspect the original idempotency key',
              { cause },
            ),
          );
          return undefined;
        }
        if (!latest) return undefined;
        const outcome =
          latest.acceptance === 'server-ack'
            ? 'accepted'
            : latest.errorObserved
              ? 'error'
              : ended;
        if (!outcome) return latest;
        ackWaiters.delete(waiter);
        cancel();
        const wait: AckWait = {
          requestedMs,
          waitedMs: Math.max(0, clock.now() - startedAt),
          outcome,
        };
        resolve({ ...latest, wait });
        return latest;
      };
      const waiter = (interrupted: boolean): void => {
        settle(interrupted ? 'interrupted' : false);
      };
      ackWaiters.add(waiter);
      cancel = clock.schedule(() => {
        if (ackWaiters.has(waiter)) settle('timeout');
      }, requestedMs);
      if (
        !settle(stopped || connection !== 'open' ? 'interrupted' : false) &&
        ackWaiters.has(waiter)
      ) {
        // No persisted intent means there is nothing to wait for; return what is known.
        ackWaiters.delete(waiter);
        cancel();
        resolve(null);
      }
    });
  }
  // `issues` keeps every code ever recorded; `issue-log` adds timing from this build onward.
  const issues = new Set(store.get<string[]>('probe', 'issues') ?? []);
  const issueLog = readIssueLog(store.get<unknown>('probe', 'issue-log'));
  // Codes observed by this runtime process; nothing here is ever cleared by elapsed time.
  const sessionIssues = new Set<string>();
  const issue = (name: string): void => {
    const now = clock.now();
    const previous = issueLog.get(name);
    issueLog.set(
      name,
      previous
        ? { ...previous, count: previous.count + 1, lastAt: now }
        : // A code recorded before timing was kept has an unknown first time and total.
          { count: 1, firstAt: issues.has(name) ? null : now, lastAt: now },
    );
    issues.add(name);
    sessionIssues.add(name);
    try {
      store.transaction(() => {
        store.set('probe', 'issues', [...issues]);
        store.set('probe', 'issue-log', Object.fromEntries(issueLog));
        store.event('diagnostic', { issue: name });
      });
    } catch {
      fatal();
    }
  };
  /** Conservative: active means current state or an observation by this process, never inferred recovery. */
  const issueActive = (code: string): boolean =>
    code === 'connection-stopped-review-required'
      ? recovery.state === 'intervention-required'
      : sessionIssues.has(code);
  const issueDetail = (code: string) => {
    const logged = issueLog.get(code);
    return {
      code,
      count: logged?.count ?? null,
      firstAt: logged?.firstAt ?? null,
      lastAt: logged?.lastAt ?? null,
    };
  };
  const diagnostics = new Writable({
    write(chunk: Buffer, _encoding, next) {
      try {
        const record = object(decode<unknown>(chunk.toString()));
        const message =
          typeof record.msg === 'string' ? record.msg : 'SDK diagnostic';
        const problem = diagnosticIssue(message);
        if (problem && !stopped) issue(problem);
        // msg can itself interpolate identifiers/errors; fields and arbitrary text stay private.
        const level =
          typeof record.level === 'number' ? record.level : undefined;
        observability.record('diagnostic', {
          label: 'sdk',
          ...(problem ? { issue: problem } : {}),
        });
        writeDiagnostic({ level, message: sdkDiagnostic(message, problem) });
        next();
      } catch (error) {
        next(
          error instanceof Error ? error : new Error('Diagnostic write failed'),
        );
      }
    },
  });
  const logger = pino({ level: 'warn' }, diagnostics);
  const sendPreparation = {
    pending: new Map<string, Promise<void>>(),
    async route(jid: string): Promise<SendRoute> {
      const current = connected();
      let result: Awaited<ReturnType<WASocket['executeUSyncQuery']>>;
      try {
        result = await current.executeUSyncQuery(
          new USyncQuery()
            .withLIDProtocol()
            .withContext('background')
            .withUser(new USyncUser().withId(jid)),
        );
      } catch {
        return unprovenRoute(jid, clock.now(), 'query-failed');
      }
      if (current !== socket || stopped || connection !== 'open')
        throw new CommandError(
          'PRECONDITION_FAILED',
          'Connection changed during route preparation; no send was attempted',
        );
      const entry =
        result && Array.isArray(result.list) && result.list.length === 1
          ? result.list[0]
          : undefined;
      if (
        entry?.id !== jid ||
        typeof entry.lid !== 'string' ||
        !isLid(entry.lid)
      )
        return unprovenRoute(jid, clock.now(), 'invalid-response');
      return {
        status: 'proven',
        jid: entry.lid,
        source: 'baileys.executeUSyncQuery/lid',
        observedAt: clock.now(),
        limit: 'server-association-at-query-time',
      };
    },
  };
  function interrupt(reason: ReceiveInterruption['reason']): void {
    lastInterruption = { at: clock.now(), reason };
    try {
      store.set('runtime', 'receive-interruption', lastInterruption);
    } catch {
      fatal();
    }
  }
  function cancelRetry(): void {
    retryToken = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
  }
  function cancelWatchdog(): void {
    watchdogToken = undefined;
    cancelWatchdogTimer?.();
    cancelWatchdogTimer = undefined;
  }
  function cancelRecoveryTimers(): void {
    cancelRetry();
    cancelWatchdog();
  }
  /** Count the attempt, publish its deadline and reconnect through the shared replacement path. */
  function scheduleRetry(
    reason: RetryReason,
    code: number | null,
    delay: number,
  ): void {
    attempts++;
    enterRecovery({
      state: 'waiting-retry',
      reason,
      code,
      attempt: attempts,
      nextRetryAt: clock.now() + delay,
    });
    const pending = {};
    retryToken = pending;
    cancelTimer = clock.schedule(() => {
      if (stopped || retryToken !== pending) return;
      cancelRetry();
      enterRecovery({
        state: 'connecting',
        reason,
        code,
        attempt: attempts,
        nextRetryAt: null,
      });
      void reconnect(false).catch(() => {
        writeDiagnostic({
          error: 'Socket cleanup failed; recovery requires intervention',
        });
      });
    }, delay);
  }
  /**
   * Bound the connecting phase of one socket. The SDK may never report open or close
   * (observed after a 503 retry), which would otherwise leave recovery connecting forever.
   */
  function armWatchdog(current: WASocket, token: object): void {
    cancelWatchdog();
    const pending = {};
    watchdogToken = pending;
    cancelWatchdogTimer = clock.schedule(() => {
      if (watchdogToken !== pending) return;
      cancelWatchdog();
      // Only the socket that armed this watchdog, still owning recovery, can time out.
      if (stopped || socket !== current || owner !== token) return;
      if (connection === 'open') return;
      handshakeTimedOut(current);
    }, HANDSHAKE_TIMEOUT_MS);
  }
  function handshakeTimedOut(current: WASocket): void {
    // Same transitions as an observed close. Invalidating ownership first keeps the
    // close event that end() emits (and any late open) from owning recovery again.
    owner = undefined;
    qr = undefined;
    receivedPendingNotifications = false;
    connection = 'close';
    settleAckWaits();
    try {
      store.event('connection', {
        connection,
        receivedPendingNotifications,
        disconnectCode: null,
        reason: 'handshake-timeout',
      });
    } catch {
      fatal();
    }
    interrupt('connection-closed');
    scheduleRetry('handshake-timeout', null, retryDelay(attempts));
    logConnection(null);
    observability.record('diagnostic', {
      label: 'connection',
      connection,
      recovery: recovery.state,
    });
    // The handle stays in `socket`; the retry's replacement awaits SDK and transport closure.
    try {
      void current.end(new Error('Handshake timed out')).catch(() => undefined);
    } catch {
      /* The retry's replacement repeats end() and reports cleanup failure. */
    }
  }
  function intervention(
    reason: Extract<Recovery, { state: 'intervention-required' }>['reason'],
    code: number | null,
  ): void {
    cancelRecoveryTimers();
    connection = 'close';
    enterRecovery({
      state: 'intervention-required',
      reason,
      code,
      attempt: attempts,
      nextRetryAt: null,
    });
    issue('connection-stopped-review-required');
  }
  function connected(): WASocket {
    if (stopped || !socket || connection !== 'open')
      throw new CommandError(
        'PRECONDITION_FAILED',
        'WhatsApp connection is not open',
      );
    return socket;
  }
  function validateTarget(jid: string, sending = false): void {
    if (
      (options.requireAllowedJid || allowedJid !== undefined) &&
      jid !== allowedJid
    )
      throw new CommandError(
        'PRECONDITION_FAILED',
        'Mutation requires the exact --test-jid / allowed recipient JID',
      );
    if (!store.chat(jid)) {
      if (!sending || store.recipientCheck(jid)?.status !== 'confirmed')
        throw new CommandError(
          'PRECONDITION_FAILED',
          'Recipient requires an observed conversation or, for sending, persisted WhatsApp verification via resolve --phone',
        );
      if (store.contactView(jid).mapping.status === 'conflict')
        throw new CommandError(
          'PRECONDITION_FAILED',
          'Recipient has conflicting PN/LID associations',
        );
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
    try {
      current = socketFactory({
        // rc14 mutates its creds object before emitting/handling updates. Isolate each
        // socket, and copy only updates from the current owner into durable auth state.
        auth: {
          creds: decode<AuthenticationCreds>(encode(auth.state.creds)),
          keys: {
            get(category, ids) {
              if (stopped || owner !== token)
                throw new Error('Socket no longer owns authentication storage');
              try {
                return auth.state.keys.get(category, ids);
              } catch {
                fatal();
              }
            },
            set(data) {
              if (stopped || owner !== token)
                throw new Error('Socket no longer owns authentication storage');
              try {
                return auth.state.keys.set(data);
              } catch {
                fatal();
              }
            },
          },
        },
        logger,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        syncFullHistory: false,
        enableRecentMessageCache: false,
        // The SDK can re-relay outgoing messages on retry receipts. Withhold that content
        // to prevent automatic resend of uncertain requests. Inbound decryption retries remain enabled.
        getMessage: async (key) =>
          stopped || owner !== token || key.fromMe === true
            ? undefined
            : (store.message(key)?.message ?? undefined),
      });
    } catch (error) {
      // The factory may fail after allocating resources, without returning a handle to end.
      // Do not retry it or classify configuration/authentication/persistence failures as outages.
      owner = undefined;
      intervention('socket-creation-failed', disconnectCode(error) ?? null);
      logConnection(recovery.code);
      return;
    }
    socket = current;
    armWatchdog(current, token);
    let closed!: () => void;
    socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const persist = (action: () => void): void => {
      if (socket !== current || owner !== token || stopped) return;
      try {
        action();
      } catch {
        fatal();
      }
      settleAckWaits();
    };
    // Local echoes have their own typed event; legacy callbacks are independent.
    // Apply accepted state before buffering can sum absolute actions with deltas.
    const emit = current.ev.emit.bind(current.ev);
    const latestCaptures = new Map<
      string,
      Partial<Record<keyof PendingChatState, number>>
    >();
    let captureOrder = 0;
    const captureChat = (
      chat: ChatUpdate,
      snapshot: boolean,
      failedReplayTimes?: ReadonlySet<number>,
    ): void => {
      if (!chat.id) return;
      const jid = chat.id;
      const pending = store.get<PendingChatState>('pending-chat', jid) ?? {};
      const pendingKeys = {
        unread: pending.unread?.key ?? null,
        archived: pending.archived?.key ?? null,
      };
      const order = ++captureOrder;
      const raw = { ...chat };
      delete raw.conditional;
      let activated = false;
      const activate = (): void => {
        if (activated) return;
        activated = true;
        persist(() =>
          store.transaction(() => {
            const latest = latestCaptures.get(jid) ?? {};
            const accepted = { ...raw };
            if (
              isUnreadCount(raw.unreadCount) ||
              typeof raw.markedAsUnread === 'boolean'
            ) {
              if (order > (latest.unread ?? 0)) latest.unread = order;
              else {
                delete accepted.unreadCount;
                delete accepted.markedAsUnread;
              }
            }
            if (typeof raw.archived === 'boolean') {
              if (order > (latest.archived ?? 0)) latest.archived = order;
              else delete accepted.archived;
            }
            latestCaptures.set(jid, latest);
            store.observeChat(
              accepted,
              snapshot ? 'snapshot' : 'update',
              pendingKeys,
              failedReplayTimes,
            );
          }),
        );
      };
      const conditional = chat.conditional;
      if (!snapshot && conditional && current.ev.isBuffering())
        chat.conditional = (data) => {
          const matched = conditional(data);
          if (matched === true) activate();
          return matched;
        };
      else activate();
    };
    const projectChat = (
      chat: ChatUpdate,
      source: 'buffered-update' | 'buffered-snapshot',
    ): void => {
      const metadata = { ...chat };
      // State was already applied at capture, or its condition was not accepted.
      // A consolidated callback cannot apply it again or resolve a newer intent.
      delete metadata.unreadCount;
      delete metadata.markedAsUnread;
      delete metadata.archived;
      store.observeChat(metadata, source);
    };
    current.ev.emit = (event, value) => {
      if (event === 'messages.update')
        return emit(
          'messages.update',
          (value as BaileysEventMap['messages.update']).map(
            withoutDerivedMessageEdit,
          ),
        );
      if (event === 'chats.update' || event === 'chats.upsert') {
        const chats = value as BaileysEventMap['chats.update' | 'chats.upsert'];
        persist(() =>
          store.transaction(() => {
            for (const chat of chats)
              captureChat(chat, event === 'chats.upsert');
          }),
        );
      }
      if (event === 'messages.upsert' || event === 'messaging-history.set') {
        const upsert = value as BaileysEventMap[
          'messages.upsert' | 'messaging-history.set'];
        persist(() =>
          store.transaction(() => {
            // A type change can flush earlier receipts inside the SDK's emit().
            for (const message of upsert.messages)
              store.captureMessageRange(message);
            if (event === 'messaging-history.set') {
              const history = value as BaileysEventMap['messaging-history.set'];
              const replayTimes = store.failedReplayTimes(history.messages);
              for (const chat of history.chats)
                if (chat.id) captureChat(chat, true, replayTimes.get(chat.id));
            }
          }),
        );
      }
      return emit(event, value);
    };
    current.ev.on('creds.update', (update) =>
      persist(() => {
        // Keep explicit undefined clears while detaching every mutable field from the SDK.
        auth.save({
          ...update,
          ...decode<Partial<AuthenticationCreds>>(encode(update)),
        });
      }),
    );
    current.ev.on('connection.update', (update) => {
      // Observe SDK cleanup separately from the transport: rc14 can emit this while
      // ws.isClosing, or return early from end() while another end is still running.
      const admitted = socket === current && owner === token && !stopped;
      if (update.connection === 'close') closed();
      persist(() => {
        // Open, close or a pairing QR all end the handshake phase this watchdog bounds.
        if (
          update.connection === 'open' ||
          update.connection === 'close' ||
          typeof update.qr === 'string'
        )
          cancelWatchdog();
        if ('qr' in update) qr = update.qr;
        if (update.receivedPendingNotifications !== undefined)
          receivedPendingNotifications = update.receivedPendingNotifications;
        if (update.connection) connection = update.connection;
        store.event('connection', {
          connection,
          receivedPendingNotifications,
          disconnectCode: disconnectCode(update.lastDisconnect?.error) ?? null,
        });
        if (update.connection === 'open') {
          qr = undefined;
          attempts = 0;
          enterRecovery({
            state: 'open',
            reason: null,
            code: null,
            attempt: 0,
            nextRetryAt: null,
          });
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
          if (delay === undefined || code === undefined)
            intervention(reason, code ?? null);
          else scheduleRetry(reason, code, delay);
        }
      });
      if (admitted && update.connection)
        logConnection(disconnectCode(update.lastDisconnect?.error) ?? null);
      if (admitted)
        observability.record('diagnostic', {
          label: 'connection',
          connection,
          recovery: recovery.state,
        });
    });
    current.ev.on('messaging-history.set', (history) =>
      persist(() =>
        store.transaction(() => {
          for (const chat of history.chats)
            projectChat(chat, 'buffered-snapshot');
          for (const contact of history.contacts)
            store.observeContact(contact, 'messaging-history.set');
          for (const mapping of history.lidPnMappings ?? [])
            store.observeMapping(
              mapping.pn,
              mapping.lid,
              'messaging-history.set',
            );
          for (const message of history.messages) store.observeMessage(message);
          store.event('history-chunk', {
            chats: history.chats.length,
            messages: history.messages.length,
            progress: history.progress ?? null,
            isLatest: history.isLatest ?? null,
            syncType: history.syncType ?? null,
          });
        }),
      ),
    );
    current.ev.on('messaging-history.status', (status) =>
      persist(() => {
        store.event('history-status', status);
        if (status.status === 'paused' || !status.explicit)
          issue('history-completion-not-explicit');
      }),
    );
    current.ev.on('chats.upsert', (chats) =>
      persist(() =>
        store.transaction(() => {
          for (const chat of chats) projectChat(chat, 'buffered-snapshot');
          store.event(
            'chats.upsert',
            chats.map((chat) => ({ id: chat.id })),
          );
        }),
      ),
    );
    current.ev.on('chats.update', (chats) =>
      persist(() =>
        store.transaction(() => {
          for (const chat of chats) projectChat(chat, 'buffered-update');
          store.event('chats.update', chats);
        }),
      ),
    );
    current.ev.on('app-state.update', (event) => {
      persist(() =>
        store.transaction(() => {
          if (event.kind === 'patch-response')
            store.recordAppStateResponse(event);
          else store.recordAppStateChatAction(event);
        }),
      );
    });
    current.ev.on('chats.delete', (jids) =>
      persist(() =>
        store.transaction(() => {
          // Keep historical records, but signal that their current existence is no longer known.
          for (const jid of jids) store.observeChatDeletion(jid);
          store.event('chats.delete', jids);
        }),
      ),
    );
    current.ev.on('messages.upsert', (event) =>
      persist(() =>
        store.transaction(() => {
          for (const message of event.messages)
            store.observeMessage(message, true, event.type);
          // A receipt absorbed into A cannot cover an untracked B later in this batch.
          for (const message of event.messages) {
            for (const receipt of message.userReceipt ?? [])
              observeOwnRead(message.key, receipt);
          }
          store.event('messages.upsert', {
            type: event.type,
            keys: event.messages.map((message) => message.key),
          });
        }),
      ),
    );
    current.ev.on('messages.update', (updates) =>
      persist(() =>
        store.transaction(() => {
          for (const { key, update } of updates) {
            store.updateMessage({ key, update });
          }
          store.event(
            'messages.update',
            updates.map(({ key, update }) => ({
              key,
              status: update.status ?? null,
            })),
          );
        }),
      ),
    );
    current.ev.on('messages.update', (updates) => {
      if (socket !== current || owner !== token || stopped) return;
      for (const { key, update } of updates)
        if (update.status !== undefined) observeMessageKey(key, update.status);
    });
    current.ev.on('contacts.upsert', (contacts) =>
      persist(() =>
        store.transaction(() => {
          for (const contact of contacts)
            store.observeContact(contact, 'contacts.upsert');
        }),
      ),
    );
    current.ev.on('contacts.update', (contacts) =>
      persist(() =>
        store.transaction(() => {
          for (const contact of contacts)
            store.observeContact(contact, 'contacts.update');
        }),
      ),
    );
    current.ev.on('lid-mapping.update', (mapping) =>
      persist(() =>
        store.transaction(() => {
          store.observeMapping(mapping.pn, mapping.lid, 'lid-mapping.update');
          store.event('lid-mapping', { pn: mapping.pn, lid: mapping.lid });
        }),
      ),
    );
    current.ev.on('message-receipt.update', (receipts) =>
      persist(() =>
        store.transaction(() => {
          store.event('participant-receipts', receipts);
          for (const { key, receipt } of receipts) {
            observeOwnRead(key, receipt);
            observeMessageKey(key);
          }
        }),
      ),
    );
    function observeOwnRead(
      key: WAMessageKey,
      receipt: BaileysEventMap['message-receipt.update'][number]['receipt'],
    ): void {
      if (!receipt.userJid || receipt.readTimestamp == null) return;
      const user = jidNormalizedUser(receipt.userJid);
      if (
        ![auth.state.creds.me?.id, auth.state.creds.me?.lid].some(
          (self) => self && jidNormalizedUser(self) === user,
        )
      )
        return;
      store.observeOwnReadReceipt(key, toNumber(receipt.readTimestamp));
    }
    current.ev.on('messages.delete', (event) =>
      persist(() => store.deleteMessages(event)),
    );
  }
  async function execute(command: Command): Promise<unknown> {
    switch (command.command) {
      case 'observability':
        return processObservation.status();
      case 'backup': {
        if (stopped || backupWork)
          throw new CommandError(
            'PRECONDITION_FAILED',
            'Runtime is stopping or another backup is in progress',
          );
        backupWork = backupDatabase(store.db, command.path);
        try {
          return await backupWork;
        } finally {
          backupWork = undefined;
        }
      }
      case 'status':
        return {
          build: { fingerprint: buildFingerprint },
          observability: processObservation.status(),
          hasLinkedCredentials: hasLinkedCredentials(auth.state.creds),
          registered: auth.state.creds.registered,
          accountJid: auth.state.creds.me?.id ?? null,
          accountLid: auth.state.creds.me?.lid ?? null,
          allowedJid: allowedJid ?? null,
          networkEnabled: options.connect,
          qrAvailable: qr !== undefined,
          issueHistory: [...issues].map((code) => ({
            ...issueDetail(code),
            active: issueActive(code),
          })),
        };
      case 'chats':
        return store.chats(command.limit, command.offset, command);
      case 'chat':
        return store.chatView(command.jid);
      case 'contact':
        return store.contactView(command.jid);
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
        } catch {
          reason = 'sdk-query-failed';
        }
        const check: RecipientCheck = {
          status,
          source: 'baileys.onWhatsApp',
          observedAt: Date.now(),
        };
        store.set('recipient-check', jid, check);
        const contact = store.contactView(jid);
        const conflict = contact.mapping.status === 'conflict';
        return {
          phone,
          status: conflict ? 'unknown' : status,
          reason: conflict ? 'conflicting-pn-lid-associations' : reason,
          jid: status === 'confirmed' && !conflict ? jid : null,
          source: 'whatsapp',
          observedAt: check.observedAt,
          contact,
        };
      }
      case 'incoming':
        return store.incomingView(command.jid, command.afterId, command.limit);
      case 'messages':
        return store
          .messages(command.jid, command.limit, command.offset)
          .map((message) => store.messageView(message));
      case 'search':
        return store
          .search(command.query, command.limit, command.offset, command.jid)
          .map((message) => store.messageView(message));
      case 'group': {
        const metadata = await connected().groupMetadata(command.jid);
        const self = [auth.state.creds.me?.id, auth.state.creds.me?.lid].filter(
          (id) => id !== undefined,
        );
        const onlyThisAccount =
          metadata.participants.length === 0
            ? null
            : metadata.participants.every((participant) =>
                [participant.id, participant.lid, participant.phoneNumber].some(
                  (id) => id && self.some((own) => areJidsSameUser(id, own)),
                ),
              );
        return {
          jid: metadata.id,
          subject: metadata.subject,
          participantCount: metadata.participants.length,
          onlyThisAccount,
        };
      }
      case 'events':
        return store.events(command.after, {
          ...(command.tail === undefined ? {} : { tail: command.tail }),
          ...(command.kind === undefined ? {} : { kind: command.kind }),
        });
      case 'request':
        return store.request(command.key) ?? null;
      case 'pair-qr': {
        if (!socket || !qr || hasLinkedCredentials(auth.state.creds))
          throw new CommandError(
            'PRECONDITION_FAILED',
            'Wait for qrAvailable on an unpaired connection',
          );
        const payload = qr;
        const imagePath = await savePairingQr(payload, store.directory);
        if (qr !== payload || hasLinkedCredentials(auth.state.creds))
          throw new CommandError(
            'PRECONDITION_FAILED',
            'QR changed during rendering; request a fresh pair-qr',
          );
        return { imagePath, sensitive: true, generatedAt: Date.now() };
      }
      case 'pair-code':
        if (!socket || !qr || hasLinkedCredentials(auth.state.creds))
          throw new CommandError(
            'PRECONDITION_FAILED',
            'Wait for qrAvailable on an unpaired connection',
          );
        return {
          code: await socket.requestPairingCode(command.phone),
          sensitive: true,
        };
      case 'resync':
        await connected().resyncAppState([...ALL_WA_PATCH_NAMES], false);
        store.event('resync-call-returned', { verification: 'unknown' });
        return {
          sdkReturned: true,
          verification: 'unknown',
          note: 'Inspect subsequent events and the phone; the SDK can swallow collection failures',
        };
      case 'drop-connection':
        // Exercise the normal close/reconnect path without explicitly reopening the socket.
        await connected().ws.close();
        return { socketClosed: true, recovery: 'automatic-close-handler' };
      case 'reconnect':
        if (!options.connect)
          throw new CommandError(
            'PRECONDITION_FAILED',
            'Network access is disabled; restart without --offline (probe: use --connect)',
          );
        if (stopped)
          throw new CommandError('PRECONDITION_FAILED', 'Runtime is stopping');
        if (
          recovery.state === 'intervention-required' &&
          (recovery.reason === 'socket-creation-failed' ||
            recovery.reason === 'socket-end-failed')
        ) {
          throw new CommandError(
            'PRECONDITION_FAILED',
            'Socket creation/cleanup failed; investigate and restart the runtime',
          );
        }
        await reconnect();
        return { reconnecting: true };
      case 'send': {
        const quote = command.quote;
        return perform(
          store,
          command.key,
          {
            kind: 'send',
            jid: command.jid,
            text: command.text,
            ...(quote ? { quote } : {}),
          },
          () => validateTarget(command.jid, true),
          async (messageId, destination, record) => {
            if (!messageId) throw new Error('Missing persisted message ID');
            return connected().sendMessage(
              destination,
              { text: command.text, linkPreview: null },
              {
                messageId,
                ...(record.quote
                  ? { quoted: quotedMessage(record.quote) }
                  : {}),
              },
            );
          },
          quote
            ? {
                ...sendPreparation,
                quote: () =>
                  prepareQuote(
                    store,
                    command.jid,
                    quote,
                    auth.state.creds.me?.id,
                  ),
              }
            : sendPreparation,
        );
      }
      case 'send-contact': {
        const card = contactCard(command.name, command.phone);
        return perform(
          store,
          command.key,
          {
            kind: 'send-contact',
            jid: command.jid,
            name: command.name,
            phone: command.phone,
            vcard: card.vcard,
          },
          () => validateTarget(command.jid, true),
          async (messageId, destination) => {
            if (!messageId) throw new Error('Missing persisted message ID');
            return connected().sendMessage(
              destination,
              { contacts: { displayName: card.displayName, contacts: [card] } },
              { messageId },
            );
          },
          sendPreparation,
        );
      }
      case 'send-file': {
        const previous = store.request(command.key);
        if (previous) {
          const op = previous.operation;
          if (
            op.kind !== 'send-file' ||
            op.jid !== command.jid ||
            op.path !== command.path ||
            op.mime !== command.mime ||
            op.caption !== command.caption
          )
            throw new CommandError(
              'KEY_CONFLICT',
              'Idempotency key already used with different arguments',
            );
          const context = execution.getStore();
          if (context) context.replay = true;
          return previous;
        }
        const preparing = sendPreparation.pending.get(command.key);
        if (preparing) {
          await preparing;
          return execute(command);
        }
        validateTarget(command.jid, true);
        const { buffer, bytes, sha256 } = await prepareFile(command.path);
        return perform(
          store,
          command.key,
          {
            kind: 'send-file',
            jid: command.jid,
            path: command.path,
            mime: command.mime,
            caption: command.caption,
            bytes,
            sha256,
          },
          () => validateTarget(command.jid, true),
          async (messageId, destination) => {
            if (!messageId) throw new Error('Missing persisted message ID');
            return connected().sendMessage(
              destination,
              {
                document: buffer,
                mimetype: command.mime,
                fileName: basename(command.path),
                caption: command.caption,
              },
              { messageId },
            );
          },
          sendPreparation,
        );
      }
      case 'download': {
        if (!options.connect)
          throw new CommandError(
            'PRECONDITION_FAILED',
            'Media download requires network access; restart without --offline',
          );
        const message = store.locateMessage({
          ...command,
          id: command.messageId,
        });
        const media = assertMediaContent(
          normalizeMessageContent(message.message),
        );
        if (toNumber(media.fileLength ?? 0) > MAX_FILE_BYTES)
          throw new CommandError(
            'PRECONDITION_FAILED',
            'Media exceeds the 64 MiB limit',
          );
        return saveMedia(command.path, () =>
          downloadMediaMessage(
            message,
            'stream',
            {},
            {
              logger,
              reuploadRequest: (item) => connected().updateMediaMessage(item),
            },
          ),
        );
      }
      case 'archive':
      case 'mark-read': {
        const guard = command.ifLatestIncoming;
        const operation = {
          kind: command.command,
          jid: command.jid,
          value: command.value,
          ...(guard === undefined ? {} : { ifLatestIncoming: guard }),
        };
        const request = await perform(
          store,
          command.key,
          operation,
          // Runs for a new key only, synchronously before the intent is persisted
          // and the patch is built: nothing can be stored between check and use.
          () => {
            validateTarget(command.jid);
            if (guard !== undefined) {
              const latestIncoming = store.latestIncoming(command.jid);
              const newer = (latestIncoming?.id ?? null) !== guard;
              // Content still pending anywhere in the chat could be a reply the
              // caller has not read, even before the one it names.
              const unavailable = store.unavailableIncoming(command.jid);
              if (newer || unavailable.messages.length > 0) {
                const listed = store.newerIncoming(command.jid, guard);
                throw new CommandError(
                  'PRECONDITION_FAILED',
                  newer
                    ? 'Incoming messages were stored after the one this command names; nothing was changed. Read them with incoming --after before deciding again'
                    : 'An incoming message in this chat has no readable content yet; nothing was changed. Decide once it is available',
                  {
                    details: {
                      precondition: 'if-latest-incoming',
                      reason: newer ? 'newer-incoming' : 'unavailable-incoming',
                      expected: guard,
                      expectedStored: listed.expectedStored,
                      latestIncoming,
                      newerIncoming: listed.messages,
                      truncated: listed.truncated,
                      unavailableIncoming: unavailable.messages,
                      unavailableTruncated: unavailable.truncated,
                      coverage: 'local',
                    },
                  },
                );
              }
            }
            const last = store.chatMutationMessages(command.jid)[0];
            if (!last || toNumber(last.messageTimestamp ?? 0) === 0)
              throw new CommandError(
                'PRECONDITION_FAILED',
                'A stored last message with timestamp is required',
              );
          },
          async () => {
            const lastMessages = store
              .chatMutationMessages(command.jid)
              .map(({ key, messageTimestamp }) => ({
                key,
                messageTimestamp: toNumber(messageTimestamp ?? 0),
              }));
            const patch =
              command.command === 'archive'
                ? { archive: command.value, lastMessages }
                : { markRead: command.value, lastMessages };
            await connected().chatModify(patch, command.jid, {
              requestId: command.key,
            });
          },
          sendPreparation,
        );
        const localChat = store.chatView(command.jid);
        const field = command.command === 'archive' ? 'archived' : 'unread';
        const pending = localChat?.pending[field];
        const guardFeedback = () => {
          if (guard === undefined) return {};
          if ((localChat?.latestIncoming?.id ?? null) === guard)
            return { latestIncomingChanged: false };
          const listed = store.newerIncoming(command.jid, guard);
          return {
            latestIncomingChanged: true,
            newerIncoming: listed.messages,
            truncated: listed.truncated,
          };
        };
        return {
          request,
          feedback: {
            // The SDK may resync over the network before sending the patch built
            // at the check; report a reply stored since, without claiming its effect.
            ...guardFeedback(),
            serverResponse: request.appStateResponse?.status ?? 'unknown',
            stateObservation: pending
              ? pending.key === request.key
                ? 'pending'
                : 'superseded'
              : typeof localChat?.[field] === 'boolean'
                ? 'available'
                : 'unknown',
          },
          note: 'A server response and local SDK echo do not confirm phone application. Pending refers to a conversation-state observation; do not repeat an uncertain operation.',
          localChat,
        };
      }
      case 'stop':
        return { stopping: true };
    }
  }
  function observeMessageKey(
    key: {
      id?: string | null;
      remoteJid?: string | null;
      fromMe?: boolean | null;
      participant?: string | null;
    },
    status?: number | null,
  ): void {
    if (!observability.enabled) return;
    const message = key.id
      ? observability.opaque('message', key.id)
      : undefined;
    const destination = key.remoteJid
      ? observability.opaque('resource', key.remoteJid)
      : undefined;
    const participant = key.participant
      ? observability.opaque('resource', key.participant)
      : undefined;
    observability.record('diagnostic', {
      label: 'receipt',
      ...(message ? { message } : {}),
      ...(destination ? { destination } : {}),
      ...(participant ? { participant } : {}),
      ...(typeof key.fromMe === 'boolean' ? { fromMe: key.fromMe } : {}),
      // rc14 status is evidence only; participant receipt events remain separate and unclassified.
      ...(status === 2 ? { acceptance: 'server-ack' as const } : {}),
      ...(status === 3 ? { delivery: 'delivered' as const } : {}),
      ...(status === 4 ? { read: 'read' as const } : {}),
      ...(status === 0 ? { errorObserved: true } : {}),
    });
  }
  function fatal(): never {
    observability.record('diagnostic', {
      label: 'fatal',
      code: 'LOCAL_STATE',
      build: buildFingerprint,
    });
    writeDiagnostic({ error: 'Fatal persistence failure' });
    // Do not keep operating with failed credential/event persistence.
    process.exit(1);
  }
  function reconnect(manual = true): Promise<void> {
    if (replacing) return replacing;
    cancelRecoveryTimers();
    const previous = socket;
    const previousClosed = socketClosed;
    socket = undefined;
    socketClosed = undefined;
    owner = undefined;
    qr = undefined;
    receivedPendingNotifications = false;
    connection = 'connecting';
    settleAckWaits();
    if (manual) {
      attempts = 0;
      enterRecovery({
        state: 'connecting',
        reason: 'manual-reconnect',
        code: null,
        attempt: 0,
        nextRetryAt: null,
      });
      interrupt('manual-reconnect');
    }
    replacing = (async () => {
      try {
        // end() removes transport listeners synchronously, so subscribe after invoking it.
        const sdkEnd = previous?.end(new Error('Reconnect requested'));
        await Promise.all([
          sdkEnd,
          previousClosed,
          previous && transportClosed(previous.ws),
        ]);
      } catch {
        socket = previous; // Retain the handle for shutdown, but never authorize another connection.
        socketClosed = previousClosed;
        if (!stopped) intervention('socket-end-failed', null);
        throw new Error(
          'Socket cleanup failed; investigate and restart the runtime',
        );
      }
      if (!stopped) open();
    })().finally(() => {
      replacing = undefined;
    });
    return replacing;
  }
  function shutdown(): Promise<void> {
    if (ending) return ending;
    stopped = true;
    processObservation.stop();
    cancelRecoveryTimers();
    enterRecovery({
      state: 'stopping',
      reason: null,
      code: null,
      attempt: 0,
      nextRetryAt: null,
    });
    qr = undefined;
    receivedPendingNotifications = false;
    if (started && options.connect) interrupt('runtime-stop');
    settleAckWaits();
    const current = socket;
    const currentClosed = socketClosed;
    socket = undefined;
    socketClosed = undefined;
    owner = undefined;
    ending = (async () => {
      const sdkEnd = current?.end(new Error('Runtime stopped'));
      await Promise.all([
        sdkEnd,
        currentClosed,
        current && transportClosed(current.ws),
      ]);
      await replacing;
    })();
    return ending;
  }
  return {
    directory: store.directory,
    build: buildFingerprint,
    observability,
    execute(command: Command, context: ObsFields = {}) {
      processObservation.reconcile();
      if (command.command === 'observability') return execute(command);
      const state = { invoked: false, replay: false };
      const started = performance.now();
      const fields = commandFields(observability, command);
      return execution.run(state, async () => {
        let result: unknown;
        let code = 'OK';
        const sending =
          command.command === 'send' ||
          command.command === 'send-file' ||
          command.command === 'send-contact';
        try {
          result = await execute(command);
          // A concurrent same-key call may already be waiting on this record.
          // perform() commits its final state outside persist(), so wake waiters here.
          if (sending) settleAckWaits();
          if (sending && command.waitAckMs && result)
            result =
              (await waitForAck(command.key, command.waitAckMs)) ?? result;
          return result;
        } catch (error) {
          code = errorResponse(error).code;
          if (sending) settleAckWaits();
          throw error;
        } finally {
          observability.record('execution', {
            ...fields,
            ...context,
            ...resultFields(result, observability),
            ...('key' in command && command.command !== 'request' ? state : {}),
            durationMs: performance.now() - started,
            code,
            ok: code === 'OK',
            connection,
            recovery: recovery.state,
            build: buildFingerprint,
            coverage: 'partial',
            appState: 'unknown',
          });
        }
      });
    },
    start() {
      if (started || stopped) return;
      started = true;
      observability.record('lifecycle', {
        label: 'startup',
        build: buildFingerprint,
        connection,
        recovery: recovery.state,
      });
      if (options.connect) {
        interrupt('runtime-start');
        enterRecovery({
          state: 'connecting',
          reason: 'startup',
          code: null,
          attempt: 0,
          nextRetryAt: null,
        });
        open();
      }
    },
    snapshot() {
      return {
        connection,
        recovery: { ...recovery },
        receiveContinuity: {
          status: 'unproven' as const,
          lastInterruption: lastInterruption && { ...lastInterruption },
        },
        source: 'local' as const,
        coverage: 'partial' as const,
        appState: 'unknown' as const,
        receivedPendingNotifications,
        issues: [...issues],
        activeIssues: [...issues].filter(issueActive).map(issueDetail),
      };
    },
    /**
     * Refuse a request meant for another account before any read, persist or
     * SDK call. Compares only the PN user part of the linked account's own JID.
     */
    checkAccount(expected: string): void {
      if (!hasLinkedCredentials(auth.state.creds))
        throw new CommandError(
          'ACCOUNT_MISMATCH',
          'No WhatsApp account is linked in this data directory; nothing was done',
        );
      if (accountUser(auth.state.creds.me?.id) !== expected)
        throw new CommandError(
          'ACCOUNT_MISMATCH',
          'The linked WhatsApp account is not the expected account; nothing was done',
        );
    },
    stop: shutdown,
    close() {
      closing ??= (async () => {
        await shutdown();
        // SQLite's native backup is asynchronous and still owns the source handle.
        // A disconnected/timed-out client never cancels it or releases ownership early.
        await backupWork?.catch(() => {});
        auth.save({});
        observability.record('lifecycle', {
          label: 'shutdown',
          build: buildFingerprint,
          connection,
          recovery: recovery.state,
        });
        await observability.close();
        store.close();
      })();
      return closing;
    },
  };
}

type IssueRecord = { count: number; firstAt: number | null; lastAt: number };

/** Malformed or unfamiliar entries are treated as untimed history rather than guessed. */
function readIssueLog(value: unknown): Map<string, IssueRecord> {
  const log = new Map<string, IssueRecord>();
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return log;
  const time = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  for (const [code, entry] of Object.entries(value)) {
    if (entry === null || typeof entry !== 'object') continue;
    const { count, firstAt, lastAt } = entry as Record<string, unknown>;
    if (
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count > 0 &&
      time(lastAt) &&
      (firstAt === null || (time(firstAt) && firstAt <= lastAt))
    )
      log.set(code, { count, firstAt, lastAt });
  }
  return log;
}

function transportClosed(ws: WASocket['ws']): Promise<void> {
  if (ws.isClosed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    ws.once('close', resolve);
  });
}

function disconnectCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('output' in error))
    return undefined;
  const output = object(error.output);
  return typeof output.statusCode === 'number' &&
    Number.isSafeInteger(output.statusCode)
    ? output.statusCode
    : undefined;
}
