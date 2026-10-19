#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dataDirectory, socketPath } from './paths.js';
import { rpc, RpcError } from './rpc.js';
import { object } from './protocol.js';
import type { Command } from './protocol.js';
import { formatResponse } from './response.js';

process.umask(0o077);

function options() {
  return parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, offline: { type: 'boolean' }, 'allow-jid': { type: 'string' },
    jid: { type: 'string' }, key: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' },
    mime: { type: 'string' }, caption: { type: 'string' }, out: { type: 'string' }, id: { type: 'string' },
    participant: { type: 'string' }, 'from-me': { type: 'string' }, query: { type: 'string' },
    limit: { type: 'string' }, offset: { type: 'string' }, after: { type: 'string' }, phone: { type: 'string' },
    unread: { type: 'string' }, archived: { type: 'string' }, output: { type: 'string' }, name: { type: 'string' },
  } });
}

async function main(): Promise<Record<string, unknown>> {
  const { values, positionals } = options();
  const mode = values.output ?? 'full';
  if (mode !== 'full' && mode !== 'compact') throw new Error('--output must be compact or full');
  const response = await execute(values, positionals);
  return formatResponse(positionals[0] ?? 'help', response, mode, values.jid);
}

async function execute(values: ReturnType<typeof options>['values'], positionals: string[]): Promise<Record<string, unknown>> {
  const action = positionals[0] ?? 'help';
  const directory = dataDirectory(values['data-dir']);
  const required = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const only = (...allowed: string[]): void => {
    for (const key of Object.keys(values)) if (key !== 'data-dir' && key !== 'output' && !allowed.includes(key)) throw new Error(`--${key} is not valid for ${action}`);
  };
  if (positionals.length > (action === 'pair' ? 2 : 1)) throw new Error('Unexpected positional arguments; use named options');
  if (action === 'help') return { ok: true, data: {
    name: 'whatscli-next', output: 'JSON',
    commands: {
      start: '[--offline] [--allow-jid JID]', status: '', stop: '',
      'pair qr': '', 'pair code': '--phone INTERNATIONAL_DIGITS',
      chats: '[--unread true|false|unknown] [--archived true|false|unknown] [--limit 100] [--offset 0]', chat: '--jid JID',
      resolve: '--phone +INTERNATIONAL_DIGITS', contact: '--jid PN_OR_LID_JID',
      messages: '--jid JID [--limit 20] [--offset 0]', search: '--query TEXT [--jid JID] [--limit 20] [--offset 0]',
      send: '--jid JID --key KEY --text TEXT', 'send-file': '--jid JID --key KEY --file PATH [--mime MIME] [--caption TEXT]',
      'send-contact': '--jid JID --key KEY --name NAME --phone +INTERNATIONAL_DIGITS',
      download: '--jid JID --id MESSAGE_ID --out PATH [--from-me true|false] [--participant JID]',
      archive: '--jid JID --key KEY', unarchive: '--jid JID --key KEY', read: '--jid JID --key KEY', unread: '--jid JID --key KEY',
      request: '--key KEY', events: '[--after SEQUENCE]', group: '--jid GROUP_JID', reconnect: '', resync: '',
    }, globalOption: '--data-dir PATH', outputOption: '--output compact|full (default: full)',
  } };
  if (action === 'start') {
    only('offline', 'allow-jid');
    socketPath(directory);
    const checkConfiguration = (status: Record<string, unknown>): void => {
      const data = object(status.data);
      if ((values.offline && data.networkEnabled !== false) || (values['allow-jid'] && data.allowedJid !== values['allow-jid'])) {
        throw new Error('Daemon is already running with different options; stop it before changing its configuration');
      }
    };
    try {
      const status = await rpc(directory, { command: 'status' }, 1000);
      checkConfiguration(status);
      return { ...status, alreadyRunning: true };
    }
    catch (error) { if (!(error instanceof RpcError && error.code === 'NOT_RUNNING')) throw error; }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Data directory must be owned and private (0700)');
    const log = join(directory, 'daemon.log');
    const fd = openSync(log, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const logStat = lstatSync(log);
    if (!logStat.isFile() || logStat.uid !== process.getuid?.() || (logStat.mode & 0o077)) { closeSync(fd); throw new Error('Existing daemon.log must be an owned private file'); }
    const args = [fileURLToPath(new URL('./daemon.js', import.meta.url)), '--data-dir', directory];
    if (values.offline) args.push('--offline');
    if (values['allow-jid']) args.push('--allow-jid', values['allow-jid']);
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'ignore', fd] });
    closeSync(fd);
    let launchError: Error | undefined;
    child.once('error', error => { launchError = error; });
    child.unref();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const status = await rpc(directory, { command: 'status' }, 500);
        checkConfiguration(status);
        return { ...status, logPath: log };
      }
      catch (error) { if (!(error instanceof RpcError && error.code === 'NOT_RUNNING')) throw error; }
      if (launchError || child.exitCode !== null) throw new Error(`Daemon could not start; inspect ${log}`);
      await delay(100);
    }
    throw new Error(`Daemon startup timed out; inspect ${log}`);
  }
  let command: Command;
  const jid = (): string => required(values.jid, 'jid');
  const key = (): string => required(values.key, 'key');
  switch (action) {
    case 'status': case 'stop': case 'reconnect': case 'resync': case 'drop-connection':
      only(); command = { command: action }; break;
    case 'pair':
      if (positionals[1] === 'qr') { only(); command = { command: 'pair-qr' }; }
      else if (positionals[1] === 'code') { only('phone'); command = { command: 'pair-code', phone: required(values.phone, 'phone') }; }
      else throw new Error('Use pair qr or pair code --phone INTERNATIONAL_DIGITS');
      break;
    case 'chats': {
      only('limit', 'offset', 'unread', 'archived');
      command = { command: 'chats', limit: Number(values.limit ?? 100), offset: Number(values.offset ?? 0) };
      for (const field of ['unread', 'archived'] as const) {
        const state = values[field];
        if (state === undefined) continue;
        if (!['true', 'false', 'unknown'].includes(state)) throw new Error(`--${field} must be true, false or unknown`);
        command[field] = state === 'unknown' ? state : state === 'true';
      }
      break;
    }
    case 'chat': case 'group': case 'contact': only('jid'); command = { command: action, jid: jid() }; break;
    case 'resolve': only('phone'); command = { command: action, phone: required(values.phone, 'phone') }; break;
    case 'messages': only('jid', 'limit', 'offset'); command = { command: action, jid: jid(), limit: Number(values.limit ?? 20), offset: Number(values.offset ?? 0) }; break;
    case 'search': only('jid', 'query', 'limit', 'offset'); command = { command: action, query: required(values.query, 'query'), ...(values.jid ? { jid: values.jid } : {}), limit: Number(values.limit ?? 20), offset: Number(values.offset ?? 0) }; break;
    case 'send': only('jid', 'key', 'text'); command = { command: action, jid: jid(), key: key(), text: required(values.text, 'text') }; break;
    case 'send-contact': only('jid', 'key', 'name', 'phone'); command = { command: action, jid: jid(), key: key(), name: required(values.name, 'name'), phone: required(values.phone, 'phone') }; break;
    case 'send-file': only('jid', 'key', 'file', 'mime', 'caption'); command = { command: action, jid: jid(), key: key(), path: resolve(required(values.file, 'file')), mime: values.mime ?? 'application/octet-stream', caption: values.caption ?? '' }; break;
    case 'download':
      only('jid', 'id', 'out', 'from-me', 'participant');
      if (values['from-me'] !== undefined && !['true', 'false'].includes(values['from-me'])) throw new Error('--from-me must be true or false');
      command = { command: action, jid: jid(), messageId: required(values.id, 'id'), path: resolve(required(values.out, 'out')),
        ...(values['from-me'] === undefined ? {} : { fromMe: values['from-me'] === 'true' }),
        ...(values.participant ? { participant: values.participant } : {}) };
      break;
    case 'archive': case 'unarchive': case 'read': case 'unread':
      only('jid', 'key'); command = { command: ['archive', 'unarchive'].includes(action) ? 'archive' : 'mark-read', jid: jid(), key: key(), value: action === 'archive' || action === 'read' }; break;
    case 'request': only('key'); command = { command: action, key: key() }; break;
    case 'events': only('after'); command = { command: action, after: Number(values.after ?? 0) }; break;
    default: throw new Error(`Unknown command: ${action}; use help for the JSON command reference`);
  }
  let response: Record<string, unknown>;
  try { response = await rpc(directory, command); }
  catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_RUNNING' && ['status', 'stop'].includes(action)) return { ok: true, running: false, data: { running: false, alreadyStopped: action === 'stop' } };
    throw error;
  }
  if (action === 'stop' && response.ok === true) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { await rpc(directory, { command: 'status' }, 500); }
      catch (error) { if (error instanceof RpcError && error.code === 'NOT_RUNNING') return { ...response, running: false }; }
      await delay(100);
    }
    throw new Error('Stop was requested, but shutdown has not completed; no process was killed');
  }
  return response;
}

main().then(result => { process.stdout.write(JSON.stringify(result) + '\n'); if (result.ok === false) process.exitCode = 1; })
  .catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Command failed', ...(error instanceof RpcError ? { code: error.code } : {}) }) + '\n'); process.exitCode = 1; });
