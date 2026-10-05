import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ExportJob } from '../apps/userscript/src/export-job.js';
import { MediaCapture } from '../apps/userscript/src/media.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';
import { TreeholeApi } from '../apps/userscript/src/api.js';
import { RequestScheduler } from '../apps/userscript/src/scheduler.js';
import { parseArchiveBytes } from '../apps/userscript/src/archive.js';
import { readZip } from '../apps/userscript/src/zip.js';
import { LIMITS } from '../apps/userscript/src/config.js';
import { AppError, ERROR_CODES } from '../apps/userscript/src/errors.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6x8AAAAASUVORK5CYII=', 'base64'));
const gif = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail('expected asynchronous progress did not arrive');
}

test('parallel posts share one in-flight image while retaining every owner and zero-reply comment', async () => {
  const holes = Array.from({ length: 6 }, (_, i) => ({ pid: 10000 + i, reply: 0, media_ids: '9' }));
  const imageGate = deferred();
  let downloads = 0;
  const store = new MemoryJobStore();
  const job = new ExportJob({ store, accountFingerprint: 'test', api: {
    getAllFollowed: async () => ({ complete: true, items: holes }),
    getHole: async (pid) => holes.find((hole) => String(hole.pid) === pid),
    getAllComments: async (pid) => ({ complete: true, items: [{ cid: Number(pid), pid, media_ids: '9', text: 'comment' }] }),
    downloadMedia: async () => { downloads += 1; await imageGate.promise; return { bytes: png }; },
  } });
  const running = job.run();
  await until(() => downloads === 1);
  await nextTurn();
  imageGate.resolve();
  const result = await running;
  assert.equal(downloads, 1);
  assert.equal(result.manifest.complete, true);
  assert.equal(result.manifest.counts.comments, 6);
  assert.equal(result.manifest.counts.media, 12);
  const files = readZip(result.archive.bytes);
  const index = JSON.parse(new TextDecoder().decode(files['media/index.json']));
  assert.equal(index.length, 12);
  assert.equal(new Set(index.map((entry) => entry.path)).size, 1);
  assert.deepEqual(parseArchiveBytes(result.archive.bytes).data.items.map((item) => item.pid), holes.map((hole) => String(hole.pid)));
});

test('parallel images wait for reserved capacity and use released space without false failures', async () => {
  const store = new MemoryJobStore();
  const first = deferred();
  const calls = [];
  const capture = new MediaCapture({ store, jobId: 'capacity', limits: { ...LIMITS,
    maxMediaBytes: png.length, mediaBudgetBytes: png.length + gif.length }, api: {
    downloadMedia: async (id, _pid, _signal, limit) => {
      calls.push([id, limit]);
      if (id === '1') await first.promise;
      return { bytes: id === '1' ? png : gif };
    },
  } });
  await capture.initialize();
  const one = capture.capture({ pid: 10000, media_ids: '1' }, [], '10000');
  const two = capture.capture({ pid: 10001, media_ids: '2' }, [], '10001');
  await until(() => calls.length === 1);
  await nextTurn();
  assert.equal(calls.length, 1);
  first.resolve();
  await Promise.all([one, two]);
  assert.deepEqual(calls, [['1', png.length], ['2', gif.length]]);
  assert.ok((await store.getMedia('capacity')).every((record) => record.status === 'available'));
  assert.equal([...capture.fileSizes.values()].reduce((sum, bytes) => sum + bytes, 0), png.length + gif.length);
  assert.equal(capture.reservedBytes, 0);
});

test('parallel export respects its media budget while retaining all post bodies', async () => {
  const holes = [{ pid: 10000, reply: 0, media_ids: '1' }, { pid: 10001, reply: 0, media_ids: '2' }];
  const job = new ExportJob({ store: new MemoryJobStore(), accountFingerprint: 'test',
    limits: { ...LIMITS, maxMediaBytes: png.length, mediaBudgetBytes: png.length }, api: {
      getAllFollowed: async () => ({ complete: true, items: holes }),
      getHole: async (pid) => holes.find((hole) => String(hole.pid) === pid),
      getAllComments: async () => ({ complete: true, items: [] }),
      downloadMedia: async (id) => ({ bytes: id === '1' ? png : gif }),
    } });
  const result = await job.run();
  assert.equal(result.manifest.complete, false);
  assert.equal(result.manifest.counts.exportedHoles, 2);
  assert.equal(result.manifest.counts.missingMedia, 1);
  const files = readZip(result.archive.bytes);
  assert.equal(Object.entries(files).filter(([path]) => /^media\/[a-f0-9]{64}\./.test(path))
    .reduce((sum, [, bytes]) => sum + bytes.length, 0), png.length);
});

test('cancellation releases image reservations and stops owners waiting for capacity', async () => {
  const controller = new AbortController();
  let calls = 0;
  const capture = new MediaCapture({ store: new MemoryJobStore(), jobId: 'cancel',
    limits: { ...LIMITS, maxMediaBytes: png.length, mediaBudgetBytes: png.length }, api: {
      downloadMedia: async (_id, _pid, signal) => {
        calls += 1;
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () =>
          reject(new AppError(ERROR_CODES.CANCELLED, 'cancelled')), { once: true }));
      },
    } });
  await capture.initialize();
  const settled = Promise.allSettled([1, 2].map((id) => capture.capture(
    { pid: 10000 + id, media_ids: String(id) }, [], String(10000 + id), controller.signal)));
  await until(() => calls === 1);
  controller.abort();
  const results = await settled;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === ERROR_CODES.CANCELLED));
  assert.equal(calls, 1);
  assert.equal(capture.reservedBytes, 0);
});

test('queued binary requests recheck the account before sending', async () => {
  const gate = deferred();
  let calls = 0, account = 'a';
  const scheduler = new RequestScheduler({ policy: { maxReadConcurrent: 1, readIntervalMs: 0, readJitterMs: 0 },
    fetchImpl: async () => { calls += 1; await gate.promise; return new Response('{}'); } });
  const active = scheduler.requestJson('https://example.test/active');
  await until(() => calls === 1);
  const api = new TreeholeApi({ scheduler,
    credentialsProvider: async () => ({ token: 'test', uuid: account, accountFingerprint: account }),
  }).forAccount('a');
  const rejected = assert.rejects(api.downloadMedia('9', '123456'), { code: ERROR_CODES.UNAUTHORIZED });
  await until(() => scheduler.queue.length === 1);
  account = 'b'; gate.resolve();
  await active; await rejected;
  assert.equal(calls, 1);
});
