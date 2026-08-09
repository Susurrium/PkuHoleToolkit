import test from 'node:test';
import assert from 'node:assert/strict';

import { ExportJob } from '../apps/userscript/src/export-job.js';
import { parseArchiveBytes } from '../apps/userscript/src/archive.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';

function createJob(overrides = {}) {
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async getAllFollowed() {
      return { complete: true, items: [] };
    },
    ...overrides,
  };
  return new ExportJob({
    api,
    store: new MemoryJobStore(),
    accountFingerprint: 'fingerprint',
    now: () => new Date('2026-07-11T12:00:00Z'),
  });
}

async function rejectsInvalidScope(scope) {
  await assert.rejects(
    createJob().run({ scope, referenceMode: 'none' }),
    (error) => error?.code === 'invalid_input',
  );
}

test('group export requires a non-empty bookmark ID', async () => {
  await rejectsInvalidScope({ type: 'group' });
  await rejectsInvalidScope({ type: 'group', bookmarkId: '   ' });

  let receivedBookmarkId = null;
  await createJob({
    async getAllFollowed({ bookmarkId }) {
      receivedBookmarkId = bookmarkId;
      return { complete: true, items: [] };
    },
  }).run({ scope: { type: 'group', bookmarkId: 0 }, referenceMode: 'none' });
  assert.equal(receivedBookmarkId, '0');
});

test('explicit PID export requires at least one valid PID', async () => {
  await rejectsInvalidScope({ type: 'pids' });
  await rejectsInvalidScope({ type: 'pids', pids: [] });
  await rejectsInvalidScope({ type: 'pids', pids: [''] });
});

test('date export requires an endpoint and valid ordered calendar dates', async () => {
  await rejectsInvalidScope({ type: 'date' });
  await rejectsInvalidScope({ type: 'date', startDate: '2026/07/11' });
  await rejectsInvalidScope({ type: 'date', startDate: '0000-01-01' });
  await rejectsInvalidScope({ type: 'date', endDate: '2026-02-30' });
  await rejectsInvalidScope({
    type: 'date',
    startDate: '2026-07-12',
    endDate: '2026-07-11',
  });
});

test('date export uses inclusive browser-local day boundaries', async () => {
  const localStart = new Date(2026, 6, 11, 0, 0, 0, 0).getTime() / 1000;
  const localEnd = new Date(2026, 6, 11, 23, 59, 59, 999).getTime() / 1000;
  const holes = [
    { pid: 100001, reply: 0, timestamp: localStart - 0.001 },
    { pid: 100002, reply: 0, timestamp: localStart },
    { pid: 100003, reply: 0, timestamp: localEnd },
    { pid: 100004, reply: 0, timestamp: localEnd + 0.001 },
  ];
  const result = await createJob({
    async getAllFollowed() {
      return { complete: true, items: holes };
    },
  }).run({
    scope: { type: 'date', startDate: '2026-07-11', endDate: '2026-07-11' },
    referenceMode: 'none',
  });

  assert.deepEqual(
    parseArchiveBytes(result.archive.bytes).data.items.map((item) => item.pid),
    ['100002', '100003'],
  );
});

test('date export accepts either an open start or open end', async () => {
  const boundary = new Date(2026, 6, 11, 0, 0, 0, 0).getTime() / 1000;
  const holes = [
    { pid: 100001, reply: 0, timestamp: boundary - 1 },
    { pid: 100002, reply: 0, timestamp: boundary },
  ];
  const api = {
    async getAllFollowed() {
      return { complete: true, items: holes };
    },
  };

  const fromResult = await createJob(api).run({
    scope: { type: 'date', startDate: '2026-07-11' },
    referenceMode: 'none',
  });
  assert.deepEqual(
    parseArchiveBytes(fromResult.archive.bytes).data.items.map((item) => item.pid),
    ['100002'],
  );

  const untilResult = await createJob(api).run({
    scope: { type: 'date', endDate: '2026-07-10' },
    referenceMode: 'none',
  });
  assert.deepEqual(
    parseArchiveBytes(untilResult.archive.bytes).data.items.map((item) => item.pid),
    ['100001'],
  );
});

test('unselected scope fields do not invalidate an export', async () => {
  const result = await createJob().run({
    scope: { type: 'all', pids: ['invalid'], startDate: 'not-a-date' },
    referenceMode: 'none',
  });

  assert.equal(result.job.state, 'completed');
  assert.deepEqual(result.job.options.scope, {
    type: 'all',
    bookmarkId: null,
    pids: [],
    startDate: null,
    endDate: null,
  });
});

test('resuming export rejects a missing or wrong-type task', async () => {
  const store = new MemoryJobStore();
  const job = new ExportJob({
    api: { scheduler: { resetRateLimitCount() {} } },
    store,
    accountFingerprint: 'fingerprint',
  });

  await assert.rejects(
    job.run(null, { jobId: 'missing' }),
    (error) => error?.code === 'invalid_input',
  );
  await store.putJob({
    id: 'import-task',
    type: 'import',
    state: 'paused',
    accountFingerprint: 'fingerprint',
  });
  await assert.rejects(
    job.run(null, { jobId: 'import-task' }),
    (error) => error?.code === 'invalid_input',
  );
});

test('resuming export keeps the scope saved in its checkpoint', async () => {
  const store = new MemoryJobStore();
  await store.putJob({
    id: 'paused-export',
    type: 'export',
    state: 'paused',
    accountFingerprint: 'fingerprint',
    options: {
      scope: { type: 'pids', pids: ['123456'] },
      includeComments: false,
      includeReadable: false,
      referenceMode: 'none',
    },
    errors: [],
    total: 1,
    completed: 0,
  });
  const requested = [];
  const job = new ExportJob({
    api: {
      scheduler: { resetRateLimitCount() {} },
      async getHole(pid) {
        requested.push(pid);
        return { pid, reply: 0, timestamp: 1 };
      },
    },
    store,
    accountFingerprint: 'fingerprint',
  });

  await job.run(
    { scope: { type: 'pids', pids: ['654321'] }, referenceMode: 'none' },
    { jobId: 'paused-export' },
  );

  assert.deepEqual(requested, ['123456']);
});
