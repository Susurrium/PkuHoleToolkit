import test from 'node:test';
import assert from 'node:assert/strict';

import { createZip, readZip } from '../apps/userscript/src/zip.js';
import {
  createArchive,
  createManifest,
  parseArchiveBytes,
  sanitizeForArchive,
} from '../apps/userscript/src/archive.js';
import { ERROR_CODES } from '../apps/userscript/src/errors.js';

test('stored ZIP round-trips named entries and validates CRC', () => {
  const bytes = createZip({ 'a.txt': 'hello', 'nested/b.json': '{"ok":true}' });
  const entries = readZip(bytes);
  assert.equal(new TextDecoder().decode(entries['a.txt']), 'hello');
  assert.equal(new TextDecoder().decode(entries['nested/b.json']), '{"ok":true}');
  const corrupted = bytes.slice();
  corrupted[40] ^= 1;
  assert.throws(() => readZip(corrupted));
});

test('archive v2 has manifest, data and readable files without credentials', () => {
  const items = [
    {
      pid: '123456',
      source: 'followed',
      hole: { pid: 123456, text: 'text', timestamp: 1, token: 'remove-me' },
      comments: [{ cid: 1, name: 'Alice', text: 'comment', uuid: 'remove-me' }],
      fetchStatus: 'ok',
    },
  ];
  const manifest = createManifest({
    runId: 'run-1',
    scope: { type: 'all' },
    complete: true,
    items,
    expectedHoles: 1,
    exportedAt: '2026-07-11T00:00:00.000Z',
  });
  const archive = createArchive({ manifest, items });
  const parsed = parseArchiveBytes(archive.bytes);
  assert.equal(parsed.format, 'v2');
  assert.equal(parsed.data.items[0].hole.token, undefined);
  assert.equal(parsed.data.items[0].comments[0].uuid, undefined);
  assert.equal(parsed.manifest.accountFingerprint, undefined);
  assert.equal(parsed.manifest.counts.exportedHoles, 1);
  assert.ok(readZip(archive.bytes)['readable.txt']);
});

test('legacy v1 comments are flattened and attached by index', () => {
  const legacy = {
    holes: [{ pid: 123456, text: 'hole' }],
    comments: [[[{ cid: 1, text: 'one' }], [{ cid: 2, text: 'two' }]]],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(legacy));
  const parsed = parseArchiveBytes(bytes, 'legacy.json');
  assert.equal(parsed.format, 'legacy-v1');
  assert.equal(parsed.data.items[0].comments.length, 2);
  assert.equal(parsed.data.items[0].source, 'legacy-v1');
});

test('sensitive keys are removed recursively', () => {
  assert.deepEqual(
    sanitizeForArchive({
      a: 1,
      authToken: 'x',
      accountFingerprint: 'stable-linking-id',
      nested: { uuid: 'y', b: 2 },
    }),
    {
      a: 1,
      nested: { b: 2 },
    },
  );
});

test('invalid archive is rejected', () => {
  assert.throws(
    () => parseArchiveBytes(new TextEncoder().encode('{"comments":[]}')),
    (error) => error.code === ERROR_CODES.INVALID_INPUT,
  );
});
