import { getCredentials, parseCookieString } from './credentials.js';
import { RequestScheduler } from './scheduler.js';
import { TreeholeApi } from './api.js';
import { JobStore } from './storage.js';
import { mountToolkit } from './ui.js';

export function createCredentialsProvider({
  documentObject = globalThis.document,
  storage = globalThis.localStorage,
  cryptoObject = globalThis.crypto,
} = {}) {
  let cachedKey = null;
  let credentialsPromise = null;

  return () => {
    const token = parseCookieString(documentObject?.cookie || '').pku_token || '';
    const uuid = storage?.getItem?.('pku-uuid') || '';
    const currentKey = `${token.length}:${token}\n${uuid.length}:${uuid}`;
    if (!credentialsPromise || currentKey !== cachedKey) {
      cachedKey = currentKey;
      const guarded = getCredentials({ documentObject, storage, cryptoObject }).catch((error) => {
        if (credentialsPromise === guarded) {
          credentialsPromise = null;
          cachedKey = null;
        }
        throw error;
      });
      credentialsPromise = guarded;
    }
    return credentialsPromise;
  };
}

export function startToolkit({
  documentObject = globalThis.document,
  windowObject = globalThis.window,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  indexedDBObject = globalThis.indexedDB,
} = {}) {
  const credentialsProvider = createCredentialsProvider({
    documentObject,
    storage: windowObject.localStorage,
    cryptoObject: windowObject.crypto,
  });
  const scheduler = new RequestScheduler({ fetchImpl });
  const api = new TreeholeApi({ scheduler, credentialsProvider });
  const store = new JobStore({ indexedDBObject });
  store.cleanup().catch((error) => console.warn('[PKU Hole Toolkit] 清理旧任务失败', error));
  return mountToolkit({ api, store, credentialsProvider, documentObject, windowObject });
}

function bootstrap() {
  try {
    startToolkit();
  } catch (error) {
    console.error('[PKU Hole Toolkit] 启动失败', error);
  }
}

if (globalThis.document?.body) bootstrap();
else globalThis.document?.addEventListener('DOMContentLoaded', bootstrap, { once: true });
