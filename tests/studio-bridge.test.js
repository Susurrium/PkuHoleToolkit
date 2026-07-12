import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStudioPairingCode, sendArchiveToStudio } from '../apps/userscript/src/studio-bridge.js';

test('parses a Studio pairing code', () => {
  assert.deepEqual(parseStudioPairingCode('8080:0123456789ABCDEF0123456789ABCDEF'), {
    port: 8080,
    token: '0123456789abcdef0123456789abcdef',
  });
  assert.throws(() => parseStudioPairingCode('8080-short'), /格式不正确/);
});

test('uploads only the archive to the paired local endpoint', async () => {
  let requestOptions;
  const archive = { blob: new Blob(['zip']), filename: 'sample.treehole.zip' };
  const result = await sendArchiveToStudio(
    '8080:0123456789abcdef0123456789abcdef',
    archive,
    (options) => {
      requestOptions = options;
      options.onload({ status: 202, responseText: JSON.stringify({ data: { status: 'awaiting_confirmation' } }) });
    },
  );
  assert.equal(requestOptions.method, 'POST');
  assert.equal(requestOptions.url, 'http://127.0.0.1:8080/api/v1/bridge/pairings/0123456789abcdef0123456789abcdef/archive');
  assert.ok(requestOptions.data instanceof FormData);
  assert.equal(result.status, 'awaiting_confirmation');
});
