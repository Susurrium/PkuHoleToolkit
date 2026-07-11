import test from 'node:test';
import assert from 'node:assert/strict';

import { ExportJob } from '../apps/userscript/src/export-job.js';
import { ImportJob } from '../apps/userscript/src/import-job.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';
import { parseArchiveBytes } from '../apps/userscript/src/archive.js';

test('export job skips comments for zero replies and produces a complete archive', async () => {
  let commentCalls = 0;
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async getAllFollowed() {
      return {
        complete: true,
        items: [
          { pid: 123456, text: 'first #345678', reply: 0, timestamp: 1 },
          { pid: 234567, text: 'second', reply: 1, timestamp: 2 },
        ],
      };
    },
    async getAllComments(pid) {
      commentCalls += 1;
      return { complete: true, items: [{ cid: 1, pid, name: 'Alice', text: 'hello' }] };
    },
    async getHole(pid) {
      return { pid: Number(pid), text: 'reference', reply: 0, timestamp: 3 };
    },
  };
  const store = new MemoryJobStore({ now: () => 1 });
  const job = new ExportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
    now: () => new Date('2026-07-11T00:00:00Z'),
  });
  const result = await job.run({
    scope: { type: 'all' },
    includeComments: true,
    referenceMode: 'body',
  });
  assert.equal(commentCalls, 1);
  assert.equal(result.manifest.complete, true);
  assert.equal(result.manifest.counts.exportedHoles, 3);
  assert.equal(parseArchiveBytes(result.archive.bytes).data.items.length, 3);
});

test('export job can pause and resume without duplicating completed items', async () => {
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async getAllFollowed() {
      return {
        complete: true,
        items: [
          { pid: 123456, reply: 0, timestamp: 1 },
          { pid: 234567, reply: 0, timestamp: 2 },
        ],
      };
    },
  };
  const store = new MemoryJobStore();
  let instance;
  instance = new ExportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
    onProgress(event) {
      if (event.type === 'progress' && event.completed === 1) instance.requestPause();
    },
  });
  const paused = await instance.run({ scope: { type: 'all' }, referenceMode: 'none' });
  assert.equal(paused.paused, true);
  const resumed = await new ExportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
  }).run(null, { jobId: paused.job.id });
  assert.equal(resumed.manifest.counts.exportedHoles, 2);
  assert.equal((await store.getItems(paused.job.id)).length, 2);
});

test('import preview deduplicates legacy files and execute records an audit', async () => {
  const legacy = JSON.stringify({
    holes: [{ pid: 123456 }, { pid: 234567 }, { pid: 234567 }],
    comments: [],
  });
  const file = {
    name: 'legacy.json',
    size: legacy.length,
    async arrayBuffer() {
      return new TextEncoder().encode(legacy).buffer;
    },
  };
  const followed = [];
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async getAllFollowed() {
      return { complete: true, items: [{ pid: 123456 }] };
    },
    async followHole(pid) {
      followed.push(pid);
      return { status: 'followed', pid };
    },
  };
  const store = new MemoryJobStore();
  const job = new ImportJob({ api, store, accountFingerprint: 'fingerprint' });
  const preview = await job.preview([file]);
  assert.deepEqual(preview.newPids, ['234567']);
  assert.equal(preview.alreadyFollowed.length, 1);
  const result = await job.execute(preview);
  assert.deepEqual(followed, ['234567']);
  assert.equal(result.audit.followed, 1);
  assert.equal(result.audit.failed, 0);
});
