import {
  decryptMessageEdit,
  isEncryptedMessageEdit,
  normalizeMessageContent,
  proto,
  toNumber,
} from 'baileys';
import type { WAMessage } from 'baileys';

export function isMessageEdit(message: proto.IWebMessageInfo): boolean {
  const content = normalizeMessageContent(message.message);
  return (
    content?.protocolMessage?.type ===
      proto.Message.ProtocolMessage.Type.MESSAGE_EDIT ||
    isEncryptedMessageEdit(content)
  );
}

export function messageEditTarget(message: WAMessage) {
  const content = normalizeMessageContent(message.message);
  return isEncryptedMessageEdit(content)
    ? content.secretEncryptedMessage.targetMessageKey
    : content?.protocolMessage?.key;
}

/** Only the private projection uses originals; SDK retry/resend lookups stay unchanged. */
export function decodeMessageEdit(
  envelope: WAMessage,
  original: WAMessage,
  authors: string[],
): proto.Message.IProtocolMessage | undefined {
  const content = normalizeMessageContent(envelope.message);
  if (!isEncryptedMessageEdit(content))
    return content?.protocolMessage ?? undefined;
  const secret =
    original.message?.messageContextInfo?.messageSecret ??
    normalizeMessageContent(original.message)?.messageContextInfo
      ?.messageSecret;
  if (!secret) return undefined;
  const originalMsgId = original.key.id;
  if (!originalMsgId) return undefined;
  for (const originalSenderJid of authors)
    for (const editorJid of authors) {
      try {
        const decoded = decryptMessageEdit(content.secretEncryptedMessage, {
          originalSenderJid,
          originalMsgId,
          messageSecret: secret,
          editorJid,
        });
        const protocol = decoded.protocolMessage;
        if (
          protocol?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
          protocol.key?.id === original.key.id &&
          protocol.editedMessage
        )
          return protocol;
      } catch {
        // Authentication failure is unavailable content, never diagnostic key material.
      }
    }
  return undefined;
}

export function messageEditTimestamp(
  protocol: proto.Message.IProtocolMessage,
  envelope: WAMessage,
): number | null {
  const value =
    protocol.timestampMs == null
      ? toNumber(envelope.messageTimestamp ?? 0) * 1000
      : toNumber(
          proto.Message.ProtocolMessage.fromObject(protocol).timestampMs ?? 0,
        );
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function retainMessageSecret(
  content: proto.IMessage,
  previous: proto.IMessage | null | undefined,
): proto.IMessage {
  const secret =
    previous?.messageContextInfo?.messageSecret ??
    normalizeMessageContent(previous)?.messageContextInfo?.messageSecret;
  return secret
    ? {
        ...content,
        messageContextInfo: {
          ...content.messageContextInfo,
          messageSecret: secret,
        },
      }
    : content;
}
