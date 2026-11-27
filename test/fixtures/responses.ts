import type { WAMessage } from 'baileys';
import { chatOutput, messageOutput } from '../../src/output.js';
import type { Store, RequestRecord } from '../../src/store.js';

export const pn = '12025550101@s.whatsapp.net';
export const lid = '123450001@lid';
const otherPn = '12025550102@s.whatsapp.net';
const group = '120363000000000001@g.us';
const observedAt = 1700000000000;

export function publicResponse(data: unknown): Record<string, unknown> {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    ok: true,
    data,
    running: true,
    pid: 12345,
    connection: 'offline',
    recovery: {
      state: 'offline',
      reason: null,
      code: null,
      attempt: 0,
      nextRetryAt: null,
      since: 1700000000000,
    },
    receiveContinuity: { status: 'unproven', lastInterruption: null },
    source: 'local',
    coverage: 'partial',
    appState: 'unknown',
    receivedPendingNotifications: false,
    issues: [],
    activeIssues: [],
  };
}

/** A connected runtime that recorded two issues in earlier processes; none is active now. */
export function liveResponse(data: unknown): Record<string, unknown> {
  return {
    ...publicResponse(data),
    connection: 'open',
    recovery: {
      state: 'open',
      reason: null,
      code: null,
      attempt: 0,
      nextRetryAt: null,
      since: observedAt + 5000,
    },
    receiveContinuity: {
      status: 'unproven',
      lastInterruption: { at: observedAt, reason: 'runtime-start' },
    },
    receivedPendingNotifications: true,
    issues: [
      'decryption-or-integrity-failure',
      'connection-stopped-review-required',
    ],
    activeIssues: [],
  };
}

export const issueHistory = [
  {
    code: 'decryption-or-integrity-failure',
    count: 14,
    firstAt: observedAt - 86400000,
    lastAt: observedAt - 3600000,
    active: false,
  },
  {
    code: 'connection-stopped-review-required',
    count: null,
    firstAt: null,
    lastAt: null,
    active: false,
  },
];

export const observability = {
  configured: true,
  enabled: true,
  effective: true,
  degraded: false,
  dropped: 0,
  uncertain: 0,
  cleanupFailures: 0,
  hashingFailures: 0,
  components: {
    captureDegraded: false,
    cleanupDegraded: false,
    hashingDegraded: false,
    retentionDegraded: false,
  },
  session: '0123456789abcdef0123456789abcdef',
  generation: 3,
  evicted: 0,
  expired: 12,
  limits: {
    days: 5,
    bytes: 8388608,
    files: 32,
    segments: 31,
    segment: 262144,
    line: 4096,
    sampleMs: 60000,
  },
  directory: '/home/example/.local/share/whatscli-next/observability',
  scope: 'process-counters',
  captureCompleteness: 'unknown',
  buffer: {
    admitted: 1520,
    captured: 1518,
    deferred: 2,
    invalidated: 0,
    expired: 0,
    overflow: 0,
    schedulerDiscarded: 0,
    lockAttempts: 1522,
    busyAttempts: 2,
    preparationFailures: 0,
    maxPending: 3,
    maxBytes: 1210,
    pending: 0,
    bytes: 0,
    closed: false,
    limits: { records: 16, bytes: 65536, retryMs: 25 },
  },
  samplerActive: true,
  retentionActive: false,
  preferenceWatchDegraded: false,
};

export const status = {
  build: {
    fingerprint:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  },
  observability,
  hasLinkedCredentials: true,
  registered: true,
  accountJid: '12025550199:1@s.whatsapp.net',
  accountLid: '123450099:1@lid',
  allowedJid: null,
  networkEnabled: true,
  qrAvailable: false,
  issueHistory,
};

function message(id: string, text: string, jid = pn): WAMessage {
  return {
    key: {
      remoteJid: jid,
      id,
      fromMe: false,
      ...(jid === group ? { participant: lid } : {}),
    },
    messageTimestamp: 1700000000,
    message: {
      conversation: text,
      messageContextInfo: {
        messageSecret: Buffer.from('FICTIONAL_SECRET_EXCLUDED'),
      },
    },
  };
}

const reply: WAMessage = {
  ...message('reply-1', ''),
  message: {
    extendedTextMessage: {
      text: 'Entendido. Vou conferir o horário e responder amanhã.',
      contextInfo: {
        stanzaId: 'quoted-1',
        participant: pn,
        quotedMessage: { conversation: 'Podemos combinar na sexta, às 14h?' },
      },
    },
  },
};
const card: WAMessage = {
  ...message('card-1', ''),
  message: {
    contactMessage: {
      displayName: 'Contato compartilhado',
      vcard:
        'BEGIN:VCARD\nVERSION:3.0\nFN:Example Contact\nTEL:+12025550103\nEND:VCARD',
    },
  },
};
const deleted = message('deleted-1', 'FICTIONAL_DELETED_BODY_EXCLUDED');

export const history = [
  messageOutput(
    message('text-1', 'Olá, "Ana"! 👋\nJá recebi o documento. Obrigado.'),
  ),
  messageOutput(reply),
  messageOutput(card),
  messageOutput(deleted, {
    deletion: { status: 'deleted', source: 'messages.delete', observedAt },
  }),
  messageOutput(message('boundary-1', 'FICTIONAL_BOUNDARY_BODY_EXCLUDED'), {
    deletion: { status: 'unknown', source: 'chat-delete-boundary', observedAt },
  }),
];

const chats = [
  {
    ...chatOutput({
      id: pn,
      name: 'Example contact',
      archived: false,
      unreadCount: 0,
    }),
    pending: {},
    observedAt,
    activity: { timestamp: 1700000000, source: 'message.messageTimestamp' },
  },
  {
    ...chatOutput({ id: lid, archived: true, unreadCount: -1 }),
    pending: {},
    observedAt,
    activity: { timestamp: 1699999900, source: 'chat.conversationTimestamp' },
  },
  {
    ...chatOutput({ id: otherPn, unreadCount: 2 }),
    archived: null,
    unread: null,
    unreadCount: null,
    pending: {
      archived: { key: 'archive-1', value: true },
      unread: { key: 'read-1', value: false },
    },
    observedAt,
    activity: { timestamp: 1699999800, source: 'message.messageTimestamp' },
  },
  {
    ...chatOutput({ id: group }),
    pending: {},
    observedAt,
    activity: { timestamp: null, source: null },
  },
] satisfies NonNullable<ReturnType<Store['chatView']>>[];

export const conflict = {
  jid: lid,
  source: 'local',
  historical: true,
  phone: null,
  mapping: {
    status: 'conflict',
    pn: null,
    lid,
    evidence: [
      { pn, lid, source: 'contacts.upsert', observedAt },
      { pn: otherPn, lid, source: 'lid-mapping.update', observedAt: null },
    ],
  },
  verification: { status: 'unknown', source: null, observedAt: null },
  contacts: [
    {
      jid: lid,
      source: 'contacts.upsert',
      observedAt,
      metadata: {
        name: {
          value: 'Example contact',
          source: 'contacts.upsert',
          observedAt,
        },
        notify: { value: 'Example', source: 'contacts.upsert', observedAt },
        status: {
          value: 'Disponível',
          source: 'contacts.update',
          observedAt: observedAt - 1000,
        },
      },
    },
  ],
} satisfies ReturnType<Store['contactView']>;

export const uncertain: RequestRecord = {
  key: 'example-message-001',
  operation: {
    kind: 'send',
    jid: pn,
    text: 'Confirmo o recebimento. Obrigado!',
  },
  messageId: 'EXAMPLE_MESSAGE_ID_001',
  attempt: 'uncertain',
  acceptance: 'unknown',
  delivery: 'unknown',
  read: 'unknown',
  errorObserved: true,
};

export const responseFixtures: {
  name: string;
  action: string;
  response: Record<string, unknown>;
}[] = [
  {
    name: 'chats-states-pending',
    action: 'chats',
    response: publicResponse(chats),
  },
  {
    name: 'history-quotes-cards-deletions',
    action: 'messages',
    response: publicResponse(history),
  },
  {
    name: 'search-exact-jids',
    action: 'search',
    response: publicResponse([
      messageOutput(message('same-id', 'Confirmo a reunião amanhã.', pn)),
      messageOutput(message('same-id', 'A reunião está confirmada.', lid)),
      messageOutput(message('same-id', 'Qual o horário da reunião?', group)),
    ]),
  },
  {
    name: 'contact-conflict',
    action: 'contact',
    response: publicResponse(conflict),
  },
  {
    name: 'request-uncertain',
    action: 'request',
    response: publicResponse(uncertain),
  },
  {
    name: 'status-connected-historical-issues',
    action: 'status',
    response: liveResponse(status),
  },
  {
    name: 'messages-empty-connected',
    action: 'messages',
    response: liveResponse([]),
  },
  {
    name: 'request-null-connected',
    action: 'request',
    response: liveResponse(null),
  },
  {
    name: 'history-connected',
    action: 'messages',
    response: liveResponse(history),
  },
];
