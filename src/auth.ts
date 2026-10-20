import { initAuthCreds, proto } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalKeyStore,
} from 'baileys';
import type { Store } from './store.js';

/** Web pairing installs a signed account; the SDK's separate registered flag can remain false. */
export function hasLinkedCredentials(
  creds: Pick<AuthenticationCreds, 'account' | 'me'>,
): boolean {
  return Boolean(creds.account && creds.me?.id);
}

export function sqliteAuth(store: Store): {
  state: AuthenticationState;
  save: (update: Partial<AuthenticationCreds>) => void;
} {
  const creds =
    store.get<AuthenticationCreds>('auth', 'creds') ?? initAuthCreds();
  store.set('auth', 'creds', creds);
  const keys: SignalKeyStore = {
    get<T extends keyof SignalDataTypeMap>(category: T, ids: string[]) {
      const result: Record<string, SignalDataTypeMap[T]> = {};
      for (const id of ids) {
        const value = store.get<SignalDataTypeMap[T]>(category, id);
        if (value !== undefined) {
          // The SDK requires a protobuf instance for this one persisted key category.
          result[id] = (
            category === 'app-state-sync-key'
              ? proto.Message.AppStateSyncKeyData.fromObject(
                  store.get<proto.Message.IAppStateSyncKeyData>(category, id) ??
                    {},
                )
              : value
          ) as SignalDataTypeMap[T];
        }
      }
      return result;
    },
    set(data) {
      store.transaction(() => {
        for (const [category, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            store.set(category, id, value);
            if (category === 'lid-mapping') store.observeSdkMapping(id, value);
          }
        }
      });
    },
  };
  return {
    state: { creds, keys },
    save(update) {
      Object.assign(creds, update);
      store.set('auth', 'creds', creds);
    },
  };
}
