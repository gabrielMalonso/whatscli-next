#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CommandError, errorResponse } from './errors.js';
import { dataDirectory, socketPath } from './paths.js';
import { runMonitor } from './tui.js';

process.umask(0o077);

try {
  const { values, tokens } = parseArgs({
    tokens: true,
    options: {
      account: { type: 'string' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Uso: whatscli-tui [--account NOME | --data-dir CAMINHO]\n\nMonitor somente leitura. Não inicia nem encerra o runtime.\nUse a CLI para iniciar a conta antes de abrir a TUI.\n\nTab alternar áreas; ↑↓ navegar; / filtrar conversas; ? ajuda; q sair.\nAcesso remoto: ssh -t HOST <comando-da-tui>\n',
    );
  } else {
    if (
      tokens.filter(
        (token) =>
          token.kind === 'option' &&
          ['account', 'data-dir'].includes(token.name),
      ).length > 1
    )
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Use --account ou --data-dir uma única vez.',
      );
    const directory = dataDirectory({
      account: values.account,
      path: values['data-dir'],
    });
    socketPath(directory);
    await runMonitor({
      directory,
      label:
        values.account?.toLowerCase() ??
        (values['data-dir'] ? 'diretório selecionado' : 'conta padrão'),
    });
  }
} catch (error) {
  const response = errorResponse(error);
  process.stderr.write(
    `${error instanceof TypeError ? 'Opções inválidas; use --help.' : response.error}\n`,
  );
  process.exitCode = 1;
}
