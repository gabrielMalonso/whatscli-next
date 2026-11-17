/** Fictional terminal fixture; never opens a session, database or WhatsApp connection. */
import { messageOutput } from '../../src/output.js';
import { runMonitor } from '../../src/tui.js';
import { pn, lid, publicResponse } from './responses.js';

const group = '120363000000000001@g.us';
const chats = [
  {
    jid: group,
    name: 'Projeto Aurora',
    unread: true,
    archived: false,
    activity: { timestamp: 1700001800 },
  },
  {
    jid: pn,
    name: 'Marina (exemplo)',
    unread: false,
    archived: false,
    activity: { timestamp: 1700001000 },
  },
  {
    jid: lid,
    name: null,
    unread: null,
    archived: null,
    activity: { timestamp: null },
  },
];
const messages = [
  {
    id: '1',
    text: 'Bom dia! O relatório está pronto para revisão.',
    fromMe: false,
  },
  {
    id: '2',
    text: 'Vou conferir os números e separar os pontos que precisam de atenção.',
    fromMe: true,
  },
  { id: '3', text: 'A versão atualizada está neste documento.', fromMe: false },
  { id: '4', text: 'Recebi. A revisão está em andamento.', fromMe: true },
  {
    id: '5',
    text: 'Quando terminar, podemos combinar os próximos passos por aqui. 👋',
    fromMe: false,
  },
].map(({ id, text, fromMe }, index) =>
  messageOutput({
    key: {
      remoteJid: group,
      id,
      fromMe,
      ...(fromMe ? {} : { participant: pn }),
    },
    messageTimestamp: 1700000000 + index * 180,
    message:
      index === 2
        ? {
            documentMessage: {
              fileName: 'relatorio-aurora.pdf',
              caption: text,
              mimetype: 'application/pdf',
            },
          }
        : { conversation: text },
  }),
);

await runMonitor({
  directory: '/fictional-unused',
  label: 'demonstração fictícia',
  read: async (command) =>
    publicResponse(
      command.command === 'chats'
        ? chats
        : command.command === 'messages' && command.jid === group
          ? messages.toReversed()
          : command.command === 'contact'
            ? {
                jid: command.jid,
                source: 'local',
                mapping: { status: 'unknown', pn: null, lid: null },
                contacts:
                  command.jid === pn
                    ? [
                        {
                          jid: pn,
                          metadata: {
                            name: {
                              value: 'Marina (exemplo)',
                              source: 'contacts.upsert',
                              observedAt: 1700000000000,
                            },
                          },
                        },
                      ]
                    : [],
              }
            : command.command === 'messages'
              ? []
              : {},
    ),
});
