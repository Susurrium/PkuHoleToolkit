import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createAuthHeaders, getCredentials, parseCookieString } from '../apps/userscript/src/credentials.js';
import { ERROR_CODES } from '../apps/userscript/src/errors.js';

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
