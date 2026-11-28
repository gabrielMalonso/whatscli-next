import {
  chatKinds,
  contactJid,
  expectedAccount,
  internationalPhone,
  recipientJid,
} from './identity.js';
import type { ChatKind } from './identity.js';
import { contactName } from './contact-card.js';
import { CommandError } from './errors.js';

// 'not-true' matches false or unknown state: a triage queue must not drop
// conversations whose state the SDK never reported explicitly.
export type ChatStateFilter = boolean | 'unknown' | 'not-true';
export type ChatFilters = {
  unread?: ChatStateFilter;
  archived?: ChatStateFilter;
  observedOnly?: boolean;
  /** Absent means every kind. */
  kinds?: ChatKind[];
};
/** Opt-in, read-only enrichment of chats rows. */
export const chatIncludes = ['contact', 'last-message'] as const;
export type ChatInclude = (typeof chatIncludes)[number];
/** Upper bound for the optional, response-only acceptance wait on sends. */
export const MAX_WAIT_ACK_MS = 30000;
/** Response option only: never part of the immutable operation or its idempotency comparison. */
export type AckWaitOption = { waitAckMs?: number };

export type QuoteSelector = {
  id: string;
  fromMe: boolean;
  participant?: string;
};

export type Command =
  | {
      command:
        | 'status'
        | 'resync'
        | 'reconnect'
        | 'drop-connection'
        | 'pair-qr'
        | 'stop'
        | 'observability';
    }
  | ({
      command: 'chats';
      limit: number;
      offset: number;
      include?: ChatInclude[];
    } & ChatFilters)
  | { command: 'chat'; jid: string }
  | { command: 'contact'; jid: string }
  | { command: 'contacts'; query: string; limit: number; offset: number }
  | { command: 'resolve'; phone: string }
  | { command: 'messages'; jid: string; limit: number; offset: number }
  | { command: 'incoming'; jid: string; afterId: string | null; limit: number }
  | {
      command: 'search';
      query: string;
      jid?: string;
      limit: number;
      offset: number;
    }
  | { command: 'group'; jid: string }
  | { command: 'events'; after: number; tail?: number; kind?: string }
  | { command: 'request'; key: string }
  | { command: 'backup'; path: string }
  | { command: 'pair-code'; phone: string }
  | ({
      command: 'send';
      key: string;
      jid: string;
      text: string;
      quote?: QuoteSelector;
    } & AckWaitOption)
  | ({
      command: 'send-file';
      key: string;
      jid: string;
      path: string;
      mime: string;
      caption: string;
    } & AckWaitOption)
  | ({
      command: 'send-contact';
      key: string;
      jid: string;
      name: string;
      phone: string;
    } & AckWaitOption)
  | {
      command: 'download';
      jid: string;
      messageId: string;
      path: string;
      fromMe?: boolean;
      participant?: string;
    }
  | {
      command: 'archive' | 'mark-read';
      key: string;
      jid: string;
      value: boolean;
      /** Proceed only if this is the latest stored incoming message ID; null means none. */
      ifLatestIncoming?: string | null;
    };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new CommandError(
      'INVALID_ARGUMENT',
      `${label} must be a nonempty string`,
    );
  return value;
}

/** Journal kinds are fixed internal labels and SDK event names, e.g. messages.upsert. */
export const eventKind = /^[A-Za-z0-9._-]{1,64}$/;

function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new CommandError(
      'INVALID_ARGUMENT',
      `Expected an integer from ${min} to ${max}`,
    );
  return value;
}

function ackWait(value: Record<string, unknown>): AckWaitOption {
  if (value.waitAckMs === undefined) return {};
  const waitAckMs = value.waitAckMs;
  if (
    typeof waitAckMs !== 'number' ||
    !Number.isSafeInteger(waitAckMs) ||
    waitAckMs < 0 ||
    waitAckMs > MAX_WAIT_ACK_MS
  )
    throw new CommandError(
      'INVALID_ARGUMENT',
      `waitAckMs must be an integer from 0 to ${MAX_WAIT_ACK_MS}`,
    );
  // Zero keeps the exact immediate response; it is not forwarded as a wait.
  return waitAckMs === 0 ? {} : { waitAckMs };
}

function chatFilters(value: Record<string, unknown>): ChatFilters {
  const filters: ChatFilters = {};
  if (value.observedOnly !== undefined) {
    if (typeof value.observedOnly !== 'boolean')
      throw new CommandError(
        'INVALID_ARGUMENT',
        'observedOnly must be boolean',
      );
    filters.observedOnly = value.observedOnly;
  }
  for (const field of ['unread', 'archived'] as const) {
    const state = value[field];
    if (state === undefined) continue;
    if (
      typeof state !== 'boolean' &&
      state !== 'unknown' &&
      state !== 'not-true'
    )
      throw new CommandError(
        'INVALID_ARGUMENT',
        `${field} must be true, false, unknown or not-true`,
      );
    filters[field] = state;
  }
  if (value.kinds !== undefined)
    filters.kinds = list(value.kinds, 'kinds', chatKinds);
  return filters;
}

/** A message ID, or null for none. */
function messageSelector(value: unknown, label: string): string | null {
  if (
    value !== null &&
    (typeof value !== 'string' || value.length === 0 || value.length > 200)
  )
    throw new CommandError(
      'INVALID_ARGUMENT',
      `${label} must be a message ID (up to 200 characters) or null`,
    );
  return value;
}

/**
 * The socket spelling of a command. Guarded chat mutations use their own
 * names, so a daemon without the guard rejects them instead of dropping it.
 */
export function wireCommand(command: Command): Record<string, unknown> {
  if (
    (command.command === 'archive' || command.command === 'mark-read') &&
    command.ifLatestIncoming !== undefined
  )
    return { ...command, command: `guarded-${command.command}` };
  if (
    command.command === 'chats' &&
    (command.kinds !== undefined || command.include !== undefined)
  )
    return { ...command, command: 'filtered-chats' };
  return command;
}

/** Whether a command needs a socket name that a daemon without the feature rejects. */
export function needsFilteredChats(command: Command): boolean {
  return wireCommand(command).command === 'filtered-chats';
}

/** A nonempty list of distinct known values, in canonical order. */
function list<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => allowed.includes(item as T)) ||
    new Set(value).size !== value.length
  )
    throw new CommandError(
      'INVALID_ARGUMENT',
      `${name} must be a nonempty list of distinct values: ${allowed.join(', ')}`,
    );
  return allowed.filter((item) => value.includes(item));
}

/** Lookup text for contacts: trimmed, at least two characters. */
function contactQuery(value: unknown): string {
  const query = string(value, 'query').trim();
  if ([...query].length < 2)
    throw new CommandError(
      'INVALID_ARGUMENT',
      'query must have at least two characters',
    );
  return query;
}

export function parseCommand(value: Record<string, unknown>): Command {
  switch (value.command) {
    case 'status':
    case 'resync':
    case 'reconnect':
    case 'drop-connection':
    case 'pair-qr':
    case 'stop':
    case 'observability':
      return { command: value.command };
    case 'chats':
    case 'filtered-chats': {
      // An older daemon would ignore kinds and include on chats; accept them
      // only under filtered-chats, which such a daemon rejects.
      const filtered = value.command === 'filtered-chats';
      if (
        filtered !== (value.kinds !== undefined || value.include !== undefined)
      )
        throw new CommandError(
          'INVALID_ARGUMENT',
          filtered
            ? 'filtered-chats requires kinds or include'
            : 'kinds and include require filtered-chats',
        );
      return {
        command: 'chats',
        limit: integer(value.limit ?? 100, 1, 100),
        offset: integer(value.offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
        ...chatFilters(value),
        ...(value.include === undefined
          ? {}
          : { include: list(value.include, 'include', chatIncludes) }),
      };
    }
    case 'chat':
      return {
        command: value.command,
        jid: recipientJid(string(value.jid, 'jid')),
      };
    case 'contact':
      return {
        command: value.command,
        jid: contactJid(string(value.jid, 'jid')),
      };
    case 'contacts':
      return {
        command: value.command,
        query: contactQuery(value.query),
        limit: integer(value.limit ?? 20, 1, 100),
        offset: integer(value.offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
      };
    case 'resolve':
      return {
        command: value.command,
        phone: internationalPhone(string(value.phone, 'phone')),
      };
    case 'messages':
      return {
        command: value.command,
        jid: recipientJid(string(value.jid, 'jid')),
        limit: integer(value.limit ?? 20, 1, 100),
        offset: integer(value.offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
      };
    case 'search':
      return {
        command: value.command,
        query: string(value.query, 'query'),
        ...(value.jid === undefined
          ? {}
          : { jid: recipientJid(string(value.jid, 'jid')) }),
        limit: integer(value.limit ?? 20, 1, 100),
        offset: integer(value.offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
      };
    case 'group': {
      const jid = recipientJid(string(value.jid, 'jid'));
      if (!jid.endsWith('@g.us'))
        throw new CommandError(
          'INVALID_ARGUMENT',
          'group requires an exact group JID',
        );
      return { command: value.command, jid };
    }
    case 'events': {
      let tail: number | undefined;
      if (value.tail !== undefined)
        try {
          tail = integer(value.tail, 1, 100);
        } catch {
          throw new CommandError(
            'INVALID_ARGUMENT',
            'tail must be an integer from 1 to 100',
          );
        }
      let kind: string | undefined;
      if (value.kind !== undefined) {
        if (typeof value.kind !== 'string' || !eventKind.test(value.kind))
          throw new CommandError(
            'INVALID_ARGUMENT',
            'kind must be an event kind such as connection or messages.upsert',
          );
        kind = value.kind;
      }
      return {
        command: value.command,
        after: integer(value.after ?? 0, 0, Number.MAX_SAFE_INTEGER),
        ...(tail === undefined ? {} : { tail }),
        ...(kind === undefined ? {} : { kind }),
      };
    }
    case 'request':
      return { command: value.command, key: string(value.key, 'key') };
    case 'backup':
      return { command: value.command, path: string(value.path, 'path') };
    case 'pair-code': {
      const phone = string(value.phone, 'phone');
      if (!/^[1-9]\d{7,14}$/.test(phone))
        throw new CommandError(
          'INVALID_ARGUMENT',
          'phone must contain country code and digits only',
        );
      return { command: value.command, phone };
    }
    case 'send': {
      const text = string(value.text, 'text');
      if (Buffer.byteLength(text) > 65536)
        throw new CommandError(
          'INVALID_ARGUMENT',
          'Text exceeds the probe limit (64 KiB)',
        );
      let quote: QuoteSelector | undefined;
      if (value.quote !== undefined) {
        if (
          !value.quote ||
          typeof value.quote !== 'object' ||
          Array.isArray(value.quote)
        )
          throw new CommandError(
            'INVALID_ARGUMENT',
            'quote must be an exact message selector',
          );
        const ref = object(value.quote);
        if (typeof ref.fromMe !== 'boolean')
          throw new CommandError(
            'INVALID_ARGUMENT',
            'quote.fromMe must be a boolean',
          );
        if (
          Object.keys(ref).some(
            (key) => !['id', 'fromMe', 'participant'].includes(key),
          )
        )
          throw new CommandError(
            'INVALID_ARGUMENT',
            'Unknown quote selector field',
          );
        quote = {
          id: string(ref.id, 'quote.id'),
          fromMe: ref.fromMe,
          ...(ref.participant === undefined
            ? {}
            : {
                participant: contactJid(
                  string(ref.participant, 'quote.participant'),
                ),
              }),
        };
      }
      return {
        command: value.command,
        jid: recipientJid(string(value.jid, 'jid')),
        key: string(value.key, 'key'),
        text,
        ...(quote ? { quote } : {}),
        ...ackWait(value),
      };
    }
    case 'send-file':
      return {
        command: value.command,
        jid: recipientJid(string(value.jid, 'jid')),
        key: string(value.key, 'key'),
        path: string(value.path, 'path'),
        mime: string(value.mime ?? 'application/octet-stream', 'mime'),
        caption:
          value.caption === undefined
            ? ''
            : typeof value.caption === 'string'
              ? value.caption
              : string(value.caption, 'caption'),
        ...ackWait(value),
      };
    case 'send-contact':
      return {
        command: value.command,
        jid: recipientJid(string(value.jid, 'jid')),
        key: string(value.key, 'key'),
        name: contactName(string(value.name, 'name')),
        phone: internationalPhone(string(value.phone, 'phone')),
        ...ackWait(value),
      };
    case 'download': {
      if (value.fromMe !== undefined && typeof value.fromMe !== 'boolean')
        throw new CommandError('INVALID_ARGUMENT', 'fromMe must be a boolean');
      return {
        command: value.command,
        jid: recipientJid(string(value.jid, 'jid')),
        messageId: string(value.messageId, 'messageId'),
        path: string(value.path, 'path'),
        ...(value.fromMe === undefined ? {} : { fromMe: value.fromMe }),
        ...(value.participant === undefined
          ? {}
          : {
              participant: recipientJid(
                string(value.participant, 'participant'),
              ),
            }),
      };
    }
    case 'archive':
    case 'mark-read':
    case 'guarded-archive':
    case 'guarded-mark-read': {
      if (typeof value.value !== 'boolean')
        throw new CommandError('INVALID_ARGUMENT', 'value must be a boolean');
      const guarded = value.command.startsWith('guarded-');
      // A guard sent under a plain command name would be dropped by an older
      // daemon; accept it only under the guarded names, which such a daemon rejects.
      if (guarded !== (value.ifLatestIncoming !== undefined))
        throw new CommandError(
          'INVALID_ARGUMENT',
          guarded
            ? 'guarded-archive and guarded-mark-read require ifLatestIncoming'
            : 'ifLatestIncoming requires guarded-archive or guarded-mark-read',
        );
      return {
        command:
          value.command === 'archive' || value.command === 'guarded-archive'
            ? 'archive'
            : 'mark-read',
        jid: recipientJid(string(value.jid, 'jid')),
        key: string(value.key, 'key'),
        value: value.value,
        ...(guarded
          ? {
              ifLatestIncoming: messageSelector(
                value.ifLatestIncoming,
                'ifLatestIncoming',
              ),
            }
          : {}),
      };
    }
    case 'incoming':
      return {
        command: value.command,
        jid: recipientJid(string(value.jid, 'jid')),
        afterId:
          value.afterId === undefined
            ? null
            : messageSelector(value.afterId, 'afterId'),
        limit: integer(value.limit ?? 20, 1, 100),
      };
    default:
      throw new CommandError('INVALID_ARGUMENT', 'Unknown command');
  }
}

export class RequestError extends CommandError {
  constructor(
    readonly id: string | null,
    message: string,
    readonly action: string = 'unknown',
  ) {
    super('INVALID_ARGUMENT', message);
  }
}

/**
 * The socket spelling of a request. An account expectation wraps the command
 * under its own name, so a daemon without the check rejects it as an unknown
 * command instead of ignoring the field.
 */
/** The single place that builds wire requests: guarded names first, then the account wrapper. */
export function wireRequest(
  command: Command,
  expectAccount?: string,
): Record<string, unknown> {
  const wire = wireCommand(command);
  return expectAccount === undefined
    ? wire
    : { command: 'expect-account', expectAccount, request: wire };
}

export type Request = { id: string; command: Command; expectAccount?: string };

export function parseRequest(line: string): Request {
  let id: string | null = null;
  let action = 'unknown';
  try {
    if (Buffer.byteLength(line) > 131072)
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Request line exceeds 128 KiB',
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CommandError('INVALID_ARGUMENT', 'Invalid JSON request');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new CommandError('INVALID_ARGUMENT', 'Expected a JSON object');
    const value = object(parsed);
    if (typeof value.command === 'string') action = value.command;
    id = string(value.id, 'id');
    if (id.length > 200)
      throw new CommandError('INVALID_ARGUMENT', 'id exceeds 200 characters');
    if (value.command !== 'expect-account') {
      // A field an older daemon would ignore; it must travel in the wrapper.
      if (value.expectAccount !== undefined)
        throw new CommandError(
          'INVALID_ARGUMENT',
          'expectAccount requires the expect-account request wrapper',
        );
      return { id, command: parseCommand(value) };
    }
    if (
      !value.request ||
      typeof value.request !== 'object' ||
      Array.isArray(value.request)
    )
      throw new CommandError(
        'INVALID_ARGUMENT',
        'expect-account requires a request object',
      );
    const inner = object(value.request);
    if (typeof inner.command === 'string') action = inner.command;
    const expectAccount = expectedAccount(
      string(value.expectAccount, 'expectAccount'),
    );
    // The inner request is a plain command: nesting another wrapper is an unknown command.
    return { id, command: parseCommand(inner), expectAccount };
  } catch (error) {
    throw new RequestError(
      id,
      error instanceof CommandError ? error.message : 'Invalid request',
      action,
    );
  }
}
