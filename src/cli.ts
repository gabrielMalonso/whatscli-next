#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  configureObservability,
  Observability,
  obsAction,
  obsCode,
  queryObservability,
} from './observability.js';
import type { ObsFields, ObsQuery } from './observability.js';
import { commandFields, resultFields } from './observability-context.js';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dataDirectory, socketPath } from './paths.js';
import { rpc, RpcError } from './rpc.js';
import { object } from './protocol.js';
import type { Command } from './protocol.js';
import { formatResponse } from './response.js';
import { CommandError, errorResponse } from './errors.js';
import {
  checkPrivatePath,
  ensurePrivateDirectory,
  isMissing,
} from './private-paths.js';

process.umask(0o077);

const started = performance.now();
const root = randomBytes(16).toString('hex');
let observer: Observability | undefined;
const fields: ObsFields = { action: 'unknown' };
let suppress = false;
// Recover only an unambiguous explicit selector before parseArgs can reject another option.
// Unknown/missing option values do not become paths or action labels.
const argumentsBeforeTerminator = process.argv.slice(
  2,
  process.argv.indexOf('--', 2) < 0 ? undefined : process.argv.indexOf('--', 2),
);
const selectors = argumentsBeforeTerminator.flatMap<
  { path: string } | { account: string }
>((arg, index, args) => {
  const name = arg.split('=', 1)[0];
  if (name !== '--data-dir' && name !== '--account') return [];
  const value = arg.includes('=')
    ? arg.slice(arg.indexOf('=') + 1)
    : args[index + 1] && !args[index + 1]!.startsWith('-')
      ? args[index + 1]!
      : '';
  return [name === '--account' ? { account: value } : { path: value }];
});
if (selectors.length === 1) {
  try {
    observer = new Observability(dataDirectory(selectors[0]), 'cli');
  } catch {
    // Invalid selectors are reported as JSON by main, without touching another account.
  }
}
const call = (directory: string, command: Command, timeout?: number) =>
  rpc(
    directory,
    command,
    timeout,
    observer && !suppress ? { observer, root } : undefined,
  );

function options() {
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: {
        'data-dir': { type: 'string' },
        account: { type: 'string' },
        offline: { type: 'boolean' },
        'allow-jid': { type: 'string' },
        jid: { type: 'string' },
        key: { type: 'string' },
        text: { type: 'string' },
        file: { type: 'string' },
        mime: { type: 'string' },
        caption: { type: 'string' },
        out: { type: 'string' },
        id: { type: 'string' },
        participant: { type: 'string' },
        'from-me': { type: 'string' },
        query: { type: 'string' },
        'quote-id': { type: 'string' },
        'quote-from-me': { type: 'string' },
        'quote-participant': { type: 'string' },
        limit: { type: 'string' },
        offset: { type: 'string' },
        after: { type: 'string' },
        phone: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        origin: { type: 'string' },
        code: { type: 'string' },
        command: { type: 'string' },
        correlation: { type: 'string' },
        cursor: { type: 'string' },
        unread: { type: 'string' },
        archived: { type: 'string' },
        output: { type: 'string' },
        name: { type: 'string' },
      },
    });
    if (
      parsed.tokens.filter(
        (token) =>
          token.kind === 'option' &&
          (token.name === 'account' || token.name === 'data-dir'),
      ).length > 1
    )
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Use --account or --data-dir once; selectors cannot be repeated or combined',
      );
    return parsed;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      'INVALID_ARGUMENT',
      'Invalid command-line options; use help for the JSON command reference',
    );
  }
}

async function main(): Promise<Record<string, unknown>> {
  const { values, positionals } = options();
  const directory = dataDirectory({
    path: values['data-dir'],
    account: values.account,
  });
  if (observer?.directory !== directory)
    observer = new Observability(directory, 'cli');
  fields.action = obsAction(positionals[0] ?? 'help');
  suppress = positionals[0] === 'observability' && positionals[1] === 'query';
  const mode = values.output ?? 'full';
  if (mode !== 'full' && mode !== 'compact')
    throw new CommandError(
      'INVALID_ARGUMENT',
      '--output must be compact or full',
    );
  fields.output = mode;
  const response = await execute(values, positionals, directory);
  Object.assign(fields, resultFields(response.data));
  return formatResponse(positionals[0] ?? 'help', response, mode, values.jid);
}

async function execute(
  values: ReturnType<typeof options>['values'],
  positionals: string[],
  directory: string,
): Promise<Record<string, unknown>> {
  const action = positionals[0] ?? 'help';
  const required = (value: string | undefined, name: string): string => {
    if (!value)
      throw new CommandError('INVALID_ARGUMENT', `--${name} is required`);
    return value;
  };
  const only = (...allowed: string[]): void => {
    for (const key of Object.keys(values))
      if (
        key !== 'data-dir' &&
        key !== 'account' &&
        key !== 'output' &&
        !allowed.includes(key)
      )
        throw new CommandError(
          'INVALID_ARGUMENT',
          `--${key} is not valid for ${action}`,
        );
  };
  if (positionals.length > (['pair', 'observability'].includes(action) ? 2 : 1))
    throw new CommandError(
      'INVALID_ARGUMENT',
      'Unexpected positional arguments; use named options',
    );
  if (action === 'help')
    return {
      ok: true,
      data: {
        name: 'whatscli-next',
        output: 'JSON',
        commands: {
          start: '[--offline] [--allow-jid JID]',
          status: '',
          stop: '',
          backup: '--out NEW_PRIVATE_DIRECTORY (sensitive SQLite only)',
          'pair qr': '',
          'pair code': '--phone INTERNATIONAL_DIGITS',
          chats:
            '[--unread true|false|unknown] [--archived true|false|unknown] [--limit 100] [--offset 0]',
          chat: '--jid JID',
          resolve: '--phone +INTERNATIONAL_DIGITS',
          contact: '--jid PN_OR_LID_JID',
          messages: '--jid JID [--limit 20] [--offset 0]',
          search: '--query TEXT [--jid JID] [--limit 20] [--offset 0]',
          send: '--jid JID --key KEY --text TEXT [--quote-id MESSAGE_ID --quote-from-me true|false [--quote-participant JID]]',
          'send-file':
            '--jid JID --key KEY --file PATH [--mime MIME] [--caption TEXT]',
          'send-contact':
            '--jid JID --key KEY --name NAME --phone +INTERNATIONAL_DIGITS',
          download:
            '--jid JID --id MESSAGE_ID --out PATH [--from-me true|false] [--participant JID]',
          archive: '--jid JID --key KEY',
          unarchive: '--jid JID --key KEY',
          read: '--jid JID --key KEY',
          unread: '--jid JID --key KEY',
          request: '--key KEY',
          events: '[--after SEQUENCE]',
          group: '--jid GROUP_JID',
          reconnect: '',
          resync: '',
          'observability enable': '',
          'observability disable': '',
          'observability status': '',
          'observability query':
            '[--from UTC_ISO] [--to UTC_ISO] [--command ACTION] [--origin ORIGIN] [--code CODE] [--correlation ID] [--limit 100] [--cursor CURSOR]',
        },
        globalOption: '--account NAME | --data-dir PATH',
        outputOption: '--output compact|full (default: full)',
      },
    };
  if (action === 'observability') {
    const subcommand = positionals[1] ?? 'status';
    if (subcommand === 'query') {
      only(
        'from',
        'to',
        'command',
        'origin',
        'code',
        'correlation',
        'limit',
        'cursor',
      );
      const query: ObsQuery = {};
      for (const field of [
        'from',
        'to',
        'origin',
        'code',
        'correlation',
        'cursor',
      ] as const)
        if (values[field] !== undefined) query[field] = values[field];
      if (values.command !== undefined) query.action = values.command;
      if (values.limit !== undefined) query.limit = Number(values.limit);
      return { ok: true, data: queryObservability(directory, query) };
    }
    only();
    if (!['enable', 'disable', 'status'].includes(subcommand))
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Use observability enable, disable, status or query',
      );
    if (
      subcommand === 'enable' ||
      subcommand === 'disable' ||
      subcommand === 'status'
    )
      fields.operation = subcommand;
    if (subcommand === 'disable')
      observer?.record('command', {
        action: 'observability',
        operation: 'disable',
        phase: 'requested',
      });
    if (subcommand !== 'status')
      configureObservability(directory, subcommand === 'enable');
    const local = new Observability(directory, 'cli').status();
    try {
      // Configuration is already durable. Legacy/refusing/unreachable daemons cannot be claimed effective.
      const response = await rpc(
        directory,
        { command: 'observability' },
        1000,
        undefined,
        false,
      );
      return {
        ok: true,
        data: {
          ...local,
          effective:
            response.ok === true
              ? (object(response.data).effective ?? 'unknown')
              : 'unknown',
          daemon:
            response.ok === true
              ? response.data
              : { effective: 'unknown', code: obsCode(response.code) },
        },
      };
    } catch (error) {
      const code = errorResponse(error).code;
      return {
        ok: true,
        data: {
          ...local,
          effective: code === 'NOT_RUNNING' ? false : 'unknown',
          daemon: {
            effective: code === 'NOT_RUNNING' ? false : 'unknown',
            code,
          },
        },
      };
    }
  }
  if (action === 'start') {
    only('offline', 'allow-jid');
    socketPath(directory);
    const checkConfiguration = (status: Record<string, unknown>): void => {
      const data = object(status.data);
      if (
        (values.offline && data.networkEnabled !== false) ||
        (values['allow-jid'] && data.allowedJid !== values['allow-jid'])
      ) {
        throw new CommandError(
          'PRECONDITION_FAILED',
          'Daemon is already running with different options; stop it before changing its configuration',
        );
      }
    };
    try {
      const status = await call(directory, { command: 'status' }, 1000);
      checkConfiguration(status);
      return { ...status, alreadyRunning: true };
    } catch (error) {
      if (!(error instanceof RpcError && error.code === 'NOT_RUNNING'))
        throw error;
    }
    ensurePrivateDirectory(directory);
    const log = join(directory, 'daemon.log');
    try {
      checkPrivatePath(log, 'file');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const fd = openSync(
      log,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    const logStat = fstatSync(fd);
    if (
      !logStat.isFile() ||
      logStat.uid !== process.getuid?.() ||
      logStat.mode & 0o077
    ) {
      closeSync(fd);
      throw new CommandError(
        'PRECONDITION_FAILED',
        'Existing daemon.log must be an owned private file',
      );
    }
    const args = [
      fileURLToPath(new URL('./daemon.js', import.meta.url)),
      '--data-dir',
      directory,
    ];
    if (values.offline) args.push('--offline');
    if (values['allow-jid']) args.push('--allow-jid', values['allow-jid']);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', 'ignore', fd],
    });
    closeSync(fd);
    let launchError: Error | undefined;
    child.once('error', (error) => {
      launchError = error;
    });
    child.unref();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const status = await call(directory, { command: 'status' }, 500);
        checkConfiguration(status);
        return { ...status, logPath: log };
      } catch (error) {
        if (!(error instanceof RpcError && error.code === 'NOT_RUNNING'))
          throw error;
      }
      if (launchError || child.exitCode !== null)
        throw new CommandError(
          'UNKNOWN',
          'Daemon could not start; inspect daemon.log in the selected data directory',
        );
      await delay(100);
    }
    throw new CommandError(
      'UNKNOWN',
      'Daemon startup timed out; inspect daemon.log in the selected data directory',
    );
  }
  let command: Command;
  const jid = (): string => required(values.jid, 'jid');
  const key = (): string => required(values.key, 'key');
  switch (action) {
    case 'backup':
      only('out');
      command = { command: action, path: resolve(required(values.out, 'out')) };
      break;
    case 'status':
    case 'stop':
    case 'reconnect':
    case 'resync':
    case 'drop-connection':
      only();
      command = { command: action };
      break;
    case 'pair':
      if (positionals[1] === 'qr') {
        only();
        command = { command: 'pair-qr' };
      } else if (positionals[1] === 'code') {
        only('phone');
        command = {
          command: 'pair-code',
          phone: required(values.phone, 'phone'),
        };
      } else
        throw new CommandError(
          'INVALID_ARGUMENT',
          'Use pair qr or pair code --phone INTERNATIONAL_DIGITS',
        );
      break;
    case 'chats': {
      only('limit', 'offset', 'unread', 'archived');
      command = {
        command: 'chats',
        limit: Number(values.limit ?? 100),
        offset: Number(values.offset ?? 0),
      };
      for (const field of ['unread', 'archived'] as const) {
        const state = values[field];
        if (state === undefined) continue;
        if (!['true', 'false', 'unknown'].includes(state))
          throw new CommandError(
            'INVALID_ARGUMENT',
            `--${field} must be true, false or unknown`,
          );
        command[field] = state === 'unknown' ? state : state === 'true';
      }
      break;
    }
    case 'chat':
    case 'group':
    case 'contact':
      only('jid');
      command = { command: action, jid: jid() };
      break;
    case 'resolve':
      only('phone');
      command = { command: action, phone: required(values.phone, 'phone') };
      break;
    case 'messages':
      only('jid', 'limit', 'offset');
      command = {
        command: action,
        jid: jid(),
        limit: Number(values.limit ?? 20),
        offset: Number(values.offset ?? 0),
      };
      break;
    case 'search':
      only('jid', 'query', 'limit', 'offset');
      command = {
        command: action,
        query: required(values.query, 'query'),
        ...(values.jid ? { jid: values.jid } : {}),
        limit: Number(values.limit ?? 20),
        offset: Number(values.offset ?? 0),
      };
      break;
    case 'send': {
      only(
        'jid',
        'key',
        'text',
        'quote-id',
        'quote-from-me',
        'quote-participant',
      );
      const quoted = ['quote-id', 'quote-from-me', 'quote-participant'].some(
        (field) => field in values,
      );
      if (
        quoted &&
        !['true', 'false'].includes(
          required(values['quote-from-me'], 'quote-from-me'),
        )
      )
        throw new CommandError(
          'INVALID_ARGUMENT',
          '--quote-from-me must be true or false',
        );
      command = {
        command: action,
        jid: jid(),
        key: key(),
        text: required(values.text, 'text'),
        ...(quoted
          ? {
              quote: {
                id: required(values['quote-id'], 'quote-id'),
                fromMe: values['quote-from-me'] === 'true',
                ...(values['quote-participant'] === undefined
                  ? {}
                  : { participant: values['quote-participant'] }),
              },
            }
          : {}),
      };
      break;
    }
    case 'send-contact':
      only('jid', 'key', 'name', 'phone');
      command = {
        command: action,
        jid: jid(),
        key: key(),
        name: required(values.name, 'name'),
        phone: required(values.phone, 'phone'),
      };
      break;
    case 'send-file':
      only('jid', 'key', 'file', 'mime', 'caption');
      command = {
        command: action,
        jid: jid(),
        key: key(),
        path: resolve(required(values.file, 'file')),
        mime: values.mime ?? 'application/octet-stream',
        caption: values.caption ?? '',
      };
      break;
    case 'download':
      only('jid', 'id', 'out', 'from-me', 'participant');
      if (
        values['from-me'] !== undefined &&
        !['true', 'false'].includes(values['from-me'])
      )
        throw new CommandError(
          'INVALID_ARGUMENT',
          '--from-me must be true or false',
        );
      command = {
        command: action,
        jid: jid(),
        messageId: required(values.id, 'id'),
        path: resolve(required(values.out, 'out')),
        ...(values['from-me'] === undefined
          ? {}
          : { fromMe: values['from-me'] === 'true' }),
        ...(values.participant ? { participant: values.participant } : {}),
      };
      break;
    case 'archive':
    case 'unarchive':
    case 'read':
    case 'unread':
      only('jid', 'key');
      command = {
        command: ['archive', 'unarchive'].includes(action)
          ? 'archive'
          : 'mark-read',
        jid: jid(),
        key: key(),
        value: action === 'archive' || action === 'read',
      };
      break;
    case 'request':
      only('key');
      command = { command: action, key: key() };
      break;
    case 'events':
      only('after');
      command = { command: action, after: Number(values.after ?? 0) };
      break;
    default:
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Unknown command; use help for the JSON command reference',
      );
  }
  if (observer)
    Object.assign(fields, commandFields(observer, command), {
      action: obsAction(action),
    });
  let response: Record<string, unknown>;
  try {
    response = await call(directory, command);
  } catch (error) {
    if (
      error instanceof RpcError &&
      error.code === 'NOT_RUNNING' &&
      ['status', 'stop'].includes(action)
    )
      return {
        ok: true,
        running: false,
        data: { running: false, alreadyStopped: action === 'stop' },
      };
    throw error;
  }
  if (action === 'stop' && response.ok === true) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        await call(directory, { command: 'status' }, 500);
      } catch (error) {
        if (error instanceof RpcError && error.code === 'NOT_RUNNING')
          return { ...response, running: false };
      }
      await delay(100);
    }
    throw new CommandError(
      'PRECONDITION_FAILED',
      'Stop was requested, but shutdown has not completed; no process was killed',
    );
  }
  return response;
}

async function finish(result: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify(result) + '\n';
  process.stdout.write(line);
  if (result.ok === false) process.exitCode = 1;
  if (!suppress && observer) {
    const correlation = observer.opaque('correlation', root);
    observer.record('command', {
      ...fields,
      ...(correlation ? { correlation } : {}),
      durationMs: performance.now() - started,
      stdoutBytes: Buffer.byteLength(line),
      ok: result.ok === true,
      code: result.ok === true ? 'OK' : obsCode(result.code),
    });
    if (!observer.enabled) observer.maintain();
    await observer.close();
  }
}
main()
  .then(finish)
  .catch((error) => finish(errorResponse(error)));
