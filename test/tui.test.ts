import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { ReadStream, WriteStream } from 'node:tty';
import { promisify, stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import stringWidth from 'string-width';
import { CommandError } from '../src/errors.js';
import { messageOutput } from '../src/output.js';
import { rpc } from '../src/rpc.js';
import { Store } from '../src/store.js';
import { Monitor, messagePageSize } from '../src/tui-model.js';
import type { MonitorCommand, MonitorRead } from '../src/tui-model.js';
import {
  fit,
  identity,
  renderMonitor,
  terminalText,
  wrap,
} from '../src/tui-view.js';
import { enterTerminal, leaveTerminal, runMonitor } from '../src/tui.js';
import { history, pn, lid, publicResponse } from './fixtures/responses.js';

process.umask(0o077);
const runFile = promisify(execFile);
const chat = (jid = pn, name: string | null = 'Conversa fictícia') => ({
  jid,
  name,
  unread: true,
  archived: false,
  activity: { timestamp: 1700000000, source: 'message.messageTimestamp' },
});
const message = (id: string, jid = pn) =>
  messageOutput({
    key: { remoteJid: jid, id, fromMe: false },
    messageTimestamp: 1700000000,
    message: { conversation: `Mensagem fictícia ${id}` },
  });

function source() {
  const requests: MonitorCommand[] = [];
  const state = {
    chats: [chat(), chat(lid, 'Revisão')],
    messages: [message('newest'), message('oldest')],
    fail: false,
  };
  const read: MonitorRead = async (command) => {
    requests.push(command);
    if (state.fail)
      throw new CommandError('NOT_RUNNING', 'FICTIONAL_PRIVATE_ERROR');
    return publicResponse(
      command.command === 'chats'
        ? state.chats
        : command.command === 'messages'
          ? state.messages.filter((message) => message.jid === command.jid)
          : {},
    );
  };
  return { requests, state, read };
}

test('monitor uses only public read queries, preserves exact identities and freezes history while browsing', async () => {
  const fixture = source();
  const monitor = new Monitor(fixture.read, () => {});
  await monitor.refresh();
  assert.deepEqual(
    monitor.messages.map((message) => message.id),
    ['oldest', 'newest'],
  );
  fixture.state.chats.reverse();
  await monitor.refresh();
  assert.equal(
    monitor.selected?.jid,
    pn,
    'reordering cannot select another conversation',
  );
  monitor.focus = 'messages';
  monitor.maxScroll = 100;
  monitor.key('', { name: 'pageup' }, 12);
  assert.equal(monitor.paused, true);
  const count = fixture.requests.filter(
    (request) => request.command === 'messages',
  ).length;
  fixture.state.messages.unshift(message('arrived-while-paused'));
  await monitor.refresh();
  assert.equal(
    fixture.requests.filter((request) => request.command === 'messages').length,
    count,
  );
  assert.equal(monitor.messages.at(-1)?.id, 'newest');
  monitor.key('', { name: 'end' }, 12);
  await monitor.refresh();
  assert.equal(monitor.paused, false);
  assert.equal(monitor.messages.at(-1)?.id, 'arrived-while-paused');
  assert.ok(
    fixture.requests.every((request) =>
      ['status', 'chats', 'messages', 'contact'].includes(request.command),
    ),
  );
});

test('filtering, unread and pagination retain unknown state and never merge PN/LID histories', async () => {
  const fixture = source();
  const monitor = new Monitor(fixture.read, () => {});
  await monitor.refresh();
  monitor.key('/', { name: '/' }, 12);
  monitor.key('revisao', {}, 12);
  await monitor.refresh();
  assert.equal(monitor.selected?.jid, lid);
  assert.deepEqual(monitor.messages, []);
  monitor.key('', { name: 'return' }, 12);
  monitor.key('', { name: 'escape' }, 12);
  await monitor.refresh();
  assert.equal(monitor.query, '');
  monitor.key('', { name: 'u' }, 12);
  await monitor.refresh();
  assert.ok(
    fixture.requests.some(
      (request) => request.command === 'chats' && request.unread === true,
    ),
  );
  fixture.state.chats = Array.from({ length: 100 }, (_, index) =>
    chat(`${1000000000 + index}@lid`, `Fictício ${index}`),
  );
  await monitor.refresh();
  monitor.key(']', {}, 12);
  await monitor.refresh();
  assert.ok(
    fixture.requests.some(
      (request) => request.command === 'chats' && request.offset === 100,
    ),
  );
  monitor.key('[', {}, 12);
  await monitor.refresh();
  assert.equal(monitor.chatOffset, 0);
  assert.equal(identity(lid), lid);
  assert.equal(identity(pn), '+12025550101');
});

test('older message pages pause history and End returns to the current window', async () => {
  const requests: MonitorCommand[] = [];
  const monitor = new Monitor(
    async (request) => {
      requests.push(request);
      return publicResponse(
        request.command === 'chats'
          ? [chat()]
          : request.command === 'messages'
            ? Array.from({ length: messagePageSize }, (_, index) =>
                message(`${request.offset + index}`),
              )
            : {},
      );
    },
    () => {},
  );
  await monitor.refresh();
  monitor.focus = 'messages';
  monitor.key('', { name: 'b' }, 12);
  await monitor.refresh();
  assert.equal(monitor.messageOffset, 50);
  assert.equal(monitor.paused, true);
  assert.ok(
    requests.some(
      (request) => request.command === 'messages' && request.offset === 50,
    ),
  );
  monitor.key('', { name: 'f' }, 12);
  await monitor.refresh();
  assert.equal(monitor.messageOffset, 0);
  assert.equal(monitor.paused, true);
  monitor.key('', { name: 'end' }, 12);
  await monitor.refresh();
  assert.equal(monitor.paused, false);
});

test('a delayed reply for a previous selection never appears under the next conversation', async () => {
  const fixture = source();
  let release: (value: Record<string, unknown>) => void = () => {};
  let delayed = false;
  const monitor = new Monitor(
    async (command) => {
      if (delayed && command.command === 'messages' && command.jid === pn) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return fixture.read(command);
    },
    () => {},
  );
  await monitor.refresh();
  delayed = true;
  const pending = monitor.refresh();
  await setImmediate();
  monitor.key('', { name: 'down' }, 12);
  assert.equal(monitor.selected?.jid, lid);
  assert.deepEqual(monitor.messages, []);
  release(publicResponse([message('old-selection')]));
  await pending;
  assert.equal(monitor.selected?.jid, lid);
  assert.deepEqual(monitor.messages, []);
});

test('refresh requests coalesce instead of overlapping cycles, and malformed projections remain safe', async () => {
  const fixture = source();
  let active = 0;
  let maximum = 0;
  const monitor = new Monitor(
    async (command) => {
      if (command.command === 'contact') return fixture.read(command);
      active++;
      maximum = Math.max(maximum, active);
      await setImmediate();
      active--;
      return fixture.read(command);
    },
    () => {},
  );
  await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
  assert.equal(
    maximum,
    2,
    'only status and chats run together inside one cycle',
  );
  assert.equal(
    fixture.requests.filter((request) => request.command === 'status').length,
    2,
  );
  const malformed = new Monitor(
    async (command) =>
      publicResponse(
        command.command === 'chats'
          ? [chat()]
          : command.command === 'messages'
            ? [{ ...message('bad'), contacts: { cards: null } }]
            : {},
      ),
    () => {},
  );
  await malformed.refresh();
  assert.match(malformed.error ?? '', /Não foi possível atualizar/);
  assert.deepEqual(malformed.messages, []);
  assert.doesNotThrow(() => renderMonitor(malformed, 120, 30, 'fictícia'));
});

test('disconnects retain visibly stale data, recover without lifecycle commands, and suppress private errors', async () => {
  const fixture = source();
  const monitor = new Monitor(fixture.read, () => {});
  await monitor.refresh();
  const original = monitor.messages;
  fixture.state.fail = true;
  await monitor.refresh();
  assert.equal(monitor.messages, original);
  const frame = renderMonitor(monitor, 120, 30, 'fictícia', false).frame;
  assert.match(frame, /Runtime indisponível/);
  assert.doesNotMatch(frame, /FICTIONAL_PRIVATE_ERROR/);
  fixture.state.fail = false;
  await monitor.refresh();
  assert.equal(monitor.error, null);
  monitor.stop();
  const count = fixture.requests.length;
  await monitor.refresh();
  assert.equal(fixture.requests.length, count);
});

test('terminal rendering respects cell widths, quotes, deletions, media and narrow layouts', async () => {
  const monitor = new Monitor(
    async (command) =>
      publicResponse(
        command.command === 'chats'
          ? [chat(lid, 'Revisão 👩🏽‍💻 漢字')]
          : command.command === 'messages'
            ? [
                messageOutput({
                  key: { remoteJid: lid, id: 'audio', fromMe: true },
                  message: { audioMessage: { seconds: 23 } },
                }),
                ...history
                  .toReversed()
                  .map((message) => ({ ...message, jid: lid })),
              ]
            : {},
      ),
    () => {},
  );
  await monitor.refresh();
  for (const [columns, rows] of [
    [140, 48],
    [94, 24],
    [80, 24],
    [48, 12],
    [30, 6],
    [1, 1],
  ]) {
    const { frame } = renderMonitor(
      monitor,
      columns!,
      rows!,
      'fictícia',
      false,
    );
    assert.equal(frame.split('\r\n').length, rows);
    for (const line of frame.split('\r\n'))
      assert.equal(stringWidth(line), columns);
    if (columns! >= 48 && rows! >= 12) assert.match(frame, /q sair/);
  }
  monitor.help = true;
  const help = renderMonitor(monitor, 48, 12, 'fictícia', false).frame;
  assert.match(help, /Ctrl\+C sair/);
  assert.match(help, /Só leitura; não marca mensagens como lidas\./);
  assert.match(help, /Histórico local e parcial/);
  monitor.help = false;
  const full = renderMonitor(monitor, 140, 48, 'fictícia', false).frame;
  assert.match(full, /Mensagem apagada/);
  assert.match(full, /exclusão incerta/);
  assert.match(full, /Contato compartilhado/);
  assert.match(full, /↳ Podemos combinar/);
  assert.match(full, /\[Áudio\]/);
  assert.match(full, /Esta conta/);
  assert.doesNotMatch(
    full,
    /FICTIONAL_DELETED_BODY_EXCLUDED|FICTIONAL_SECRET_EXCLUDED/,
  );
  const narrow = renderMonitor(monitor, 80, 24, 'fictícia', false).frame;
  assert.match(narrow, /Conversas/);
  assert.doesNotMatch(narrow, /\[Áudio\]/);
  monitor.key('', { name: 'return' }, 12);
  assert.match(
    renderMonitor(monitor, 80, 40, 'fictícia', false).frame,
    /\[Áudio\]/,
  );
  const unicode = 'São 👩🏽‍💻 漢字 e\u0301';
  assert.equal(stringWidth(fit(unicode, 10)), 10);
  assert.ok(
    wrap(unicode.repeat(5), 10).every((line) => stringWidth(line) <= 10),
  );
  assert.ok(wrap('👩🏽‍💻', 4).includes('👩🏽‍💻'));
});

test('terminal content cannot execute ANSI/OSC controls or hide deletion boundaries', async () => {
  const attack =
    '\x1b[2J\x1b]52;c;FICTIONAL_CLIPBOARD\x07Olá\x00\x1b[31m\u202eevil\x1b[0m';
  assert.equal(terminalText(attack), 'Oláevil');
  const monitor = new Monitor(
    async (command) =>
      publicResponse(
        command.command === 'chats'
          ? [chat(pn, attack)]
          : command.command === 'messages'
            ? [
                { ...message('control'), text: attack },
                {
                  ...message('hidden'),
                  text: 'FICTIONAL_HIDDEN_BODY',
                  deletion: {
                    status: 'unknown',
                    source: 'chat-delete-boundary',
                    observedAt: 1,
                  },
                },
              ]
            : {},
      ),
    () => {},
  );
  await monitor.refresh();
  const { frame } = renderMonitor(monitor, 120, 30, attack, false);
  assert.equal(frame, stripVTControlCharacters(frame));
  assert.doesNotMatch(
    frame,
    /FICTIONAL_CLIPBOARD|FICTIONAL_HIDDEN_BODY|\u202e/,
  );
  assert.match(frame, /Oláevil/);
});

class TerminalInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) {
    this.isRaw = value;
  }
}
class TerminalOutput extends PassThrough {
  isTTY = true;
  columns = 120;
  rows = 30;
}

test('terminal cleanup restores raw mode, cursor and screen without stopping the offline daemon', async (t) => {
  const originalTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => {
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
  });
  const directory = mkdtempSync(join(tmpdir(), 'wcn-tui-'));
  const store = new Store(directory);
  store.observeChat({ id: pn, name: 'Conversa fictícia', unreadCount: 2 });
  store.observeMessage({
    key: { remoteJid: pn, id: 'fixture', fromMe: false },
    messageTimestamp: 1700000000,
    message: { conversation: 'Conferência offline fictícia' },
  });
  store.close();
  const cli = (...args: string[]) =>
    runFile(
      process.execPath,
      ['dist/src/cli.js', '--data-dir', directory, ...args],
      { timeout: 15000 },
    );
  t.after(async () => {
    await cli('stop');
  });
  await cli('start', '--offline');
  const before = await rpc(directory, { command: 'status' });
  const input = new TerminalInput();
  const output = new TerminalOutput();
  let screen = '';
  let frames = 0;
  output.on('data', (chunk: Buffer) => {
    screen += chunk.toString();
    if (chunk.toString().includes('Conferência offline fictícia')) {
      frames++;
      if (frames === 1) {
        output.columns = 80;
        queueMicrotask(() => output.emit('resize'));
      } else {
        queueMicrotask(() => input.write('q'));
      }
    } else if (frames === 1 && output.columns === 80) {
      queueMicrotask(() => input.write('\r'));
    }
  });
  await runMonitor({
    directory,
    label: 'fictícia',
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream,
    color: false,
  });
  assert.equal(input.isRaw, false);
  assert.equal(
    input.isPaused(),
    true,
    'stdin must not keep the process alive after q',
  );
  assert.ok(screen.startsWith(enterTerminal));
  assert.ok(screen.endsWith(leaveTerminal));
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(input.listenerCount('keypress'), 0);
  const after = await rpc(directory, { command: 'status' });
  assert.equal(after.pid, before.pid);
  const chats = await rpc(directory, {
    command: 'chats',
    limit: 100,
    offset: 0,
  });
  assert.equal((chats.data as { unread: boolean }[])[0]?.unread, true);
});

test('separate entrypoint offers help, validates account selectors and rejects pipes without ANSI output', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['dist/src/tui-cli.js', ...args], {
      encoding: 'utf8',
    });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /somente leitura/);
  for (const args of [
    [],
    ['--account', 'example', '--account', 'other'],
    ['--account', 'example', '--data-dir', '/fictional'],
    ['--send'],
    ['unexpected'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(stripVTControlCharacters(result.stderr), result.stderr);
    assert.doesNotMatch(result.stderr, /at .*\.js/);
  }
});
