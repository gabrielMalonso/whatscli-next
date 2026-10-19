import type { WAMessage } from 'baileys';
import { chatOutput, messageOutput } from '../../src/output.js';
import type { Store, RequestRecord } from '../../src/store.js';

export const pn = '12025550101@s.whatsapp.net';
export const lid = '123450001@lid';
const otherPn = '12025550102@s.whatsapp.net';
const group = '120363000000000001@g.us';
const observedAt = 1700000000000;

export function publicResponse(data: unknown): Record<string, unknown> {
  return { id: '11111111-2222-4333-8444-555555555555', ok: true, data, running: true, pid: 12345,
    connection: 'offline', source: 'local', coverage: 'partial', appState: 'unknown', receivedPendingNotifications: false, issues: [] };
}

function message(id: string, text: string, jid = pn): WAMessage {
  return { key: { remoteJid: jid, id, fromMe: false, ...(jid === group ? { participant: lid } : {}) },
    messageTimestamp: 1700000000, message: { conversation: text,
      messageContextInfo: { messageSecret: Buffer.from('FICTIONAL_SECRET_EXCLUDED') } } };
}

const reply: WAMessage = { ...message('reply-1', ''), message: { extendedTextMessage: {
  text: 'Entendido. Vou conferir o horário e responder amanhã.',
  contextInfo: { stanzaId: 'quoted-1', participant: pn,
    quotedMessage: { conversation: 'Podemos combinar na sexta, às 14h?' } },
} } };
const card: WAMessage = { ...message('card-1', ''), message: { contactMessage: {
  displayName: 'Contato compartilhado', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Example Contact\nTEL:+12025550103\nEND:VCARD',
} } };
const deleted = message('deleted-1', 'FICTIONAL_DELETED_BODY_EXCLUDED');

export const history = [
  messageOutput(message('text-1', 'Olá, "Ana"! 👋\nJá recebi o documento. Obrigado.')),
  messageOutput(reply), messageOutput(card),
  messageOutput(deleted, { deletion: { status: 'deleted', source: 'messages.delete', observedAt } }),
  messageOutput(message('boundary-1', 'FICTIONAL_BOUNDARY_BODY_EXCLUDED'), {
    deletion: { status: 'unknown', source: 'chat-delete-boundary', observedAt },
  }),
];

const chats = [
  { ...chatOutput({ id: pn, name: 'Example contact', archived: false, unreadCount: 0 }), pending: {}, observedAt,
    activity: { timestamp: 1700000000, source: 'message.messageTimestamp' } },
  { ...chatOutput({ id: lid, archived: true, unreadCount: -1 }), pending: {}, observedAt,
    activity: { timestamp: 1699999900, source: 'chat.conversationTimestamp' } },
  { ...chatOutput({ id: otherPn, unreadCount: 2 }), archived: null, unread: null, unreadCount: null,
    pending: { archived: { key: 'archive-1', value: true }, unread: { key: 'read-1', value: false } }, observedAt,
    activity: { timestamp: 1699999800, source: 'message.messageTimestamp' } },
  { ...chatOutput({ id: group }), pending: {}, observedAt, activity: { timestamp: null, source: null } },
] satisfies NonNullable<ReturnType<Store['chatView']>>[];

export const conflict = {
  jid: lid, source: 'local', historical: true, phone: null,
  mapping: { status: 'conflict', pn: null, lid, evidence: [
    { pn, lid, source: 'contacts.upsert', observedAt },
    { pn: otherPn, lid, source: 'lid-mapping.update', observedAt: null },
  ] },
  verification: { status: 'unknown', source: null, observedAt: null },
  contacts: [{ jid: lid, source: 'contacts.upsert', observedAt, metadata: {
    name: { value: 'Example contact', source: 'contacts.upsert', observedAt },
    notify: { value: 'Example', source: 'contacts.upsert', observedAt },
    status: { value: 'Disponível', source: 'contacts.update', observedAt: observedAt - 1000 },
  } }],
} satisfies ReturnType<Store['contactView']>;

export const uncertain: RequestRecord = {
  key: 'example-message-001', operation: { kind: 'send', jid: pn, text: 'Confirmo o recebimento. Obrigado!' },
  messageId: 'EXAMPLE_MESSAGE_ID_001', attempt: 'uncertain', acceptance: 'unknown', delivery: 'unknown', read: 'unknown', errorObserved: true,
};

export const responseFixtures: { name: string; action: string; response: Record<string, unknown>; jid?: string }[] = [
  { name: 'chats-states-pending', action: 'chats', response: publicResponse(chats) },
  { name: 'history-quotes-cards-deletions', action: 'messages', jid: pn, response: publicResponse(history) },
  { name: 'search-exact-jids', action: 'search', response: publicResponse([
    messageOutput(message('same-id', 'Confirmo a reunião amanhã.', pn)),
    messageOutput(message('same-id', 'A reunião está confirmada.', lid)),
    messageOutput(message('same-id', 'Qual o horário da reunião?', group)),
  ]) },
  { name: 'contact-conflict', action: 'contact', response: publicResponse(conflict) },
  { name: 'request-uncertain', action: 'request', response: publicResponse(uncertain) },
];
