import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chatModificationToAppPatch,
  decodePatches,
  encodeSyncdPatch,
  newLTHashState,
  proto,
} from 'baileys';
import type { ChatModification, LTHashState } from 'baileys';
import { pino } from 'pino';

for (const kind of ['archive', 'read'] as const) {
  test(`installed pinned SDK preserves the new ${kind} action after retiring the previous encrypted record`, async () => {
    const jid = '12025550101@s.whatsapp.net';
    const oldId = Buffer.from('fictional-old').toString('base64');
    const newId = Buffer.from('fictional-new').toString('base64');
    const keys = new Map([
      [oldId, { keyData: Buffer.alloc(32, 11) }],
      [newId, { keyData: Buffer.alloc(32, 12) }],
    ]);
    const getKey = async (id: string) => keys.get(id);
    const encode = async (
      value: boolean,
      id: string,
      state: LTHashState,
      operation = proto.SyncdMutation.SyncdOperation.SET,
    ) => {
      const lastMessages = [
        {
          key: { remoteJid: jid, id: 'fictional-last', fromMe: false },
          messageTimestamp: 1700000000,
        },
      ];
      const mod: ChatModification =
        kind === 'archive'
          ? { archive: value, lastMessages }
          : { markRead: value, lastMessages };
      const result = await encodeSyncdPatch(
        { ...chatModificationToAppPatch(mod, jid), operation },
        id,
        state,
        getKey,
      );
      result.patch.version = { version: result.state.version };
      return result;
    };
    const old = await encode(false, oldId, newLTHashState());
    const current = await encode(true, newId, old.state);
    const retired = await encode(
      false,
      oldId,
      current.state,
      proto.SyncdMutation.SyncdOperation.REMOVE,
    );
    const result = await decodePatches(
      'regular_low',
      [old.patch, current.patch, retired.patch],
      newLTHashState(),
      getKey,
      {},
      undefined,
      pino({ level: 'silent' }),
      true,
    );
    const action = Object.values(result.mutationMap)[0]?.syncAction.value;
    assert.equal(
      kind === 'archive'
        ? action?.archiveChatAction?.archived
        : action?.markChatAsReadAction?.read,
      true,
    );
    assert.equal(Object.keys(result.state.indexValueMap).length, 1);
    assert.deepEqual(result.state.hash, retired.state.hash);
  });
}
