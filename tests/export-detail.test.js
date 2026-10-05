import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeholeApi } from '../apps/userscript/src/api.js';
import { ExportJob } from '../apps/userscript/src/export-job.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';
import { parseArchiveBytes } from '../apps/userscript/src/archive.js';
import { readZip } from '../apps/userscript/src/zip.js';
import { AppError, ERROR_CODES } from '../apps/userscript/src/errors.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6x8AAAAASUVORK5CYII=', 'base64'));
const comments = [1, 2, 3].map((cid) => ({ cid, pid: 8422312, text: `comment ${cid}`,
  media_ids: cid === 3 ? '99' : '' }));

function fixture({ listReply = 1, detailReply = 3, store = new MemoryJobStore() } = {}) {
  const calls = [];
  const state = { detailError: null, commentError: null, visibleComments: comments };
  const api = new TreeholeApi({
    credentialsProvider: async () => ({ token: 'synthetic', uuid: 'synthetic' }),
    scheduler: {
      async requestJson(input) {
        const url = new URL(input);
        calls.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/api/follow_v2') return { code: 20000, data: {
          data: [{ pid: 8422312, reply: listReply, text: 'old list #123456', timestamp: 1 }],
          current_page: 1, last_page: 1, total: 1,
        } };
        if (url.pathname === '/api/pku/8422312/') {
          if (state.detailError) throw state.detailError;
          return { code: 20000, data: { pid: 8422312, reply: detailReply,
            text: 'fresh detail', timestamp: 1, media_ids: '88' } };
        }
        if (url.pathname === '/api/pku_comment_v3/8422312') {
          if (state.commentError) throw state.commentError;
          return { code: 20000, data: { data: state.visibleComments,
            current_page: 1, last_page: 1, total: state.visibleComments.length } };
        }
        throw new Error(`Unexpected route ${url.pathname}`);
      },
      async requestBinary(input, options, context) {
        calls.push(new URL(input).pathname + new URL(input).search);
        return context.readBody(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
      },
    },
  });
  return { calls, state, store,
    newJob: () => new ExportJob({ api, store, accountFingerprint: 'account' }) };
}

test('group export replaces stale list metadata with detail and inventories fresh media and references', async () => {
  const f = fixture();
  const result = await f.newJob().run({ scope: { type: 'group', bookmarkId: 'group' }, referenceMode: 'body' });
  const parsed = parseArchiveBytes(result.archive.bytes);
  assert.equal(result.manifest.complete, true);
  assert.equal(parsed.data.items.length, 1);
  const [item] = parsed.data.items;
  assert.equal(item.hole.reply, 3);
  assert.equal(item.hole.text, 'fresh detail');
  assert.equal(item.comments.length, 3);
  assert.equal(item.detailComplete, undefined);
  const files = readZip(result.archive.bytes);
  assert.match(new TextDecoder().decode(files['readable.txt']), /Reply:3/);
  const index = JSON.parse(new TextDecoder().decode(files['media/index.json']));
  assert.deepEqual(index.map((entry) => [entry.ownerType, entry.remoteId]), [['post', '88'], ['comment', '99']]);
  assert.ok(f.calls[1].startsWith('/api/pku/8422312/'));
  assert.equal(f.calls.some((call) => call.includes('/pku/123456/')), false);
});

test('zero replies in both list and detail never suppress actual comments or comment images', async () => {
  const f = fixture({ listReply: 0, detailReply: 0 });
  const result = await f.newJob().run();
  const [item] = parseArchiveBytes(result.archive.bytes).data.items;
  assert.equal(item.hole.reply, 0);
  assert.equal(item.comments.length, 3);
  assert.equal(result.manifest.complete, true);
  assert.equal(result.manifest.counts.media, 2);
  assert.ok(f.calls.includes('/chapi/api/v3/media/getImageBinary?id=99'));
});

test('comment opt-out still fetches current detail and never requests comments or their images', async () => {
  const f = fixture({ listReply: 0 });
  const result = await f.newJob().run({ includeComments: false });
  const [item] = parseArchiveBytes(result.archive.bytes).data.items;
  assert.equal(item.hole.reply, 3);
  assert.deepEqual(item.comments, []);
  assert.equal(f.calls.some((call) => call.includes('pku_comment_v3')), false);
  assert.equal(result.manifest.counts.media, 1);
  assert.equal(result.manifest.complete, true);
});

test('detail failure preserves list text and comments as partial and retry refreshes detail', async () => {
  const f = fixture();
  f.state.detailError = new AppError(ERROR_CODES.NOT_FOUND, 'unavailable');
  const first = await f.newJob().run({ includeMedia: false });
  const [fallback] = parseArchiveBytes(first.archive.bytes).data.items;
  assert.equal(first.manifest.complete, false);
  assert.equal(fallback.fetchStatus, 'partial');
  assert.equal(fallback.hole.text, 'old list #123456');
  assert.equal(fallback.comments.length, 3);
  assert.equal(first.manifest.errors[0].phase, 'hole');
  f.state.detailError = null;
  const retry = await f.newJob().run(null, { jobId: first.job.id });
  assert.equal(retry.manifest.complete, true);
  assert.equal(parseArchiveBytes(retry.archive.bytes).data.items[0].hole.reply, 3);
});

test('detail and comment failures are both reported and a failed zero-reply check is partial', async () => {
  const f = fixture({ listReply: 0, detailReply: 0 });
  f.state.detailError = new AppError(ERROR_CODES.NETWORK_ERROR, 'detail offline');
  f.state.commentError = new AppError(ERROR_CODES.NETWORK_ERROR, 'comments offline');
  const result = await f.newJob().run({ includeMedia: false });
  assert.equal(result.manifest.complete, false);
  assert.deepEqual(result.manifest.errors.map((error) => error.phase), ['hole', 'comments']);
  f.state.detailError = null;
  const retry = await f.newJob().run(null, { jobId: result.job.id });
  assert.equal(retry.manifest.complete, false);
  assert.deepEqual(retry.manifest.errors.map((error) => error.phase), ['comments']);
});

test('a short comment response cannot complete a detail that reports more replies', async () => {
  const f = fixture();
  f.state.visibleComments = comments.slice(0, 2);
  const result = await f.newJob().run({ includeMedia: false });
  assert.equal(result.manifest.complete, false);
  assert.equal(result.manifest.counts.comments, 2);
  assert.equal(result.manifest.errors[0].phase, 'comments');
  f.state.visibleComments = comments;
  const retry = await f.newJob().run(null, { jobId: result.job.id });
  assert.equal(retry.manifest.complete, true);
});

test('authorization failure during detail read preserves a checkpoint that can resume', async () => {
  const f = fixture();
  f.state.detailError = new AppError(ERROR_CODES.UNAUTHORIZED, 'expired');
  const job = f.newJob();
  await assert.rejects(job.run(), { code: ERROR_CODES.UNAUTHORIZED });
  assert.equal((await f.store.getJob(job.jobId)).state, 'paused');
  const [item] = await f.store.getItems(job.jobId);
  assert.equal(item.detailComplete, false);
  assert.equal(item.hole.text, 'old list #123456');
  f.state.detailError = null;
  assert.equal((await f.newJob().run(null, { jobId: job.jobId })).manifest.complete, true);
});

test('new verified checkpoints reuse detail and comments on resume', async () => {
  const f = fixture();
  const first = await f.newJob().run({ scope: { type: 'pids', pids: ['8422312'] } });
  const callCount = f.calls.length;
  const resumed = await f.newJob().run(null, { jobId: first.job.id });
  assert.equal(resumed.manifest.complete, true);
  assert.deepEqual(f.calls.slice(callCount), []);
});

test('legacy complete zero-reply checkpoints are verified once instead of silently skipping comments', async () => {
  const store = new MemoryJobStore();
  await store.putJob({ id: 'legacy-zero', type: 'export', state: 'paused',
    accountFingerprint: 'account', options: { scope: { type: 'all' }, includeComments: true }, errors: [] });
  await store.putItem('legacy-zero', '8422312', { pid: '8422312', source: 'followed',
    hole: { pid: 8422312, reply: 0, text: 'old checkpoint' }, comments: [],
    fetchStatus: 'ok', contentComplete: true });
  const f = fixture({ listReply: 0, store });
  const result = await f.newJob().run(null, { jobId: 'legacy-zero' });
  assert.equal(result.manifest.complete, true);
  assert.equal(result.manifest.counts.comments, 3);
  assert.equal(parseArchiveBytes(result.archive.bytes).data.items[0].hole.reply, 3);
  assert.equal(result.manifest.exportOptions.includeMedia, false);
});

test('detail API rejects missing or mismatched post identity', async () => {
  for (const data of [null, {}, [], { pid: 123456 }]) {
    const api = new TreeholeApi({ credentialsProvider: async () => ({ token: 'test', uuid: 'test' }),
      scheduler: { async requestJson() { return { code: 20000, data }; } } });
    await assert.rejects(api.getHole('8422312'), { code: ERROR_CODES.INVALID_RESPONSE });
  }
});
