import type { Key } from 'node:readline';
import { CommandError } from './errors.js';
import { object } from './protocol.js';
import type { Command } from './protocol.js';
import type { messageOutput } from './output.js';
import { isLid, isPn } from './identity.js';
import { contactDisplay } from './tui-contacts.js';
import type { ContactDisplay } from './tui-contacts.js';

export type MonitorCommand =
  | { command: 'status' }
  | Extract<Command, { command: 'chats' | 'messages' | 'contact' }>;
export type MonitorRead = (
  command: MonitorCommand,
) => Promise<Record<string, unknown>>;
export type MonitorChat = {
  jid: string;
  name: string | null;
  unread: boolean | null;
  archived: boolean | null;
  timestamp: number | null;
};
type PublicMessage = ReturnType<typeof messageOutput>;
export type MonitorMessage = Pick<
  PublicMessage,
  'jid' | 'id' | 'fromMe' | 'participant' | 'timestamp' | 'text'
> & {
  contentType: string | null;
  deletion: Pick<PublicMessage['deletion'], 'status' | 'source'>;
  quote: Pick<NonNullable<PublicMessage['quote']>, 'state' | 'text'> | null;
  media: { fileName: string | null } | null;
  contacts: {
    cards: { name: string | null; displayName: string | null }[];
  } | null;
};

const chatPageSize = 100;
export const messagePageSize = 50;

function data(response: Record<string, unknown>): unknown {
  if (response.ok !== true)
    throw new CommandError('PROTOCOL', 'Consulta indisponível');
  return response.data;
}

function chatsFrom(value: unknown): MonitorChat[] {
  if (!Array.isArray(value)) throw new Error('Invalid chats response');
  return value.map((value) => {
    const chat = object(value);
    if (typeof chat.jid !== 'string') throw new Error('Missing chat JID');
    const activity = chat.activity ? object(chat.activity) : {};
    return {
      jid: chat.jid,
      name: typeof chat.name === 'string' ? chat.name : null,
      unread: typeof chat.unread === 'boolean' ? chat.unread : null,
      archived: typeof chat.archived === 'boolean' ? chat.archived : null,
      timestamp:
        typeof activity.timestamp === 'number' ? activity.timestamp : null,
    };
  });
}

function nullableText(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error('Invalid message text field');
}

function messagesFrom(value: unknown): MonitorMessage[] {
  if (!Array.isArray(value)) throw new Error('Invalid messages response');
  const messages = value.map((value): MonitorMessage => {
    const message = object(value);
    const deletion = object(message.deletion);
    const quote = message.quote === null ? null : object(message.quote);
    const media = message.media === null ? null : object(message.media);
    const contacts =
      message.contacts === null ? null : object(message.contacts);
    let displayedQuote: MonitorMessage['quote'] = null;
    if (quote) {
      const state = quote.state;
      if (state !== 'available' && state !== 'unknown' && state !== 'deleted')
        throw new Error('Invalid quote state');
      displayedQuote = { state, text: nullableText(quote.text) };
    }
    let displayedContacts: MonitorMessage['contacts'] = null;
    if (contacts) {
      const cards = contacts.cards;
      if (!Array.isArray(cards)) throw new Error('Invalid contact cards');
      displayedContacts = {
        cards: cards.map((value) => {
          const card = object(value);
          return {
            name: nullableText(card.name),
            displayName: nullableText(card.displayName),
          };
        }),
      };
    }
    if (
      typeof message.id !== 'string' ||
      typeof message.jid !== 'string' ||
      (message.fromMe !== null && typeof message.fromMe !== 'boolean') ||
      (message.timestamp !== null && typeof message.timestamp !== 'number') ||
      (deletion.status !== 'deleted' && deletion.status !== 'unknown') ||
      (deletion.source !== null &&
        deletion.source !== 'messages.delete' &&
        deletion.source !== 'revoke' &&
        deletion.source !== 'chat-delete-boundary')
    )
      throw new Error('Invalid message projection');
    return {
      id: message.id,
      jid: message.jid,
      fromMe: message.fromMe,
      timestamp: message.timestamp,
      participant: nullableText(message.participant),
      text: nullableText(message.text),
      contentType: nullableText(message.contentType),
      deletion: { status: deletion.status, source: deletion.source },
      quote: displayedQuote,
      media: media ? { fileName: nullableText(media.fileName) } : null,
      contacts: displayedContacts,
    };
  });
  // The public endpoint returns newest first; the terminal reads top to bottom.
  return messages.toReversed();
}

function searchable(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Read-only client state. No SDK, SQLite, session lifecycle or mutation access. */
export class Monitor {
  chats: MonitorChat[] = [];
  selected: MonitorChat | null = null;
  messages: MonitorMessage[] = [];
  chatOffset = 0;
  messageOffset = 0;
  unreadOnly = false;
  query = '';
  editing = false;
  help = false;
  focus: 'chats' | 'messages' = 'chats';
  scroll = 0;
  maxScroll = 0;
  paused = false;
  hasOlder = false;
  loading = true;
  connection = 'unknown';
  updatedAt: Date | null = null;
  error: string | null = null;
  private revision = 0;
  private historyDirty = true;
  private pending = false;
  private stopped = false;
  private work: Promise<void> | undefined;
  private namesWork: Promise<void> | undefined;
  private readonly contactCache = new Map<
    string,
    { display: ContactDisplay; retryAt: number }
  >();

  constructor(
    private readonly read: MonitorRead,
    private readonly changed: () => void,
  ) {}

  get filteredChats(): MonitorChat[] {
    const query = searchable(this.query);
    return this.chats.filter((chat) =>
      searchable(
        `${this.displayName(chat.jid, chat.name) ?? ''} ${chat.name ?? ''} ${chat.jid}`,
      ).includes(query),
    );
  }

  displayName(jid: string, chatName?: string | null): string | null {
    const label = this.contactCache.get(jid)?.display.label;
    if (label?.field === 'name') return label.value;
    return chatName?.trim() || label?.value || null;
  }

  contactConflict(jid: string): boolean {
    return this.contactCache.get(jid)?.display.mapping === 'conflict';
  }

  private refreshContactNames(): void {
    if (this.stopped || this.namesWork) return;
    const revision = this.revision;
    const jids = [
      ...new Set([
        ...(this.selected ? [this.selected.jid] : []),
        ...this.messages.flatMap((message) =>
          message.fromMe === false && message.participant
            ? [message.participant]
            : [],
        ),
        ...this.chats.map((chat) => chat.jid),
      ]),
    ].filter(
      (jid) =>
        (isPn(jid) || isLid(jid)) &&
        (this.contactCache.get(jid)?.retryAt ?? 0) <= Date.now(),
    );
    // Optional local lookups run separately so slow/missing contact data never
    // delays the message feed. Four concurrent requests, cached for one minute.
    this.namesWork = (async () => {
      for (let offset = 0; offset < jids.length; offset += 4) {
        if (this.stopped || revision !== this.revision) break;
        const batch = jids.slice(offset, offset + 4);
        const results = await Promise.all(
          batch.map(async (jid) => {
            try {
              const response = await this.read({ command: 'contact', jid });
              return {
                jid,
                display: contactDisplay(jid, data(response)),
                retryAt: Date.now() + 60000,
              };
            } catch {
              return {
                jid,
                display: this.contactCache.get(jid)?.display ?? {
                  mapping: 'unknown' as const,
                  label: null,
                },
                retryAt: Date.now() + 10000,
              };
            }
          }),
        );
        if (this.stopped) return;
        let changed = false;
        for (const { jid, display, retryAt } of results) {
          const previous = this.contactCache.get(jid)?.display;
          changed ||=
            previous?.label?.value !== display.label?.value ||
            previous?.label?.field !== display.label?.field ||
            (previous?.mapping ?? 'unknown') !== display.mapping;
          this.contactCache.delete(jid);
          this.contactCache.set(jid, { display, retryAt });
        }
        while (this.contactCache.size > 1000) {
          const oldest = this.contactCache.keys().next().value;
          if (oldest === undefined) break;
          this.contactCache.delete(oldest);
        }
        if (changed) this.changed();
      }
    })().finally(() => {
      this.namesWork = undefined;
    });
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending = true;
    this.work ??= (async () => {
      do {
        this.pending = false;
        await this.load();
      } while (this.pending && !this.stopped);
    })().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }

  stop(): void {
    this.stopped = true;
  }

  private async load(): Promise<void> {
    const revision = this.revision;
    try {
      const results = await Promise.allSettled([
        this.read({ command: 'status' }),
        this.read({
          command: 'chats',
          limit: chatPageSize,
          offset: this.chatOffset,
          ...(this.unreadOnly ? { unread: true } : {}),
        }),
      ]);
      const [statusResult, chatsResult] = results;
      if (statusResult.status === 'rejected') throw statusResult.reason;
      if (chatsResult.status === 'rejected') throw chatsResult.reason;
      const status = statusResult.value;
      const response = chatsResult.value;
      data(status);
      const chats = chatsFrom(data(response));
      if (this.stopped || revision !== this.revision) return;
      this.connection =
        typeof status.connection === 'string' ? status.connection : 'unknown';
      this.chats = chats;
      this.selected = this.selected
        ? (chats.find((chat) => chat.jid === this.selected?.jid) ??
          this.selected)
        : (this.filteredChats[0] ?? null);
      const jid = this.selected?.jid;
      if (jid && (this.historyDirty || !this.paused)) {
        const response = await this.read({
          command: 'messages',
          jid,
          limit: messagePageSize,
          offset: this.messageOffset,
        });
        const messages = messagesFrom(data(response));
        if (this.stopped || revision !== this.revision) return;
        if (messages.some((message) => message.jid !== jid))
          throw new Error('Unexpected message chat');
        this.messages = messages;
        this.hasOlder = messages.length === messagePageSize;
        this.historyDirty = false;
      }
      this.error = null;
      this.updatedAt = new Date();
      this.refreshContactNames();
    } catch (error) {
      if (this.stopped || revision !== this.revision) return;
      this.error =
        error instanceof CommandError && error.code === 'NOT_RUNNING'
          ? 'Runtime indisponível. Inicie a CLI nesta conta; tentando novamente.'
          : 'Não foi possível atualizar. Tentando novamente; dados desatualizados.';
    } finally {
      if (!this.stopped && revision === this.revision) {
        this.loading = false;
        this.changed();
      }
    }
  }

  private invalidate(resetHistory = false): void {
    this.revision++;
    this.loading = true;
    this.historyDirty = true;
    if (resetHistory) {
      this.messages = [];
      this.messageOffset = 0;
      this.scroll = 0;
      this.maxScroll = 0;
      this.paused = false;
      this.hasOlder = false;
    }
    void this.refresh();
  }

  private moveChat(delta: number): void {
    const chats = this.filteredChats;
    const current = chats.findIndex((chat) => chat.jid === this.selected?.jid);
    const index = Math.max(0, Math.min(chats.length - 1, current + delta));
    const next = chats[index] ?? null;
    if (next?.jid === this.selected?.jid) return;
    this.selected = next;
    this.invalidate(true);
  }

  /** Returns true only when the user requests closing this client. */
  key(text: string, key: Key, pageRows: number): boolean {
    if (key.ctrl && key.name === 'c') return true;
    if (this.editing) {
      if (key.name === 'escape' || key.name === 'return') {
        this.editing = false;
      } else if (key.name === 'backspace') {
        const parts = [...new Intl.Segmenter().segment(this.query)];
        this.query = this.query.slice(0, parts.at(-1)?.index ?? 0);
        this.selectFiltered();
      } else if (
        !key.ctrl &&
        !key.meta &&
        text &&
        !/[\p{Cc}\p{Cf}]/u.test(text)
      ) {
        this.query = (this.query + text).slice(0, 160);
        this.selectFiltered();
      }
    } else if (key.name === 'q') {
      return true;
    } else if (text === '?') {
      this.help = !this.help;
    } else if (key.name === 'escape') {
      this.help = false;
      this.focus = 'chats';
      if (this.query) {
        this.query = '';
        this.selectFiltered();
      }
    } else if (text === '/') {
      this.editing = true;
      this.focus = 'chats';
    } else if (key.name === 'tab') {
      this.focus = this.focus === 'chats' ? 'messages' : 'chats';
    } else if (key.name === 'return' || key.name === 'right') {
      this.focus = 'messages';
    } else if (key.name === 'left') {
      this.focus = 'chats';
    } else if (key.name === 'u') {
      this.unreadOnly = !this.unreadOnly;
      this.chatOffset = 0;
      this.selected = null;
      this.invalidate(true);
    } else if (
      text === '[' ||
      (text === ']' && this.chats.length === chatPageSize)
    ) {
      this.chatOffset = Math.max(
        0,
        this.chatOffset + (text === ']' ? 100 : -100),
      );
      this.query = '';
      this.selected = null;
      this.invalidate(true);
    } else if (key.name === 'r') {
      for (const entry of this.contactCache.values()) entry.retryAt = 0;
      this.invalidate();
    } else if (key.name === 'end') {
      this.messageOffset = 0;
      this.paused = false;
      this.scroll = 0;
      this.invalidate();
    } else if (this.focus === 'chats') {
      if (key.name === 'up' || key.name === 'k') this.moveChat(-1);
      if (key.name === 'down' || key.name === 'j') this.moveChat(1);
    } else if (key.name === 'b' && this.hasOlder) {
      this.messageOffset += messagePageSize;
      this.paused = true;
      this.scroll = 0;
      this.messages = [];
      this.invalidate();
    } else if (key.name === 'f' && this.messageOffset > 0) {
      this.messageOffset -= messagePageSize;
      this.scroll = 0;
      this.messages = [];
      this.invalidate();
    } else if (['up', 'k', 'pageup', 'home'].includes(key.name ?? '')) {
      this.paused = true;
      const amount = key.name === 'pageup' ? pageRows : 1;
      this.scroll =
        key.name === 'home'
          ? this.maxScroll
          : Math.min(this.maxScroll, this.scroll + amount);
    } else if (['down', 'j', 'pagedown'].includes(key.name ?? '')) {
      this.scroll = Math.max(
        0,
        this.scroll - (key.name === 'pagedown' ? pageRows : 1),
      );
    }
    this.changed();
    return false;
  }

  private selectFiltered(): void {
    this.selected = this.filteredChats[0] ?? null;
    this.invalidate(true);
  }
}
