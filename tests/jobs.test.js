import test from 'node:test';
import assert from 'node:assert/strict';

import { ExportJob, referencesFromText } from '../apps/userscript/src/export-job.js';
import { ImportJob } from '../apps/userscript/src/import-job.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';
import { AppError, ERROR_CODES } from '../apps/userscript/src/errors.js';
import {
  createArchive,
  createManifest,
  parseArchiveBytes,
} from '../apps/userscript/src/archive.js';

test('reference parser supports hash references and API-normalized leading PIDs', () => {
  assert.deepEqual(referencesFromText('#8395001 body'), ['8395001']);
  assert.deepEqual(referencesFromText('8395002 normalized body'), ['8395002']);
  assert.deepEqual(referencesFromText('ordinary text with 8395003 in the middle'), []);
});

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
  const previewProgress = [];
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async getAllFollowed({ onPage }) {
      onPage({ page: 1, count: 1, total: 1 });
      return { complete: true, items: [{ pid: 123456 }] };
    },
    async followHole(pid) {
      followed.push(pid);
      return { status: 'followed', pid };
    },
  };
  const store = new MemoryJobStore();
  const job = new ImportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
    onProgress: (event) => previewProgress.push(event),
  });
  const preview = await job.preview([file]);
  assert.equal(preview.accountFingerprint, 'fingerprint');
  assert.ok(previewProgress.some((event) => event.phase === 'archive_files'));
  assert.ok(previewProgress.some((event) => event.phase === 'remote_followed'));
  assert.deepEqual(preview.newPids, ['234567']);
  assert.equal(preview.alreadyFollowed.length, 1);
  assert.equal(preview.excludedReferenced, 0);
  const result = await job.execute(preview);
  assert.deepEqual(followed, ['234567']);
  assert.equal(result.audit.followed, 1);
  assert.equal(result.audit.failed, 0);
});

test('import preview excludes referenced context from follow candidates', async () => {
  const items = [
    {
      pid: '123456',
      source: 'followed',
      hole: { pid: 123456, text: 'followed', timestamp: 1 },
      comments: [],
      fetchStatus: 'ok',
    },
    {
      pid: '234567',
      source: 'referenced',
      hole: { pid: 234567, text: 'context only', timestamp: 2 },
      comments: [],
      fetchStatus: 'ok',
    },
  ];
  const manifest = createManifest({
    runId: 'import-sources',
    scope: { type: 'group' },
    complete: true,
    items,
    expectedHoles: 2,
  });
  const archive = createArchive({ manifest, items, includeReadable: false });
  const file = {
    name: archive.filename,
    size: archive.bytes.byteLength,
    async arrayBuffer() {
      return archive.bytes.slice().buffer;
    },
  };
  const job = new ImportJob({
    api: {
      scheduler: { resetRateLimitCount() {} },
      async getAllFollowed() {
        return { complete: true, items: [] };
      },
    },
    store: new MemoryJobStore(),
    accountFingerprint: 'fingerprint',
  });
  const preview = await job.preview([file]);
  assert.deepEqual(preview.allPids, ['123456']);
  assert.deepEqual(preview.newPids, ['123456']);
  assert.equal(preview.excludedReferenced, 1);
});

test('import execution refuses an incomplete remote follow snapshot', async () => {
  let followCalls = 0;
  const job = new ImportJob({
    api: {
      async followHole() {
        followCalls += 1;
        return { status: 'followed' };
      },
    },
    store: new MemoryJobStore(),
    accountFingerprint: 'fingerprint',
  });
  await assert.rejects(
    job.execute({
      accountFingerprint: 'fingerprint',
      remoteComplete: false,
      newPids: ['123456'],
    }),
    (error) => error.code === 'invalid_response',
  );
  assert.equal(followCalls, 0);
});

test('import execution keeps the in-memory job running until it is paused', async () => {
  const store = new MemoryJobStore();
  const progressStates = [];
  let job;
  job = new ImportJob({
    api: {
      scheduler: { resetRateLimitCount() {} },
      async followHole(pid) {
        return { status: 'followed', pid };
      },
    },
    store,
    accountFingerprint: 'fingerprint',
    onProgress(event) {
      if (event.pid) {
        progressStates.push(event.state);
        job.requestPause();
      }
    },
  });
  const preview = {
    accountFingerprint: 'fingerprint',
    archives: [],
    allPids: ['123456', '234567'],
    newPids: ['123456', '234567'],
    alreadyFollowed: [],
    duplicateCount: 0,
    excludedReferenced: 0,
    invalidFiles: [],
    remoteComplete: true,
  };

  const result = await job.execute(preview);

  assert.equal(result.paused, true);
  assert.deepEqual(progressStates, ['running']);
  assert.equal(result.job.state, 'paused');
  assert.equal(result.job.completed, 1);
  const storedJob = await store.getJob(result.job.id);
  assert.equal(storedJob.state, 'paused');
  assert.equal(storedJob.completed, 1);
});

test('import resume rebuilds progress from persisted PID items before continuing', async () => {
  const store = new MemoryJobStore();
  const jobId = 'crash-window-import';
  const preview = {
    accountFingerprint: 'fingerprint',
    archives: [],
    allPids: ['123456', '234567'],
    newPids: ['123456', '234567'],
    alreadyFollowed: [],
    duplicateCount: 0,
    excludedReferenced: 0,
    invalidFiles: [],
    remoteComplete: true,
  };
  await store.putJob({
    id: jobId,
    type: 'import',
    state: 'running',
    createdAt: Date.now(),
    accountFingerprint: 'fingerprint',
    pids: preview.newPids,
    preview,
    total: 2,
    completed: 0,
    results: [],
  });
  // Simulate a crash after the item transaction committed but before the job
  // progress transaction could be updated.
  await store.putItem(jobId, '123456', { pid: '123456', status: 'followed' });

  const calls = [];
  let synchronizedJob;
  const result = await new ImportJob({
    api: {
      scheduler: { resetRateLimitCount() {} },
      async followHole(pid) {
        calls.push(pid);
        synchronizedJob = await store.getJob(jobId);
        return { status: 'followed', pid };
      },
    },
    store,
    accountFingerprint: 'fingerprint',
  }).execute(preview, { jobId });

  assert.deepEqual(calls, ['234567']);
  assert.equal(synchronizedJob.state, 'running');
  assert.equal(synchronizedJob.completed, 1);
  assert.deepEqual(synchronizedJob.results, [{ pid: '123456', status: 'followed' }]);
  assert.equal(result.job.state, 'completed');
  assert.equal(result.job.completed, 2);
  assert.equal(result.job.results.length, 2);
  assert.equal((await store.getJob(jobId)).completed, 2);
});

test('import retry replaces failed PID results while preserving successful PIDs', async () => {
  const calls = [];
  let firstAttempt = true;
  const store = new MemoryJobStore();
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async followHole(pid) {
      calls.push(pid);
      if (pid === '123456' && firstAttempt) throw new Error('temporary failure');
      return { status: 'followed', pid };
    },
  };
  const preview = {
    accountFingerprint: 'fingerprint',
    archives: [],
    allPids: ['123456', '234567'],
    newPids: ['123456', '234567'],
    alreadyFollowed: [],
    duplicateCount: 0,
    excludedReferenced: 0,
    invalidFiles: [],
    remoteComplete: true,
  };
  const first = await new ImportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
  }).execute(preview);
  assert.equal(first.audit.failed, 1);

  firstAttempt = false;
  const retried = await new ImportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
  }).execute(preview, { jobId: first.job.id });

  assert.deepEqual(calls, ['123456', '234567', '123456']);
  assert.equal(retried.audit.followed, 2);
  assert.equal(retried.audit.failed, 0);
  assert.equal(retried.audit.results.length, 2);
  assert.deepEqual(
    retried.audit.results.map((result) => result.pid),
    ['123456', '234567'],
  );
  assert.equal((await store.getItems(first.job.id)).length, 2);
});

test('import retry re-enters followHole for an unknown result so it can reconcile first', async () => {
  let calls = 0;
  const store = new MemoryJobStore();
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async followHole(pid) {
      calls += 1;
      if (calls === 1) {
        throw new AppError(ERROR_CODES.UNKNOWN_RESULT, 'result unknown');
      }
      // followHole owns the GET-before-POST safety check; this represents its
      // retry-time GET finding that the first write actually succeeded.
      return { status: 'already_followed', pid };
    },
  };
  const preview = {
    accountFingerprint: 'fingerprint',
    archives: [],
    allPids: ['123456'],
    newPids: ['123456'],
    alreadyFollowed: [],
    duplicateCount: 0,
    excludedReferenced: 0,
    invalidFiles: [],
    remoteComplete: true,
  };
  const first = await new ImportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
  }).execute(preview);
  assert.equal(first.audit.unknown, 1);
  assert.equal(first.audit.failed, 0);
  assert.equal(first.audit.results[0].status, 'unknown');

  const retried = await new ImportJob({
    api,
    store,
    accountFingerprint: 'fingerprint',
  }).execute(preview, { jobId: first.job.id });

  assert.equal(calls, 2);
  assert.equal(retried.audit.unknown, 0);
  assert.equal(retried.audit.skipped, 1);
  assert.equal(retried.audit.results.length, 1);
  assert.equal(retried.audit.results[0].status, 'already_followed');
});

test('import execution rejects a preview created for another account', async () => {
  let followCalls = 0;
  const job = new ImportJob({
    api: {
      async followHole() {
        followCalls += 1;
        return { status: 'followed' };
      },
    },
    store: new MemoryJobStore(),
    accountFingerprint: 'current-account',
  });

  await assert.rejects(
    job.execute({
      accountFingerprint: 'preview-account',
      remoteComplete: true,
      newPids: ['123456'],
    }),
    (error) => error.code === ERROR_CODES.UNAUTHORIZED,
  );
  assert.equal(followCalls, 0);
});

test('import execution resumes a v1.4 job whose stored preview predates account binding', async () => {
  const store = new MemoryJobStore();
  const jobId = 'legacy-import-job';
  const preview = {
    archives: [],
    allPids: ['123456'],
    newPids: ['123456'],
    alreadyFollowed: [],
    duplicateCount: 0,
    excludedReferenced: 0,
    invalidFiles: [],
    remoteComplete: true,
  };
  await store.putJob({
    id: jobId,
    type: 'import',
    state: 'planning',
    createdAt: Date.now(),
    accountFingerprint: 'fingerprint',
    pids: preview.newPids,
    preview,
    total: 1,
    completed: 0,
    results: [],
  });

  const result = await new ImportJob({
    api: {
      scheduler: { resetRateLimitCount() {} },
      async followHole(pid) {
        return { status: 'followed', pid };
      },
    },
    store,
    accountFingerprint: 'fingerprint',
  }).execute(preview, { jobId });

  assert.equal(result.job.state, 'completed');
  assert.equal(result.audit.followed, 1);
});

test('import resume uses the preview and PID list saved in its checkpoint', async () => {
  const store = new MemoryJobStore();
  const storedPreview = {
    accountFingerprint: 'fingerprint',
    archives: [{ name: 'saved.zip', format: 'v2' }],
    allPids: ['123456'],
    newPids: ['123456'],
    alreadyFollowed: [],
    duplicateCount: 0,
    excludedReferenced: 0,
    invalidFiles: [],
    remoteComplete: true,
  };
  await store.putJob({
    id: 'saved-import',
    type: 'import',
    state: 'paused',
    accountFingerprint: 'fingerprint',
    pids: ['123456'],
    preview: storedPreview,
    total: 1,
    completed: 0,
    results: [],
  });
  const calls = [];
  const result = await new ImportJob({
    api: {
      scheduler: { resetRateLimitCount() {} },
      async followHole(pid) {
        calls.push(pid);
        return { status: 'followed', pid };
      },
    },
    store,
    accountFingerprint: 'fingerprint',
  }).execute(
    {
      accountFingerprint: 'fingerprint',
      archives: [{ name: 'stale.zip', format: 'v2' }],
      allPids: ['654321'],
      newPids: ['654321'],
      alreadyFollowed: [],
      duplicateCount: 0,
      excludedReferenced: 0,
      invalidFiles: [],
      remoteComplete: true,
    },
    { jobId: 'saved-import' },
  );

  assert.deepEqual(calls, ['123456']);
  assert.equal(result.audit.results[0].pid, '123456');
  assert.equal(result.audit.totalFiles, 1);
});

test('a 2000-hole export completes without comment requests when reply count is zero', async () => {
  const holes = Array.from({ length: 2000 }, (_, index) => ({
    pid: 10000 + index,
    text: `hole ${index}`,
    reply: 0,
    timestamp: index + 1,
  }));
  let commentCalls = 0;
  const api = {
    scheduler: { resetRateLimitCount() {} },
    async getAllFollowed() {
      return { complete: true, items: holes };
    },
    async getAllComments() {
      commentCalls += 1;
      return { complete: true, items: [] };
    },
  };
  const job = new ExportJob({
    api,
    store: new MemoryJobStore(),
    accountFingerprint: 'fingerprint',
  });
  const result = await job.run({ scope: { type: 'all' }, referenceMode: 'none' });
  assert.equal(result.manifest.counts.exportedHoles, 2000);
  assert.equal(result.manifest.complete, true);
  assert.equal(commentCalls, 0);
});
