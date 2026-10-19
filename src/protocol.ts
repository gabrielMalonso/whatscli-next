import { contactJid, internationalPhone, recipientJid } from './identity.js';
import { contactName } from './contact-card.js';

export type ChatStateFilter = boolean | 'unknown';
export type ChatFilters = { unread?: ChatStateFilter; archived?: ChatStateFilter };

export type Command =
  | { command: 'status' | 'resync' | 'reconnect' | 'drop-connection' | 'pair-qr' | 'stop' }
  | ({ command: 'chats'; limit: number; offset: number } & ChatFilters)
  | { command: 'chat'; jid: string }
  | { command: 'contact'; jid: string }
  | { command: 'resolve'; phone: string }
  | { command: 'messages'; jid: string; limit: number; offset: number }
  | { command: 'search'; query: string; jid?: string; limit: number; offset: number }
  | { command: 'group'; jid: string }
  | { command: 'events'; after: number }
  | { command: 'request'; key: string }
  | { command: 'pair-code'; phone: string }
  | { command: 'send'; key: string; jid: string; text: string }
  | { command: 'send-file'; key: string; jid: string; path: string; mime: string; caption: string }
  | { command: 'send-contact'; key: string; jid: string; name: string; phone: string }
  | { command: 'download'; jid: string; id: string; path: string; fromMe?: boolean; participant?: string }
  | { command: 'archive' | 'mark-read'; key: string; jid: string; value: boolean };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer from ${min} to ${max}`);
  return value;
}

function chatFilters(value: Record<string, unknown>): ChatFilters {
  const filters: ChatFilters = {};
  for (const field of ['unread', 'archived'] as const) {
    const state = value[field];
    if (state === undefined) continue;
    if (typeof state !== 'boolean' && state !== 'unknown') throw new Error(`${field} must be true, false or unknown`);
    filters[field] = state;
  }
  return filters;
}

export function parseCommand(value: Record<string, unknown>): Command {
  switch (value.command) {
    case 'status': case 'resync': case 'reconnect': case 'drop-connection': case 'pair-qr': case 'stop':
      return { command: value.command };
    case 'chats': return { command: value.command, limit: integer(value.limit ?? 100, 1, 100), offset: integer(value.offset ?? 0, 0, Number.MAX_SAFE_INTEGER), ...chatFilters(value) };
    case 'chat': return { command: value.command, jid: recipientJid(string(value.jid, 'jid')) };
    case 'contact': return { command: value.command, jid: contactJid(string(value.jid, 'jid')) };
    case 'resolve': return { command: value.command, phone: internationalPhone(string(value.phone, 'phone')) };
    case 'messages': return { command: value.command, jid: recipientJid(string(value.jid, 'jid')), limit: integer(value.limit ?? 20, 1, 100), offset: integer(value.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) };
    case 'search': return {
      command: value.command, query: string(value.query, 'query'),
      ...(value.jid === undefined ? {} : { jid: recipientJid(string(value.jid, 'jid')) }),
      limit: integer(value.limit ?? 20, 1, 100), offset: integer(value.offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
    };
    case 'group': {
      const jid = recipientJid(string(value.jid, 'jid'));
      if (!jid.endsWith('@g.us')) throw new Error('group requires an exact group JID');
      return { command: value.command, jid };
    }
    case 'events': return { command: value.command, after: integer(value.after ?? 0, 0, Number.MAX_SAFE_INTEGER) };
    case 'request': return { command: value.command, key: string(value.key, 'key') };
    case 'pair-code': {
      const phone = string(value.phone, 'phone');
      if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('phone must contain country code and digits only');
      return { command: value.command, phone };
    }
    case 'send': {
      const text = string(value.text, 'text');
      if (Buffer.byteLength(text) > 65536) throw new Error('Text exceeds the probe limit (64 KiB)');
      return { command: value.command, jid: recipientJid(string(value.jid, 'jid')), key: string(value.key, 'key'), text };
    }
    case 'send-file': return {
      command: value.command, jid: recipientJid(string(value.jid, 'jid')), key: string(value.key, 'key'),
      path: string(value.path, 'path'), mime: string(value.mime ?? 'application/octet-stream', 'mime'),
      caption: value.caption === undefined ? '' : typeof value.caption === 'string' ? value.caption : string(value.caption, 'caption'),
    };
    case 'send-contact': return {
      command: value.command, jid: recipientJid(string(value.jid, 'jid')), key: string(value.key, 'key'),
      name: contactName(string(value.name, 'name')), phone: internationalPhone(string(value.phone, 'phone')),
    };
    case 'download': {
      if (value.fromMe !== undefined && typeof value.fromMe !== 'boolean') throw new Error('fromMe must be a boolean');
      return {
        command: value.command, jid: recipientJid(string(value.jid, 'jid')), id: string(value.id, 'id'), path: string(value.path, 'path'),
        ...(value.fromMe === undefined ? {} : { fromMe: value.fromMe }),
        ...(value.participant === undefined ? {} : { participant: recipientJid(string(value.participant, 'participant')) }),
      };
    }
    case 'archive': case 'mark-read':
      if (typeof value.value !== 'boolean') throw new Error('value must be a boolean');
      return { command: value.command, jid: recipientJid(string(value.jid, 'jid')), key: string(value.key, 'key'), value: value.value };
    default: throw new Error('Unknown command');
  }
}

export class RequestError extends Error {
  constructor(readonly id: string | null, message: string) { super(message); }
}

export function parseRequest(line: string): { id: string; command: Command } {
  let id: string | null = null;
  try {
    if (Buffer.byteLength(line) > 131072) throw new Error('Request line exceeds 128 KiB');
    const value = object(JSON.parse(line));
    id = string(value.id, 'id');
    if (id.length > 200) throw new Error('id exceeds 200 characters');
    return { id, command: parseCommand(value) };
  } catch (error) { throw new RequestError(id, error instanceof Error ? error.message : 'Invalid request'); }
}
