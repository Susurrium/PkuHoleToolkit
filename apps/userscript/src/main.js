import { getCredentials } from './credentials.js';
import { RequestScheduler } from './scheduler.js';
import { TreeholeApi } from './api.js';
import { JobStore } from './storage.js';
import { mountToolkit } from './ui.js';

export function startToolkit({
  documentObject = globalThis.document,
  windowObject = globalThis.window,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  indexedDBObject = globalThis.indexedDB,
} = {}) {
  let credentialsPromise = null;
  const credentialsProvider = () => {
    if (!credentialsPromise) {
      credentialsPromise = getCredentials({
        documentObject,
        storage: windowObject.localStorage,
        cryptoObject: windowObject.crypto,
      }).catch((error) => {
        credentialsPromise = null;
        throw error;
      });
    }
    return credentialsPromise;
  };
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
