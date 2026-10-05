import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeholeApi } from '../apps/userscript/src/api.js';
import { RequestScheduler } from '../apps/userscript/src/scheduler.js';
import { ExportJob } from '../apps/userscript/src/export-job.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';
import { readZip, createZip } from '../apps/userscript/src/zip.js';
import { parseArchiveBytes } from '../apps/userscript/src/archive.js';
import { restoreLatestExportArchive } from '../apps/userscript/src/studio-bridge.js';
import { AppError, ERROR_CODES } from '../apps/userscript/src/errors.js';
import { LIMITS } from '../apps/userscript/src/config.js';
import { MEDIA_EXTENSION, mediaTargets, parseMediaIds, readMediaResponse } from '../apps/userscript/src/media.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6x8AAAAASUVORK5CYII=', 'base64'));
const gif = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
const quickPolicy = { readIntervalMs: 0, writeIntervalMs: 0, jitterMs: 0, timeoutMs: 100,
  maxReadAttempts: 3, missingRetryAfterMs: 0 };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const image = (bytes = png, headers = {}) => new Response(bytes, { headers: {
  'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), ...headers,
} });

function makeApi(fetchImpl, credentialsProvider = async () => ({ token: 'secret', uuid: 'device', accountFingerprint: 'account' })) {
  return new TreeholeApi({ credentialsProvider, scheduler: new RequestScheduler({
    fetchImpl, sleepImpl: async () => {}, random: () => 0, policy: quickPolicy,
  }) }).forAccount('account');
}

function exportFixture({ holes, comments = [], fetchMedia = async () => ({ bytes: png }), store = new MemoryJobStore(), onProgress, limits } = {}) {
  const calls = [];
  const api = {
    async getAllFollowed() { return { complete: true, items: holes }; },
    async getAllComments(pid) {
      calls.push(`comments:${pid}`);
      return { complete: true, items: comments.filter((comment) => !comment.pid || String(comment.pid) === String(pid)) };
    },
    async getHole(pid) {
      calls.push(`hole:${pid}`);
      return holes.find((hole) => String(hole.pid) === String(pid)) ||
        { pid, type: 'image', media_ids: '13', timestamp: 3, reply: 0 };
    },
    async downloadMedia(id, pid, signal, maxBytes) {
      calls.push(`media:${id || `pid=${pid}`}`);
      return fetchMedia(id, pid, signal, maxBytes);
    },
  };
  const newJob = () => new ExportJob({ api, store, accountFingerprint: 'account', onProgress, limits });
  return { api, store, calls, newJob };
}

test('media inventory covers multiple formats, comment ownership and legacy image posts', () => {
  assert.deepEqual(parseMediaIds('["9", "10", "9"]'), ['9', '10']);
  assert.deepEqual(parseMediaIds('9;10 | 11 invalid'), ['9', '10', '11']);
  assert.deepEqual(parseMediaIds([9, 10]), ['9', '10']);
  assert.deepEqual(mediaTargets({ pid: 123456, type: 'image', media_ids: '[]' }, [{ cid: 42, media_ids: '9' }]), [
    { ownerType: 'post', ownerId: 123456, remoteId: '', variant: 'original' },
    { ownerType: 'comment', ownerId: 42, remoteId: '9', variant: 'original' },
  ]);
});

test('binary API uses Observer routes, headers and PID fallback', async () => {
  const calls = [];
  const api = makeApi(async (url, options) => { calls.push({ url, options }); return image(gif); });
  assert.deepEqual((await api.downloadMedia('9', '123456')).bytes, gif);
  await api.downloadMedia('', '123456');
  assert.equal(calls[0].url, 'https://treehole.pku.edu.cn/chapi/api/v3/media/getImageBinary?id=9');
  assert.equal(calls[1].url, 'https://treehole.pku.edu.cn/chapi/api/v3/media/getImageBinary?pid=123456');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret');
  assert.equal(calls[0].options.headers.uuid, 'device');
  assert.equal(calls[0].options.credentials, 'include');
  await assert.rejects(api.downloadMedia('9&pid=1', '123456'), { code: ERROR_CODES.INVALID_INPUT });
  assert.equal(calls.length, 2);
});

test('media retries share rate handling and recheck credentials at request time', async () => {
  let calls = 0;
  const api = makeApi(async () => { calls += 1; return calls === 1 ? json({}, 503) : image(); });
  await api.downloadMedia('9', '123456');
  assert.equal(calls, 2);
  let account = 'account';
  let switchedCalls = 0;
  const switched = makeApi(async () => { switchedCalls += 1; account = 'other'; return json({}, 503); },
    async () => ({ token: 'secret', uuid: 'device', accountFingerprint: account }));
  await assert.rejects(switched.downloadMedia('9', '123456'), { code: ERROR_CODES.UNAUTHORIZED });
  assert.equal(switchedCalls, 1);
  let rateCalls = 0;
  const limited = makeApi(async () => { rateCalls += 1; return json({}, 429); });
  await assert.rejects(limited.downloadMedia('9', '123456'), { code: ERROR_CODES.RATE_LIMITED });
  assert.equal(rateCalls, 3);
});

test('media rejects HTML, disguised JSON, empty, oversized and truncated payloads', async () => {
  for (const response of [
    new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{"success":false}', { headers: { 'Content-Type': 'image/jpeg' } }),
    image(new Uint8Array()),
    image(png, { 'Content-Length': String(png.length + 1) }),
  ]) await assert.rejects(readMediaResponse(response), { code: ERROR_CODES.INVALID_RESPONSE });
  await assert.rejects(readMediaResponse(image(png), png.length - 1), { code: ERROR_CODES.INVALID_RESPONSE });
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(png); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readMediaResponse(new Response(stream), 8), { code: ERROR_CODES.INVALID_RESPONSE });
  assert.equal(cancelled, true);
  const compressed = await readMediaResponse(image(gif, { 'Content-Length': '1', 'Content-Encoding': 'gzip' }));
  assert.deepEqual(compressed.bytes, gif);
});

test('invalid media is not automatically downloaded repeatedly', async () => {
  let calls = 0;
  const api = makeApi(async () => { calls += 1; return new Response('{"error":"login"}'); });
  await assert.rejects(api.downloadMedia('9', '123456'), { code: ERROR_CODES.INVALID_RESPONSE });
  assert.equal(calls, 1);
});

test('binary body timeout and user cancellation remain effective while streaming', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const api = makeApi(async (url, options) => {
      const stream = new ReadableStream({ start(reader) {
        reader.enqueue(png.subarray(0, 8));
        options.signal.addEventListener('abort', () => reader.error(new DOMException('aborted', 'AbortError')), { once: true });
      } });
      if (cancel) setTimeout(() => controller.abort(), 5);
      return new Response(stream);
    });
    api.scheduler.policy.maxReadAttempts = 1;
    await assert.rejects(api.downloadMedia('9', '123456', controller.signal), {
      code: cancel ? ERROR_CODES.CANCELLED : ERROR_CODES.NETWORK_ERROR,
    });
  }
});

test('export packages post, comment, legacy and referenced images with content deduplication', async () => {
  const fixture = exportFixture({
    holes: [{ pid: 123456, text: '#345678', media_ids: '9,10', reply: 1, timestamp: 1 },
      { pid: 234567, text: '', type: 'image', reply: 0, timestamp: 2 }],
    comments: [{ cid: 42, pid: 123456, text: 'comment', media_ids: '9,11' }],
    fetchMedia: async (id) => ({ bytes: id === '10' ? gif : png }),
  });
  const result = await fixture.newJob().run({ referenceMode: 'body' });
  assert.equal(result.manifest.complete, true);
  assert.equal(result.manifest.counts.media, 6);
  assert.equal(result.manifest.counts.missingMedia, 0);
  assert.deepEqual(result.manifest.extensions[MEDIA_EXTENSION], { version: 1, required: false });
  assert.equal(result.manifest.exportOptions.includeMedia, true);
  const files = readZip(result.archive.bytes);
  const index = JSON.parse(new TextDecoder().decode(files['media/index.json']));
  assert.equal(index.length, 6);
  assert.equal(Object.keys(files).filter((path) => /^media\/[a-f0-9]{64}\./.test(path)).length, 2);
  assert.ok(index.every((entry) => entry.variant === 'original' && entry.status === 'available'));
  assert.deepEqual(files[index.find((entry) => entry.remoteId === '10').path], gif);
  assert.ok(index.some((entry) => entry.ownerType === 'comment' && entry.ownerId === 42));
  assert.equal(fixture.calls.filter((call) => call === 'media:9').length, 1);
  assert.ok(fixture.calls.indexOf('media:9') < fixture.calls.indexOf('comments:123456'));
  const parsed = parseArchiveBytes(result.archive.bytes);
  assert.equal(parsed.data.items[0].hole.media_ids, '9,10');
  assert.equal(parsed.data.items[0].contentComplete, undefined);
  assert.equal(parsed.data.items[0].mediaComplete, undefined);
  assert.match(new TextDecoder().decode(files['readable.txt']), /图片文件: media\//);
});

test('retry downloads only missing images and reuses already captured comments', async () => {
  let fail = true;
  const fixture = exportFixture({ holes: [{ pid: 123456, media_ids: '9,10', reply: 1 }],
    comments: [{ cid: 42, text: 'kept' }], fetchMedia: async (id) => {
      if (id === '10' && fail) throw new AppError(ERROR_CODES.NOT_FOUND, 'missing');
      return { bytes: png };
    } });
  const first = await fixture.newJob().run();
  assert.equal(first.manifest.complete, false);
  assert.equal(first.manifest.counts.missingMedia, 1);
  assert.equal(first.job.state, 'partial');
  assert.equal(parseArchiveBytes(first.archive.bytes).data.items[0].fetchStatus, 'partial');
  fail = false;
  const second = await fixture.newJob().run(null, { jobId: first.job.id });
  assert.equal(second.manifest.complete, true);
  assert.equal(second.manifest.counts.missingMedia, 0);
  assert.deepEqual(fixture.calls, ['hole:123456', 'media:9', 'media:10', 'comments:123456', 'media:10']);
});

test('pause between images preserves body and downloaded image across a new job instance', async () => {
  let job;
  let shouldPause = true;
  const fixture = exportFixture({ holes: [{ pid: 123456, media_ids: '9,10', reply: 0 }],
    onProgress(event) { if (shouldPause && event.type === 'media') job.requestPause(); } });
  job = fixture.newJob();
  const paused = await job.run();
  assert.equal(paused.paused, true);
  assert.equal((await fixture.store.getItems(paused.job.id))[0].hole.pid, 123456);
  assert.equal((await fixture.store.getMedia(paused.job.id)).length, 1);
  shouldPause = false;
  const resumed = await fixture.newJob().run(null, { jobId: paused.job.id });
  assert.equal(resumed.manifest.complete, true);
  assert.deepEqual(fixture.calls, ['hole:123456', 'media:9', 'media:10', 'comments:123456']);
});

test('image failure does not discard body and authorization failures leave a resumable checkpoint', async () => {
  const fixture = exportFixture({ holes: [{ pid: 123456, text: 'saved before media', media_ids: '9', reply: 0 }],
    fetchMedia: async () => { throw new AppError(ERROR_CODES.UNAUTHORIZED, 'expired'); } });
  const job = fixture.newJob();
  await assert.rejects(job.run(), { code: ERROR_CODES.UNAUTHORIZED });
  const stored = await fixture.store.getJob(job.jobId);
  assert.equal(stored.state, 'paused');
  assert.equal((await fixture.store.getItems(job.jobId))[0].hole.text, 'saved before media');
});

test('storage exhaustion pauses without claiming an image was saved', async () => {
  const store = new MemoryJobStore();
  const save = store.putMedia.bind(store);
  let full = true;
  store.putMedia = async (jobId, record, bytes) => {
    if (full && bytes) throw new AppError(ERROR_CODES.STORAGE_ERROR, 'quota full');
    return save(jobId, record, bytes);
  };
  const fixture = exportFixture({ store, holes: [{ pid: 123456, media_ids: '9', reply: 0 }] });
  const job = fixture.newJob();
  await assert.rejects(job.run(), { code: ERROR_CODES.STORAGE_ERROR });
  assert.equal((await store.getJob(job.jobId)).state, 'paused');
  assert.equal((await store.getMedia(job.jobId))[0].status, 'missing');
  full = false;
  assert.equal((await fixture.newJob().run(null, { jobId: job.jobId })).manifest.complete, true);
});

test('media budget keeps a valid partial archive and avoids requests after capacity is exhausted', async () => {
  const fixture = exportFixture({ holes: [{ pid: 123456, media_ids: '9,10', reply: 0 }],
    limits: { ...LIMITS, mediaBudgetBytes: png.length } });
  const result = await fixture.newJob().run();
  assert.equal(result.manifest.complete, false);
  assert.equal(result.manifest.counts.media, 2);
  assert.equal(result.manifest.counts.missingMedia, 1);
  assert.deepEqual(fixture.calls, ['hole:123456', 'media:9', 'comments:123456']);
  assert.equal(parseArchiveBytes(result.archive.bytes).data.items.length, 1);
});

test('restoring a media export verifies files, and damaged cached bytes are repaired on retry', async () => {
  const fixture = exportFixture({ holes: [{ pid: 123456, media_ids: '9', reply: 0 }] });
  const first = await fixture.newJob().run();
  const restored = await restoreLatestExportArchive(fixture.store, 'account');
  assert.deepEqual(restored.archive.bytes, first.archive.bytes);
  const [record] = await fixture.store.getMedia(first.job.id);
  const damaged = png.slice(); damaged[20] ^= 1;
  await fixture.store.putMedia(first.job.id, record, damaged);
  const partial = await restoreLatestExportArchive(fixture.store, 'account');
  assert.equal(partial.job.state, 'partial');
  assert.equal(partial.job.manifest.complete, false);
  assert.equal(partial.job.manifest.counts.missingMedia, 1);
  assert.equal((await fixture.store.getJob(first.job.id)).state, 'partial');
  assert.equal(Object.keys(readZip(partial.archive.bytes)).filter((path) => /^media\/[a-f0-9]{64}/.test(path)).length, 0);
  const repaired = await fixture.newJob().run(null, { jobId: first.job.id });
  assert.equal(repaired.manifest.complete, true);
  assert.deepEqual(fixture.calls, ['hole:123456', 'media:9', 'comments:123456', 'media:9']);
});

test('media opt-out and old checkpoints never initiate image downloads', async () => {
  const fixture = exportFixture({ holes: [{ pid: 123456, media_ids: '9', reply: 0 }] });
  const optedOut = await fixture.newJob().run({ includeMedia: false });
  assert.equal(optedOut.manifest.exportOptions.includeMedia, false);
  assert.equal(readZip(optedOut.archive.bytes)['media/index.json'], undefined);
  await fixture.store.putJob({ id: 'old', type: 'export', state: 'paused', accountFingerprint: 'account',
    options: { scope: { type: 'all' }, referenceMode: 'none' } });
  const old = await fixture.newJob().run(null, { jobId: 'old' });
  assert.equal(old.manifest.exportOptions.includeMedia, false);
  assert.equal(fixture.calls.some((call) => call.startsWith('media:')), false);
});

test('media files are scoped to their job and task deletion cleans them without affecting other jobs', async () => {
  const fixture = exportFixture({ holes: [{ pid: 123456, media_ids: '9', reply: 0 }] });
  const first = await fixture.newJob().run();
  const second = await fixture.newJob().run();
  assert.equal(await restoreLatestExportArchive(fixture.store, 'other-account'), null);
  await assert.rejects(new ExportJob({ api: fixture.api, store: fixture.store, accountFingerprint: 'other-account' })
    .run(null, { jobId: second.job.id }), { code: ERROR_CODES.UNAUTHORIZED });
  await fixture.store.deleteJob(first.job.id);
  assert.deepEqual(await fixture.store.getMedia(first.job.id), []);
  const [record] = await fixture.store.getMedia(second.job.id);
  assert.deepEqual(await fixture.store.getMediaFile(second.job.id, record.sha256), png);
  assert.equal(await fixture.store.getMediaFile(first.job.id, record.sha256), null);
});

test('ZIP size is checked before assembling a buffer that cannot be imported', () => {
  assert.throws(() => createZip({ 'large.bin': png }, new Date(), { maxBytes: png.length }), { code: ERROR_CODES.INVALID_INPUT });
});
