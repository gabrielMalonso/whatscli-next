import { getContentType, normalizeMessageContent, toNumber } from 'baileys';
import type { ChatUpdate, WAMessage, proto } from 'baileys';

export type Deletion = {
  status: 'deleted' | 'unknown';
  source: 'messages.delete' | 'revoke' | 'chat-delete-boundary' | null;
  observedAt: number | null;
};
export type QuoteReference = { jid: string | null; id: string | null; participant: string | null };

/** Current top-level text/caption only; quotes, cards and SDK context are excluded. */
export function messageText(content: proto.IMessage | undefined) {
  return content?.conversation ?? content?.extendedTextMessage?.text
    ?? content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? content?.documentMessage?.caption ?? null;
}

/** Parse only shared display fields. vCard parameters (including waid) confer no identity authority. */
function contactCard(card: proto.Message.IContactMessage) {
  const phones: string[] = [];
  let name: string | null = null;
  let malformed = false;
  const lines = card.vcard?.replace(/\r\n[ \t]|\n[ \t]/g, '').trim().split(/\r?\n/) ?? [];
  const unescape = (value: string) => value.replace(/\\([nN,;\\])/g, (_escape, character: string) => /[nN]/.test(character) ? '\n' : character);
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) { malformed = true; continue; }
    const header = line.slice(0, colon);
    const property = header.split(';')[0]?.split('.').at(-1)?.toUpperCase();
    if ((property === 'FN' || property === 'TEL') && /;ENCODING=/i.test(header)) { malformed = true; continue; }
    const value = unescape(line.slice(colon + 1));
    if (property === 'FN' && value) name = value;
    if (property === 'TEL') {
      const phone = value.replace(/^tel:/i, '');
      // Preserve the shared spelling; do not derive a PN JID or normalize local numbers.
      if (/^\+?[\d ().-]+(?:;ext=\d+)?$/.test(phone) && /\d/.test(phone)) phones.push(phone);
      else malformed = true;
    }
  }
  const framed = lines[0]?.toUpperCase() === 'BEGIN:VCARD' && lines.at(-1)?.toUpperCase() === 'END:VCARD';
  return {
    displayName: card.displayName ?? null, name, phones: [...new Set(phones)],
    state: !card.vcard ? 'missing' : !framed || malformed ? 'malformed' : !name || !phones.length ? 'incomplete' : 'available',
  };
}

function contactsOutput(content: proto.IMessage | undefined) {
  if (content?.contactMessage) return { source: 'shared-content', cards: [contactCard(content.contactMessage)], state: 'available' };
  if (content?.contactsArrayMessage) {
    const cards = content.contactsArrayMessage.contacts ?? [];
    return { source: 'shared-content', cards: cards.map(contactCard), state: cards.length ? 'available' : 'missing' };
  }
  return null;
}

function quoteOutput(content: proto.IMessage | undefined, jid: string | null, visibility?: (ref: QuoteReference) => 'deleted' | 'unknown' | undefined) {
  // Inspect the typed context field only, never recurse through SDK objects or nested quotes.
  const context = Object.values(content ?? {}).find((value): value is { contextInfo: proto.IContextInfo } =>
    typeof value === 'object' && value !== null && 'contextInfo' in value && value.contextInfo != null)?.contextInfo;
  if (!context || (!context.stanzaId && !context.quotedMessage && !context.participant && !context.remoteJid)) return null;
  const reference: QuoteReference = { jid: context.remoteJid ?? jid, id: context.stanzaId ?? null, participant: context.participant ?? null };
  const hidden = visibility?.(reference);
  const quoted = hidden ? undefined : normalizeMessageContent(context.quotedMessage);
  return {
    reference: { ...reference, fromMe: null },
    source: context.quotedMessage ? 'embedded' : null,
    state: hidden ?? (getContentType(quoted) ? 'available' : 'unknown'),
    text: messageText(quoted), contentType: getContentType(quoted) ?? null,
  };
}

/** SDK messages also contain sender keys and message secrets; expose an explicit projection. */
export function messageOutput(message: WAMessage, options: {
  deletion?: Deletion;
  quoteVisibility?: (ref: QuoteReference) => 'deleted' | 'unknown' | undefined;
} = {}) {
  const deletion = options.deletion ?? { status: 'unknown', source: null, observedAt: null };
  const content = deletion.source ? undefined : normalizeMessageContent(message.message);
  const media = content?.documentMessage ?? content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage ?? content?.stickerMessage;
  return {
    jid: message.key.remoteJid ?? null,
    id: message.key.id ?? null,
    fromMe: message.key.fromMe ?? null,
    participant: message.key.participant ?? null,
    timestamp: message.messageTimestamp == null ? null : toNumber(message.messageTimestamp),
    deletion,
    text: messageText(content),
    contentType: getContentType(content) ?? null,
    stubType: message.messageStubType ?? null,
    status: message.status ?? null,
    quote: quoteOutput(content, message.key.remoteJid ?? null, options.quoteVisibility),
    contacts: contactsOutput(content),
    media: media ? {
      mimetype: media.mimetype ?? null,
      fileName: 'fileName' in media ? media.fileName ?? null : null,
      bytes: media.fileLength == null ? null : toNumber(media.fileLength),
    } : null,
  };
}

export function isUnreadCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1;
}

/** Chat history may embed full SDK messages; list only the fields the agent can use. */
export function chatOutput(chat: ChatUpdate) {
  const count = isUnreadCount(chat.unreadCount) ? chat.unreadCount : null;
  return {
    jid: chat.id ?? null,
    name: chat.name ?? null,
    archived: typeof chat.archived === 'boolean' ? chat.archived : null,
    unread: chat.markedAsUnread === true ? true : count !== null ? count !== 0 : null,
    // Positive SDK updates can be increments rather than complete counts.
    unreadCount: count !== null && count > 0 ? null : count,
  };
}
