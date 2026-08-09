import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createAuthHeaders, getCredentials, parseCookieString } from '../apps/userscript/src/credentials.js';
import { ERROR_CODES } from '../apps/userscript/src/errors.js';
import { createCredentialsProvider } from '../apps/userscript/src/main.js';

test('cookie parser preserves equals signs in values', () => {
  const cookies = parseCookieString('pku_token=abc==; theme=dark');
  assert.equal(cookies.pku_token, 'abc==');
  assert.equal(cookies.theme, 'dark');
});

test('credentials validate token and uuid and expose only a fingerprint for persistence', async () => {
  const credentials = await getCredentials({
    documentObject: { cookie: 'pku_token=secret' },
    storage: { getItem: (key) => (key === 'pku-uuid' ? 'uuid-value' : null) },
    cryptoObject: webcrypto,
  });
  assert.equal(credentials.token, 'secret');
  assert.equal(credentials.uuid, 'uuid-value');
  assert.match(credentials.accountFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(createAuthHeaders(credentials), {
    accept: 'application/json, text/plain, */*',
    authorization: 'Bearer secret',
    uuid: 'uuid-value',
  });
});

test('missing credentials fail before a request is sent', async () => {
  await assert.rejects(
    getCredentials({
      documentObject: { cookie: '' },
      storage: { getItem: () => null },
      cryptoObject: webcrypto,
    }),
    (error) => error.code === ERROR_CODES.UNAUTHORIZED,
  );
});

test('credential provider invalidates its cache when the cookie token or account UUID changes', async () => {
  const documentObject = { cookie: 'pku_token=first-token' };
  const values = new Map([['pku-uuid', 'first-uuid']]);
  const provider = createCredentialsProvider({
    documentObject,
    storage: { getItem: (key) => values.get(key) ?? null },
    cryptoObject: webcrypto,
  });

  const first = await provider();
  assert.equal(await provider(), first, 'unchanged credentials should reuse the cached result');

  documentObject.cookie = 'pku_token=second-token';
  const refreshedToken = await provider();
  assert.equal(refreshedToken.token, 'second-token');
  assert.notEqual(refreshedToken, first);

  values.set('pku-uuid', 'second-uuid');
  const refreshedAccount = await provider();
  assert.equal(refreshedAccount.uuid, 'second-uuid');
  assert.notEqual(refreshedAccount.accountFingerprint, refreshedToken.accountFingerprint);
});

test('an obsolete credential failure cannot clear a newer cache entry with the same key', async () => {
  const documentObject = { cookie: 'pku_token=token-a' };
  const values = new Map([['pku-uuid', 'uuid-a']]);
  const digests = [];
  const provider = createCredentialsProvider({
    documentObject,
    storage: { getItem: (key) => values.get(key) ?? null },
    cryptoObject: {
      subtle: {
        digest() {
          return new Promise((resolve, reject) => digests.push({ resolve, reject }));
        },
      },
    },
  });

  const obsolete = provider();
  documentObject.cookie = 'pku_token=token-b';
  const accountB = provider();
  documentObject.cookie = 'pku_token=token-a';
  const current = provider();

  digests[0].reject(new Error('obsolete digest failed'));
  await assert.rejects(obsolete, /obsolete digest failed/);
  assert.equal(provider(), current);

  digests[1].resolve(new Uint8Array([2]).buffer);
  digests[2].resolve(new Uint8Array([3]).buffer);
  await accountB;
  assert.equal((await current).token, 'token-a');
});
