import { BufferJSON, normalizeMessageContent, proto } from 'baileys';
import type { WAMessage } from 'baileys';

export const encode = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
// SQLite contains objects written by this process using the SDK's binary serializer.
export const decode = <T>(value: string): T => JSON.parse(value, BufferJSON.reviver) as T;

/** Protobuf toJSON writes enum names. Restore the enum values without dropping extended SDK keys. */
export function decodeMessage(value: string): WAMessage {
  const message = decode<WAMessage>(value);
  const enums = proto.WebMessageInfo.fromObject({ messageStubType: message.messageStubType, status: message.status });
  if (message.messageStubType != null) message.messageStubType = enums.messageStubType ?? null;
  if (message.status != null) message.status = enums.status ?? null;
  const protocol = normalizeMessageContent(message.message)?.protocolMessage;
  if (protocol?.type != null) protocol.type = proto.Message.ProtocolMessage.fromObject(protocol).type ?? null;
  return message;
}
