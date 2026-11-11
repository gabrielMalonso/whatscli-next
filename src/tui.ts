import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { CommandError } from './errors.js';
import { rpc } from './rpc.js';
import { Monitor } from './tui-model.js';
import type { MonitorRead } from './tui-model.js';
import { renderMonitor } from './tui-view.js';

export const enterTerminal = '\x1b[?1049h\x1b[?25l\x1b[?7l';
export const leaveTerminal = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';

export async function runMonitor({
  directory,
  label,
  input = process.stdin,
  output = process.stdout,
  read = (command) => rpc(directory, command, 1500, undefined, false),
  color = process.env.NO_COLOR === undefined,
}: {
  directory: string;
  label: string;
  input?: ReadStream;
  output?: WriteStream;
  read?: MonitorRead;
  color?: boolean;
}): Promise<void> {
  if (!input.isTTY || !output.isTTY || process.env.TERM === 'dumb')
    throw new CommandError(
      'PRECONDITION_FAILED',
      'A TUI precisa de um terminal interativo; use ssh -t para acessá-la remotamente.',
    );
  let closed = false;
  let finish: () => void;
  let fail: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const draw = () => {
    if (closed || output.destroyed) return;
    try {
      const view = renderMonitor(
        monitor,
        output.columns || 80,
        output.rows || 24,
        label,
        color,
      );
      monitor.maxScroll = view.maxScroll;
      monitor.scroll = Math.min(monitor.scroll, view.maxScroll);
      output.write('\x1b[H' + view.frame);
    } catch {
      fail(
        new CommandError(
          'LOCAL_STATE',
          'Não foi possível atualizar a tela do terminal.',
        ),
      );
    }
  };
  const monitor = new Monitor(read, draw);
  const onKey = (text: string, key: Key) => {
    if (monitor.key(text ?? '', key, Math.max(1, (output.rows || 24) - 10)))
      finish();
  };
  const onExit = () => finish();
  const onError = () =>
    fail(new CommandError('LOCAL_STATE', 'O terminal foi desconectado.'));
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    input.on('end', onExit);
    input.on('close', onExit);
    input.on('error', onError);
    output.on('resize', draw);
    output.on('error', onError);
    output.on('close', onExit);
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
    process.on('SIGHUP', onExit);
    output.write(enterTerminal);
    draw();
    void monitor.refresh();
    timer = setInterval(() => void monitor.refresh(), 2000);
    await finished;
  } finally {
    closed = true;
    monitor.stop();
    clearInterval(timer);
    input.off('keypress', onKey);
    input.off('end', onExit);
    input.off('close', onExit);
    input.off('error', onError);
    output.off('resize', draw);
    output.off('close', onExit);
    process.off('SIGINT', onExit);
    process.off('SIGTERM', onExit);
    process.off('SIGHUP', onExit);
    try {
      input.setRawMode(wasRaw);
      if (!output.destroyed)
        await new Promise<void>((resolve) =>
          output.write(leaveTerminal, () => resolve()),
        );
    } finally {
      output.off('error', onError);
      if (wasFlowing !== true) input.pause();
    }
  }
}
