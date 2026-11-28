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
import { expectedAccount } from './identity.js';
import { rpc, RpcError } from './rpc.js';
import {
  chatIncludes,
  eventKind,
  needsFilteredChats,
  object,
} from './protocol.js';
import { chatKind, chatKinds } from './identity.js';
import { MAX_WAIT_ACK_MS } from './protocol.js';
import type { AckWaitOption, Command } from './protocol.js';
import { formatResponse } from './response.js';
import {
  CommandError,
  errorResponse,
  errorSummary,
  runtimeExitCode,
} from './errors.js';
import { writeDiagnostic } from './diagnostics.js';
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
// --foreground exits with runtime statuses that supervisors can act on, even for option errors.
const foreground = argumentsBeforeTerminator.includes('--foreground');
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
const call = (
  directory: string,
  command: Command,
  timeout?: number,
  expectAccount?: string,
) =>
  rpc(
    directory,
    command,
    timeout,
    observer && !suppress ? { observer, root } : undefined,
    true,
    expectAccount,
  );

const optionSpec = {
  'data-dir': { type: 'string' },
  account: { type: 'string' },
  'expect-account': { type: 'string' },
  offline: { type: 'boolean' },
  foreground: { type: 'boolean' },
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
  tail: { type: 'string' },
  kind: { type: 'string' },
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
  'observed-only': { type: 'boolean' },
  output: { type: 'string' },
  name: { type: 'string' },
  'wait-ack-ms': { type: 'string' },
  'if-latest-incoming': { type: 'string' },
  include: { type: 'string' },
} as const;

function options() {
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: optionSpec,
    });
    if (
      parsed.tokens.filter(
        (token) => token.kind === 'option' && token.name === 'expect-account',
      ).length > 1
    )
      throw new CommandError(
        'INVALID_ARGUMENT',
        'Use --expect-account once; it cannot be repeated',
      );
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

// A string option written without `=` consumes the next argument as its value,
// so `--text -h` sends the text "-h" rather than requesting help.
const helpRequested = (() => {
  for (let index = 0; index < argumentsBeforeTerminator.length; index++) {
    const arg = argumentsBeforeTerminator[index]!;
    if (arg === '--help' || arg === '-h') return true;
    const name = arg.startsWith('--') && !arg.includes('=') ? arg.slice(2) : '';
    if (
      Object.hasOwn(optionSpec, name) &&
      optionSpec[name as keyof typeof optionSpec].type === 'string'
    )
      index++;
  }
  return false;
})();

/** The JSON command reference, also returned for --help and -h anywhere before --. */
function help(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      name: 'whatscli-next',
      output: 'JSON',
      commands: {
        start:
          '[--foreground] [--offline] [--allow-jid JID] (--foreground runs the daemon in this process until it stops; lifecycle lines on stderr, one JSON result on stdout at exit)',
        status: '',
        stop: '',
        backup: '--out NEW_PRIVATE_DIRECTORY (sensitive SQLite only)',
        'pair qr': '',
        'pair code': '--phone INTERNATIONAL_DIGITS',
        chats:
          '[--unread true|false|unknown|not-true] [--archived true|false|unknown|not-true] [--observed-only] [--kind all|direct,group,broadcast,other] [--include contact,last-message] [--limit 100] [--offset 0]',
        chat: '--jid JID',
        resolve: '--phone +INTERNATIONAL_DIGITS',
        contact: '--jid PN_OR_LID_JID',
        contacts:
          '--query TEXT [--limit 20] [--offset 0] (read-only lookup of observed labels and known phone numbers; never addressing or authorization)',
        messages: '--jid JID [--limit 20] [--offset 0]',
        incoming:
          '--jid JID [--after MESSAGE_ID|none] [--limit 20] (read-only; incoming user messages stored after that one, oldest first)',
        search: '--query TEXT [--jid JID] [--limit 20] [--offset 0]',
        send: '--jid JID --key KEY --text TEXT [--quote-id MESSAGE_ID --quote-from-me true|false [--quote-participant JID]] [--wait-ack-ms MS]',
        'send-file':
          '--jid JID --key KEY --file PATH [--mime MIME] [--caption TEXT] [--wait-ack-ms MS]',
        'send-contact':
          '--jid JID --key KEY --name NAME --phone +INTERNATIONAL_DIGITS [--wait-ack-ms MS]',
        download:
          '--jid JID --id MESSAGE_ID --out PATH [--from-me true|false] [--participant JID]',
        archive: '--jid JID --key KEY [--if-latest-incoming MESSAGE_ID|none]',
        unarchive: '--jid JID --key KEY [--if-latest-incoming MESSAGE_ID|none]',
        read: '--jid JID --key KEY [--if-latest-incoming MESSAGE_ID|none]',
        unread: '--jid JID --key KEY [--if-latest-incoming MESSAGE_ID|none]',
        request: '--key KEY',
        events:
          '[--after SEQUENCE] [--tail 1-100] [--kind KIND] (ascending; --tail returns the latest N)',
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
      expectAccountOption:
        '--expect-account PHONE_DIGITS|PN_JID (every command that talks to the daemon). The daemon compares the phone-number user part of its linked account JID, ignoring any device suffix, before any read, write or SDK call; otherwise ACCOUNT_MISMATCH (including when no account is linked) and nothing is done. A LID is not accepted. Success output is unchanged. A daemon that predates the check rejects it (PROTOCOL); restart it with this build. Refused by start and observability; help ignores it; status and stop still report running: false without a daemon. Replaces a separate status call before each command.',
      outputOption: '--output compact|full (default: full)',
      waitAckOption: `--wait-ack-ms 0..${MAX_WAIT_ACK_MS} (send, send-file, send-contact; default 0 responds at SDK return). Waits for locally observed server acceptance or an observed error, never resends; data.wait.outcome is accepted, error, timeout or interrupted. Agents: 5000. request --key remains the source of truth for later acceptance, delivery and read.`,
      ifLatestIncomingOption:
        '--if-latest-incoming MESSAGE_ID|none (archive, unarchive, read, unread). Proceeds only if chat --jid data.latestIncoming.id is that ID (none: null) and no counted message in the chat is unavailable, checked in the daemon immediately before the intent is persisted and the patch is built. Otherwise PRECONDITION_FAILED and nothing changes: read incoming --jid JID --after THAT_ID, repeat with --after the last listed ID while truncated, then retry with the last ID of the final page. Latest means most recently stored by this runtime, not newest timestamp; a message that gets content later moves to a fresh position. Local coverage only. Excludes own messages, protocol stubs, edits and reactions; missed calls, call logs, unrecognized and undecryptable content count. Refused with unavailable-incoming while any counted message in the chat has available: false; do not proceed until those are available. On success feedback.latestIncomingChanged: true means a message arrived during or after the mutation; read incoming --after the guarded ID, never repeat the command. A daemon without the guard rejects it; a guarded success without latestIncomingChanged is reported as PROTOCOL. Part of the key intent; a replay never re-checks it. none cannot name a message whose ID is literally none.',
      kindOption:
        '--kind (chats): comma-separated direct (exact PN or LID JID), group (@g.us), broadcast (@broadcast, including status@broadcast), other; default all. Example: --kind direct excludes groups and status.',
      includeOption:
        '--include (chats): comma-separated contact, last-message. contact: {phone, mapping, labels[{field, value, jid, source, observedAt}]} for PN/LID rows, null otherwise; phone only from a PN JID or a known mapping, never from LID digits; labels are observed display hints, not identity. lastMessage: {id, fromMe, timestamp, contentType} of the newest stored person message (reactions, protocol and edit envelopes and stubs skipped), or null; no text. Decide attention from latestIncoming, not lastMessage.fromMe alone. A daemon without these options rejects them (PROTOCOL).',
      helpOption: '--help | -h (anywhere before --; same reference as help)',
    },
  };
}

async function main(): Promise<Record<string, unknown>> {
  if (helpRequested) {
    // Answer before option parsing, so a help flag never becomes INVALID_ARGUMENT.
    fields.action = 'help';
    return formatResponse('help', help(), 'full');
  }
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
  return formatResponse(positionals[0] ?? 'help', response, mode);
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
        key !== 'expect-account' &&
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
  if (action === 'help') return help();
  // Validated before any I/O. Local-only commands cannot check the linked account.
  const expectAccount =
    values['expect-account'] === undefined
      ? undefined
      : expectedAccount(values['expect-account']);
  if (
    expectAccount !== undefined &&
    (action === 'start' || action === 'observability')
  )
    throw new CommandError(
      'INVALID_ARGUMENT',
      `--expect-account is not valid for ${action}; check the account with status --expect-account`,
    );
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
    only('offline', 'allow-jid', 'foreground');
    socketPath(directory);
    if (values.foreground) {
      // The writer lock refuses a second runtime exactly as for the background daemon.
      const { runDaemon } = await import('./daemon.js');
      let stopped: Promise<string>;
      try {
        ({ stopped } = await runDaemon({
          dataDir: directory,
          offline: values.offline === true,
          allowJid: values['allow-jid'],
        }));
      } catch (error) {
        // The same startup error line the background daemon writes to daemon.log.
        writeDiagnostic(errorSummary(error));
        throw error;
      }
      // A cleanup failure is already logged as shutdown-failed.
      const reason = await stopped;
      return {
        ok: true,
        running: false,
        data: { running: false, foreground: true, reason },
      };
    }
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
  // Response option only. Zero or absence sends the unchanged command.
  const waitAck = (): AckWaitOption => {
    const value = values['wait-ack-ms'];
    if (value === undefined) return {};
    if (!/^\d{1,5}$/.test(value) || Number(value) > MAX_WAIT_ACK_MS)
      throw new CommandError(
        'INVALID_ARGUMENT',
        `--wait-ack-ms must be an integer from 0 to ${MAX_WAIT_ACK_MS}`,
      );
    const waitAckMs = Number(value);
    return waitAckMs === 0 ? {} : { waitAckMs };
  };
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
      only(
        'limit',
        'offset',
        'unread',
        'archived',
        'observed-only',
        'kind',
        'include',
      );
      const listOption = <T extends string>(
        name: 'kind' | 'include',
        allowed: readonly T[],
      ): T[] | undefined => {
        const value = values[name];
        if (value === undefined || (name === 'kind' && value === 'all'))
          return undefined;
        const items = value.split(',');
        if (
          !items.every((item) => allowed.includes(item as T)) ||
          new Set(items).size !== items.length
        )
          throw new CommandError(
            'INVALID_ARGUMENT',
            `--${name} must be ${name === 'kind' ? 'all or ' : ''}a comma-separated list of ${allowed.join(', ')}`,
          );
        return items as T[];
      };
      const kinds = listOption('kind', chatKinds);
      const include = listOption('include', chatIncludes);
      command = {
        command: 'chats',
        limit: Number(values.limit ?? 100),
        offset: Number(values.offset ?? 0),
        ...(values['observed-only'] === undefined
          ? {}
          : { observedOnly: values['observed-only'] }),
        ...(kinds ? { kinds } : {}),
        ...(include ? { include } : {}),
      };
      for (const field of ['unread', 'archived'] as const) {
        const state = values[field];
        if (state === undefined) continue;
        if (!['true', 'false', 'unknown', 'not-true'].includes(state))
          throw new CommandError(
            'INVALID_ARGUMENT',
            `--${field} must be true, false, unknown or not-true`,
          );
        command[field] =
          state === 'unknown' || state === 'not-true'
            ? state
            : state === 'true';
      }
      break;
    }
    case 'chat':
    case 'group':
    case 'contact':
      only('jid');
      command = { command: action, jid: jid() };
      break;
    case 'contacts':
      only('query', 'limit', 'offset');
      command = {
        command: action,
        query: required(values.query, 'query'),
        limit: Number(values.limit ?? 20),
        offset: Number(values.offset ?? 0),
      };
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
    case 'incoming':
      only('jid', 'after', 'limit');
      command = {
        command: action,
        jid: jid(),
        afterId:
          values.after === undefined || values.after === 'none'
            ? null
            : required(values.after, 'after'),
        limit: Number(values.limit ?? 20),
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
        'wait-ack-ms',
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
        ...waitAck(),
      };
      break;
    }
    case 'send-contact':
      only('jid', 'key', 'name', 'phone', 'wait-ack-ms');
      command = {
        command: action,
        jid: jid(),
        key: key(),
        name: required(values.name, 'name'),
        phone: required(values.phone, 'phone'),
        ...waitAck(),
      };
      break;
    case 'send-file':
      only('jid', 'key', 'file', 'mime', 'caption', 'wait-ack-ms');
      command = {
        command: action,
        jid: jid(),
        key: key(),
        path: resolve(required(values.file, 'file')),
        mime: values.mime ?? 'application/octet-stream',
        caption: values.caption ?? '',
        ...waitAck(),
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
      only('jid', 'key', 'if-latest-incoming');
      command = {
        command: ['archive', 'unarchive'].includes(action)
          ? 'archive'
          : 'mark-read',
        jid: jid(),
        key: key(),
        value: action === 'archive' || action === 'read',
        ...(values['if-latest-incoming'] === undefined
          ? {}
          : {
              ifLatestIncoming:
                values['if-latest-incoming'] === 'none'
                  ? null
                  : required(
                      values['if-latest-incoming'],
                      'if-latest-incoming',
                    ),
            }),
      };
      break;
    case 'request':
      only('key');
      command = { command: action, key: key() };
      break;
    case 'events': {
      only('after', 'tail', 'kind');
      if (
        values.tail !== undefined &&
        !(/^\d+$/.test(values.tail) && +values.tail >= 1 && +values.tail <= 100)
      )
        throw new CommandError(
          'INVALID_ARGUMENT',
          '--tail must be an integer from 1 to 100',
        );
      if (
        values.after !== undefined &&
        !(/^\d+$/.test(values.after) && Number.isSafeInteger(+values.after))
      )
        throw new CommandError(
          'INVALID_ARGUMENT',
          '--after must be a non-negative integer event sequence',
        );
      if (values.kind !== undefined && !eventKind.test(values.kind))
        throw new CommandError(
          'INVALID_ARGUMENT',
          '--kind must be an event kind such as connection or messages.upsert',
        );
      command = {
        command: action,
        after: Number(values.after ?? 0),
        ...(values.tail === undefined ? {} : { tail: Number(values.tail) }),
        ...(values.kind === undefined ? {} : { kind: values.kind }),
      };
      break;
    }
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
    response = await call(directory, command, undefined, expectAccount);
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
  if (
    (command.command === 'archive' || command.command === 'mark-read') &&
    command.ifLatestIncoming !== undefined &&
    response.ok === true &&
    typeof (
      response.data as
        { feedback?: { latestIncomingChanged?: unknown } } | null | undefined
    )?.feedback?.latestIncomingChanged !== 'boolean'
  )
    // Defense in depth: a daemon without the guard rejects the guarded wire name.
    throw new CommandError(
      'PROTOCOL',
      'The daemon did not confirm the incoming-message guard; the change may have been applied unguarded. Inspect request --key and restart the daemon with this build',
    );
  if (
    expectAccount !== undefined &&
    response.ok === false &&
    response.code === 'INVALID_ARGUMENT' &&
    response.error === 'Unknown command'
  )
    // A daemon that predates the check refuses the wrapper before executing anything.
    throw new CommandError(
      'PROTOCOL',
      'The daemon rejected the request as an unknown command; it may predate --expect-account or another option of this command. Nothing was done; restart the daemon with this build',
    );
  if (
    needsFilteredChats(command) &&
    response.ok === false &&
    response.code === 'INVALID_ARGUMENT' &&
    response.error === 'Unknown command'
  )
    // A daemon that predates --kind/--include rejects filtered-chats.
    throw new CommandError(
      'PROTOCOL',
      'The daemon does not support chats --kind or --include; restart it with this build',
    );
  if (command.command === 'chats' && response.ok === true)
    // Defense in depth: every row must match the kinds and carry the included fields.
    checkChatsResponse(command, response.data);
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

/** A daemon built before --kind/--include ignores them; never present its rows as filtered or enriched. */
function checkChatsResponse(
  command: Extract<Command, { command: 'chats' }>,
  data: unknown,
): void {
  if (!Array.isArray(data)) return;
  const fields = (command.include ?? []).map((item) =>
    item === 'contact' ? 'contact' : 'lastMessage',
  );
  for (const value of data) {
    const row: Record<string, unknown> =
      value !== null && typeof value === 'object' ? value : {};
    if (
      (command.kinds &&
        !(
          typeof row.jid === 'string' &&
          command.kinds.includes(chatKind(row.jid))
        )) ||
      fields.some((field) => !(field in row))
    )
      throw new CommandError(
        'PROTOCOL',
        'The daemon did not apply --kind or --include; restart it with this build',
      );
  }
}

async function finish(
  result: Record<string, unknown>,
  error?: unknown,
): Promise<void> {
  const line = JSON.stringify(result) + '\n';
  process.stdout.write(line);
  if (result.ok === false)
    process.exitCode = foreground ? runtimeExitCode(error) : 1;
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
  .catch((error) => finish(errorResponse(error), error));
