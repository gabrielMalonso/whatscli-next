import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { isPn } from './identity.js';
import type { Monitor, MonitorChat, MonitorMessage } from './tui-model.js';

type Tone = 'plain' | 'muted' | 'own' | 'selected' | 'heading' | 'warning';
type Line = { text: string; tone: Tone };
const segmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
const line = (text = '', tone: Tone = 'plain'): Line => ({ text, tone });

/** WhatsApp content is untrusted terminal input, including names and captions. */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      character === '\n' || character === '\u200d' ? character : '',
    );
}

function singleLine(value: string): string {
  return terminalText(value).replace(/\n/g, ' ');
}

export function fit(value: string, width: number): string {
  const text = singleLine(value);
  if (width <= 0) return '';
  if (stringWidth(text) <= width)
    return text + ' '.repeat(width - stringWidth(text));
  let result = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    result += segment;
    used += size;
  }
  return result + '…' + ' '.repeat(width - used - 1);
}

export function wrap(value: string, width: number): string[] {
  const result: string[] = [];
  const text = terminalText(value);
  for (const paragraph of text.split('\n')) {
    let current = '';
    let used = 0;
    for (const { segment } of segmenter.segment(paragraph)) {
      const size = stringWidth(segment);
      if (used + size > width) {
        const space = current.lastIndexOf(' ');
        if (space > current.length / 2) {
          result.push(current.slice(0, space));
          current = current.slice(space + 1);
        } else {
          result.push(current);
          current = '';
        }
        used = stringWidth(current);
      }
      if (size <= width) {
        current += segment;
        used += size;
      }
    }
    result.push(current);
  }
  return result;
}

export function identity(jid: string): string {
  return isPn(jid) ? `+${jid.split('@')[0]}` : jid;
}

function name(monitor: Monitor, chat: MonitorChat): string {
  return monitor.displayName(chat.jid, chat.name) ?? identity(chat.jid);
}

function date(timestamp: number | null): Date | null {
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0)
    return null;
  const value = new Date(timestamp * 1000);
  return Number.isNaN(value.getTime()) ? null : value;
}

function time(timestamp: number | null): string {
  return (
    date(timestamp)?.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    }) ?? 'Hora desconhecida'
  );
}

function day(timestamp: number | null): string {
  return date(timestamp)?.toLocaleDateString('pt-BR') ?? 'Data desconhecida';
}

function body(message: MonitorMessage): string[] {
  if (message.deletion.source === 'chat-delete-boundary')
    return ['[Conteúdo indisponível: exclusão incerta]'];
  if (message.deletion.status === 'deleted') return ['[Mensagem apagada]'];
  const result: string[] = [];
  if (message.quote) {
    const quote = message.quote;
    result.push(
      `↳ ${quote.state === 'deleted' ? 'Mensagem citada apagada' : quote.state !== 'available' ? 'Citação indisponível' : (quote.text ?? 'Mensagem citada sem texto')}`,
    );
  }
  const media: Record<string, string> = {
    audioMessage: 'Áudio',
    imageMessage: 'Imagem',
    videoMessage: 'Vídeo',
    documentMessage: 'Documento',
    stickerMessage: 'Figurinha',
  };
  const kind = message.contentType ? media[message.contentType] : undefined;
  if (kind)
    result.push(
      `[${kind}${message.media?.fileName ? `: ${message.media.fileName}` : ''}]`,
    );
  if (message.text)
    result.push(
      message.text.slice(0, 16000) +
        (message.text.length > 16000 ? '\n[Texto longo; consulte a CLI]' : ''),
    );
  if (message.contacts) {
    result.push('[Contato compartilhado]');
    for (const card of message.contacts.cards) {
      const display = card.displayName ?? card.name;
      if (display) result.push(display);
    }
  }
  if (!result.length)
    result.push('[Conteúdo não exibido; consulte o WhatsApp no Mac]');
  return result;
}

function author(monitor: Monitor, message: MonitorMessage): string {
  if (message.fromMe === true) return 'Esta conta';
  if (message.fromMe === null) return 'Autoria desconhecida';
  const jid = message.participant;
  if (!jid)
    return monitor.selected ? name(monitor, monitor.selected) : 'Contato';
  const label = monitor.displayName(jid);
  const address = identity(jid);
  return label
    ? `${label} (${address})${monitor.contactConflict(jid) ? ' [vínculo ambíguo]' : ''}`
    : address;
}

function history(monitor: Monitor, width: number): Line[] {
  if (!monitor.selected) return [line('Selecione uma conversa.', 'muted')];
  if (!monitor.messages.length)
    return [
      line(
        monitor.loading
          ? 'Carregando mensagens…'
          : 'Sem mensagens nesta página do histórico local.',
        'muted',
      ),
    ];
  const lines: Line[] = [];
  let previousDay = '';
  for (const message of monitor.messages) {
    const currentDay = day(message.timestamp);
    if (currentDay !== previousDay) {
      lines.push(line(`  ${currentDay}`, 'muted'), line());
      previousDay = currentDay;
    }
    lines.push(
      line(
        `  ${author(monitor, message)}  ${time(message.timestamp)}`,
        message.fromMe === true ? 'own' : 'heading',
      ),
    );
    for (const text of body(message)) {
      for (const part of wrap(text, Math.max(1, Math.min(78, width - 4)))) {
        lines.push(line(`  ${part}`));
      }
    }
    lines.push(line());
  }
  return lines;
}

function chatLines(monitor: Monitor, height: number): Line[] {
  const chats = monitor.filteredChats;
  if (!chats.length)
    return [
      line(
        monitor.query
          ? ' Nenhuma conversa corresponde ao filtro.'
          : monitor.loading
            ? ' Carregando conversas…'
            : ' Nenhuma conversa nesta página local.',
        'muted',
      ),
    ];
  const selected = chats.findIndex(
    (chat) => chat.jid === monitor.selected?.jid,
  );
  const capacity = Math.max(1, Math.floor(height / 3));
  const start = Math.max(
    0,
    Math.min(chats.length - capacity, selected - capacity + 1),
  );
  return chats.slice(start, start + capacity).flatMap((chat) => {
    const active = chat.jid === monitor.selected?.jid;
    const marker =
      chat.unread === true ? '●' : chat.unread === null ? '?' : ' ';
    const state =
      chat.archived === true
        ? 'Arquivada'
        : chat.unread === true
          ? 'Não lida'
          : '';
    return [
      line(
        ` ${active ? '›' : ' '} ${name(monitor, chat)}`,
        active ? 'selected' : 'plain',
      ),
      line(
        `   ${marker} ${time(chat.timestamp)}${state ? `  ${state}` : ''}`,
        'muted',
      ),
      line(),
    ];
  });
}

function paint(value: Line, width: number, color: boolean): string {
  const text = fit(value.text, width);
  if (!color) return text;
  // Inherit the terminal's base colors and font; only semantic accents are styled.
  const codes: Record<Tone, string> = {
    plain: '',
    muted: '\x1b[90m',
    own: '\x1b[36m',
    selected: '\x1b[44;97;1m',
    heading: '\x1b[1m',
    warning: '\x1b[33m',
  };
  return codes[value.tone] + text + '\x1b[0m';
}

const connections: Record<string, string> = {
  open: 'Conexão WhatsApp aberta',
  offline: 'WhatsApp offline',
  close: 'Conexão WhatsApp fechada',
  connecting: 'Conectando ao WhatsApp',
};

export function renderMonitor(
  monitor: Monitor,
  columns: number,
  rows: number,
  label: string,
  color = true,
): { frame: string; maxScroll: number } {
  const width = Math.max(1, columns);
  const height = Math.max(1, rows);
  const output: string[] = [];
  const add = (value: Line) => output.push(paint(value, width, color));
  if (width < 48 || height < 12) {
    add(line('Aumente o terminal para pelo menos 48 × 12.', 'warning'));
    if (height > 1) add(line('q sair'));
  } else if (monitor.help) {
    const help = [
      'Atalhos do acompanhamento',
      '↑↓ ou j/k navegar   Tab ou ←→ alternar',
      'Enter abrir   Esc voltar / limpar filtro',
      '/ filtrar esta página   u não lidas',
      '[ / ] páginas de conversas',
      'PgUp/PgDn rolar   Home início',
      'b / f páginas de mensagens   End recentes',
      'r atualizar   ? / Esc fechar ajuda',
      'q / Ctrl+C sair somente do monitor',
      '',
      'Só leitura; não marca mensagens como lidas.',
      'Histórico local e parcial. Mídias no Mac.',
    ];
    for (const text of help.slice(0, height)) add(line(text));
  } else {
    add(line(` WhatsApp  /  Só leitura    ${label}`, 'heading'));
    const status =
      monitor.error ??
      `${connections[monitor.connection] ?? 'Conexão WhatsApp desconhecida'}${monitor.updatedAt ? `   Atualizado ${monitor.updatedAt.toLocaleTimeString('pt-BR')}` : '   Aguardando dados…'}`;
    add(line(` ${status}`, monitor.error ? 'warning' : 'muted'));
    add(line());
    const split = width >= 94;
    const leftWidth = split ? Math.min(38, Math.floor(width * 0.32)) : width;
    const rightWidth = split ? width - leftWidth - 1 : width;
    const showChats = split || monitor.focus === 'chats';
    const bodyHeight = height - 8;
    const messages = history(monitor, rightWidth);
    const maxScroll = Math.max(0, messages.length - bodyHeight);
    const scroll = Math.min(maxScroll, monitor.scroll);
    const end = Math.max(bodyHeight, messages.length - scroll);
    const visible = messages.slice(Math.max(0, end - bodyHeight), end);
    const list = chatLines(monitor, bodyHeight);
    const combine = (left: Line, right: Line) => {
      if (split)
        output.push(
          paint(left, leftWidth, color) +
            paint(line('│', 'muted'), 1, color) +
            paint(right, rightWidth, color),
        );
      else add(showChats ? left : right);
    };
    combine(
      line(
        ` ${monitor.focus === 'chats' ? '› ' : ''}Conversas${monitor.unreadOnly ? ' não lidas' : ''}  ${monitor.chatOffset + (monitor.chats.length ? 1 : 0)}–${monitor.chatOffset + monitor.chats.length}`,
        'heading',
      ),
      line(
        `  ${monitor.focus === 'messages' ? '› ' : ''}${monitor.selected ? name(monitor, monitor.selected) : 'Mensagens'}`,
        'heading',
      ),
    );
    combine(
      line(
        monitor.editing || monitor.query
          ? ` / ${monitor.query}${monitor.editing ? '▏' : ''}`
          : ' / filtrar esta página',
        monitor.editing ? 'heading' : 'muted',
      ),
      line(
        `  ${monitor.selected?.jid ?? 'Histórico local e parcial'}${monitor.selected && monitor.contactConflict(monitor.selected.jid) ? '  [vínculo ambíguo]' : ''}`,
        'muted',
      ),
    );
    combine(
      line('─'.repeat(leftWidth), 'muted'),
      line('─'.repeat(rightWidth), 'muted'),
    );
    for (let index = 0; index < bodyHeight; index++)
      combine(list[index] ?? line(), visible[index] ?? line());
    add(
      line(
        monitor.paused
          ? width < 68
            ? ' Leitura pausada   End para acompanhar'
            : ` Leitura pausada${monitor.messageOffset ? `   Mensagens anteriores: ${monitor.messageOffset}–${monitor.messageOffset + monitor.messages.length}` : ''}   End para acompanhar`
          : width < 68
            ? ' Acompanhando   Histórico local e parcial'
            : ' Acompanhando mensagens recentes   Histórico local e parcial',
        monitor.paused ? 'warning' : 'muted',
      ),
    );
    add(
      line(
        !split
          ? showChats
            ? ' ↑↓ navegar  Enter abrir  ? ajuda  q sair'
            : ' ↑↓ rolar  Esc voltar  ? ajuda  q sair'
          : ' Tab alternar  ↑↓ navegar  PgUp/PgDn rolar  b anteriores  ? ajuda  q sair',
        'muted',
      ),
    );
    return { frame: output.join('\r\n'), maxScroll };
  }
  while (output.length < height) add(line());
  return { frame: output.join('\r\n'), maxScroll: 0 };
}
