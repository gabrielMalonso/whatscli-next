import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { messageOutput } from '../src/output.js';
import { contactDisplay } from '../src/tui-contacts.js';
import { Monitor } from '../src/tui-model.js';
import type { MonitorCommand } from '../src/tui-model.js';
import { renderMonitor } from '../src/tui-view.js';
import { lid, pn, publicResponse } from './fixtures/responses.js';

process.umask(0o077);
const otherPn = '12025550102@s.whatsapp.net';
const otherLid = '123450002@lid';
const group = '120363000000000001@g.us';

function fixture(t: TestContext): Store {
  const store = new Store(mkdtempSync(join(tmpdir(), 'wcn-tui-names-')));
  t.after(() => store.close());
  return store;
}

test('contact labels prefer saved names, retain provenance and borrow only unambiguous PN/LID associations', (t) => {
  const store = fixture(t);
  store.observeContact(
    {
      id: pn,
      lid,
      name: 'Marina Agenda',
      verifiedName: 'Marina Comercial',
      notify: 'Marina Perfil',
    },
    'contacts.upsert',
  );
  store.observeContact({ id: lid, notify: 'Perfil local' }, 'contacts.update');
  assert.deepEqual(contactDisplay(lid, store.contactView(lid)), {
    mapping: 'known',
    label: { value: 'Marina Agenda', jid: pn, field: 'name' },
  });
  store.observeMapping(otherPn, lid, 'contacts.update');
  assert.deepEqual(contactDisplay(lid, store.contactView(lid)), {
    mapping: 'conflict',
    label: { value: 'Perfil local', jid: lid, field: 'notify' },
  });
  const view = store.contactView(lid);
  const unrelated = store.contactView(pn).contacts;
  assert.equal(
    contactDisplay(lid, { ...view, contacts: [...unrelated, ...view.contacts] })
      .label?.value,
    'Perfil local',
  );
  assert.deepEqual(contactDisplay(otherLid, store.contactView(otherLid)), {
    mapping: 'unknown',
    label: null,
  });
  assert.throws(() => contactDisplay(otherLid, store.contactView(lid)));
  assert.throws(() =>
    contactDisplay(lid, {
      ...view,
      mapping: { status: 'known', pn: otherPn, lid: otherLid },
    }),
  );
});

test('business and profile names remain display fallbacks when no saved name is available', (t) => {
  const store = fixture(t);
  store.observeContact(
    {
      id: pn,
      name: ' ',
      verifiedName: 'Oficina Exemplo',
      notify: 'Nome de perfil',
    },
    'contacts.upsert',
  );
  assert.equal(
    contactDisplay(pn, store.contactView(pn)).label?.field,
    'verifiedName',
  );
  store.observeContact(
    { id: pn, verifiedName: '', notify: 'Nome de perfil' },
    'contacts.update',
  );
  assert.equal(
    contactDisplay(pn, store.contactView(pn)).label?.value,
    'Nome de perfil',
  );
});

test('TUI shows and filters captured contact names, names group authors and keeps exact identifiers', async (t) => {
  const store = fixture(t);
  store.observeContact(
    { id: pn, lid, name: 'Marina Agenda' },
    'messaging-history.set',
  );
  const requests: MonitorCommand[] = [];
  const monitor = new Monitor(
    async (command) => {
      requests.push(command);
      if (command.command === 'contact')
        return publicResponse(store.contactView(command.jid));
      if (command.command === 'chats')
        return publicResponse([
          { jid: group, name: 'Projeto Aurora' },
          { jid: lid, name: null },
          { jid: pn, name: 'Título antigo' },
        ]);
      if (command.command === 'messages')
        return publicResponse(
          command.jid === group
            ? [
                messageOutput({
                  key: {
                    remoteJid: group,
                    id: 'known',
                    fromMe: false,
                    participant: lid,
                  },
                  message: { conversation: 'Mensagem fictícia' },
                }),
                messageOutput({
                  key: {
                    remoteJid: group,
                    id: 'unknown',
                    fromMe: false,
                    participant: otherLid,
                  },
                  message: { conversation: 'Sem nome capturado' },
                }),
              ]
            : [],
        );
      return publicResponse({});
    },
    () => {},
  );
  t.after(() => monitor.stop());
  await monitor.refresh();
  await setImmediate();
  assert.equal(monitor.displayName(pn, 'Título antigo'), 'Marina Agenda');
  assert.equal(monitor.displayName(lid), 'Marina Agenda');
  assert.equal(monitor.displayName(otherLid), null);
  const frame = renderMonitor(monitor, 140, 30, 'fictícia', false).frame;
  assert.match(frame, /Projeto Aurora/);
  assert.match(frame, /Marina Agenda \(123450001@lid\)/);
  assert.match(frame, /123450002@lid/);
  assert.doesNotMatch(frame, /\+12345000/);
  assert.ok(
    requests
      .filter((request) => request.command === 'contact')
      .every((request) => request.jid !== group),
  );
  monitor.key('/', {}, 12);
  monitor.key('marina agenda', {}, 12);
  await monitor.refresh();
  assert.deepEqual(
    monitor.filteredChats.map((chat) => chat.jid),
    [lid, pn],
  );
  assert.equal(monitor.selected?.jid, lid);
  assert.deepEqual(monitor.messages, []);
  store.observeMapping(otherPn, lid, 'contacts.update');
  monitor.key('', { name: 'return' }, 12);
  monitor.key('', { name: 'r' }, 12);
  await monitor.refresh();
  await setImmediate();
  assert.equal(monitor.displayName(lid), null);
  assert.match(
    renderMonitor(monitor, 140, 30, 'fictícia', false).frame,
    /vínculo ambíguo/,
  );
});

test('optional name lookups do not block messages, cache results and refresh changed names on r', async (t) => {
  const store = fixture(t);
  store.observeContact({ id: pn, name: 'Primeiro nome' }, 'contacts.upsert');
  let release: (value: Record<string, unknown>) => void = () => {};
  let contacts = 0;
  let messages = 0;
  const monitor = new Monitor(
    async (command) => {
      if (command.command === 'contact') {
        contacts++;
        if (contacts === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return publicResponse(store.contactView(command.jid));
      }
      if (command.command === 'messages') messages++;
      return publicResponse(
        command.command === 'chats'
          ? [{ jid: pn, name: null }]
          : command.command === 'messages'
            ? []
            : {},
      );
    },
    () => {},
  );
  t.after(() => monitor.stop());
  await monitor.refresh();
  await monitor.refresh();
  assert.equal(messages, 2);
  assert.equal(contacts, 1);
  assert.equal(monitor.error, null);
  release(publicResponse(store.contactView(pn)));
  await setImmediate();
  assert.equal(monitor.displayName(pn), 'Primeiro nome');
  await monitor.refresh();
  assert.equal(contacts, 1);
  store.observeContact({ id: pn, name: 'Nome atualizado' }, 'contacts.update');
  monitor.key('', { name: 'r' }, 12);
  await monitor.refresh();
  await setImmediate();
  assert.equal(monitor.displayName(pn), 'Nome atualizado');
  assert.equal(contacts, 2);
});
