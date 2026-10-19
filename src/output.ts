import { getContentType, normalizeMessageContent, toNumber } from 'baileys';
import type { ChatUpdate, WAMessage } from 'baileys';

/** SDK messages also contain sender keys and message secrets; expose an explicit projection. */
export function messageOutput(message: WAMessage) {
  const content = normalizeMessageContent(message.message);
  const media = content?.documentMessage ?? content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage ?? content?.stickerMessage;
  return {
    jid: message.key.remoteJid ?? null,
    id: message.key.id ?? null,
    fromMe: message.key.fromMe ?? null,
    participant: message.key.participant ?? null,
    timestamp: message.messageTimestamp == null ? null : toNumber(message.messageTimestamp),
    text: content?.conversation ?? content?.extendedTextMessage?.text
      ?? content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? content?.documentMessage?.caption ?? null,
    contentType: getContentType(content) ?? null,
    stubType: message.messageStubType ?? null,
    status: message.status ?? null,
    media: media ? {
      mimetype: media.mimetype ?? null,
      fileName: 'fileName' in media ? media.fileName ?? null : null,
      bytes: media.fileLength == null ? null : toNumber(media.fileLength),
    } : null,
  };
}

/** Chat history may embed full SDK messages; list only the fields the agent can use. */
export function chatOutput(chat: ChatUpdate) {
  const count = chat.unreadCount;
  return {
    jid: chat.id ?? null,
    name: chat.name ?? null,
    archived: chat.archived ?? null,
    unread: chat.markedAsUnread === true ? true : typeof count === 'number' ? count !== 0 : chat.markedAsUnread ?? null,
    // Positive SDK updates can be increments rather than complete counts.
    unreadCount: typeof count === 'number' && count > 0 ? null : count ?? null,
  };
}
