import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { RequestScheduler } from '../apps/userscript/src/scheduler.js';
import { TreeholeApi } from '../apps/userscript/src/api.js';
import { ExportJob } from '../apps/userscript/src/export-job.js';
import { MemoryJobStore } from '../apps/userscript/src/storage.js';
import { parseArchiveBytes } from '../apps/userscript/src/archive.js';
import { AppError, ERROR_CODES } from '../apps/userscript/src/errors.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(status = 200, body = {}, headers = {}) {
  return { status, ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null }, json: async () => body };
}

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail('expected asynchronous progress did not arrive');
}

function clockScheduler(options = {}) {
  let time = 0;
  return new RequestScheduler({
    now: () => time, random: () => 0.5,
    sleepImpl: async (delay) => { time += delay; }, ...options,
  });
}

test('six reads overlap, hold slots through JSON parsing, and share randomized start spacing', async () => {
  const bodies = [], starts = [];
  let active = 0, peak = 0;
  const scheduler = clockScheduler({ fetchImpl: async () => {
    starts.push(scheduler.now());
    active += 1; peak = Math.max(peak, active);
    const body = deferred(); bodies.push(body);
    return { ...response(), json: async () => { await body.promise; active -= 1; return {}; } };
  } });
  const requests = Array.from({ length: 8 }, () => scheduler.requestJson('https://example.test'));
  await until(() => bodies.length === 6);
  assert.equal(active, 6);
  assert.deepEqual(starts, [0, 250, 500, 750, 1000, 1250]);
  bodies[0].resolve();
  await until(() => bodies.length === 7);
  assert.equal(active, 6);
  bodies[1].resolve();
  await until(() => bodies.length === 8);
  bodies.forEach((body) => body.resolve());
  await Promise.all(requests);
  assert.equal(peak, 6);
  assert.ok(starts.every((time, index) => !index || time - starts[index - 1] === 250));
});

test('writes remain serial and retain their longer random spacing', async () => {
  const gates = [], starts = [];
  const scheduler = clockScheduler({ fetchImpl: async () => {
    starts.push(scheduler.now());
    const gate = deferred(); gates.push(gate);
    await gate.promise; return response();
  } });
  const requests = [1, 2].map(() => scheduler.requestJson('https://example.test', { method: 'POST' }, { kind: 'write' }));
  await until(() => gates.length === 1);
  await nextTurn(); assert.equal(gates.length, 1);
  gates[0].resolve();
  await until(() => gates.length === 2);
  gates[1].resolve(); await Promise.all(requests);
  assert.deepEqual(starts, [0, 1150]);
});

test('429 blocks the whole queue and one probe recovers it; stale successes cannot reopen it', async () => {
  let time = 0;
  const calls = [], sleeps = [];
  const scheduler = new RequestScheduler({
    now: () => time, policy: { readIntervalMs: 0, readJitterMs: 0, maxReadConcurrent: 2 },
    sleepImpl: (delay) => { const gate = deferred(); sleeps.push({ delay, gate }); return gate.promise; },
    fetchImpl: (url) => { const gate = deferred(); calls.push({ url, gate }); return gate.promise; },
  });
  const requests = ['a', 'b', 'c'].map((name) => scheduler.requestJson(`https://example.test/${name}`));
  await until(() => calls.length === 2);
  calls[0].gate.resolve(response(429, {}, { 'Retry-After': '1' }));
  await until(() => sleeps.length === 1);
  assert.equal(sleeps[0].delay, 1000);
  calls[1].gate.resolve(response());
  await nextTurn();
  assert.equal(calls.length, 2);
  assert.equal(scheduler.recovering, true);
  time = 1000; sleeps[0].gate.resolve();
  await until(() => calls.length === 3);
  await nextTurn(); assert.equal(calls.length, 3, 'only the probe may start');
  calls[2].gate.resolve(response());
  await until(() => calls.length === 4);
  calls[3].gate.resolve(response());
  await Promise.all(requests);
  assert.equal(scheduler.recovering, false);
});

test('separate recovered 429s do not accumulate into an unrelated task pause', async () => {
  let count = 0;
  const scheduler = clockScheduler({ fetchImpl: async () => response(++count % 2 ? 429 : 200, {}, { 'Retry-After': '1' }) });
  await scheduler.requestJson('https://example.test/a');
  await scheduler.requestJson('https://example.test/b');
  assert.equal(count, 4);
});

test('cancelling a queued read does not wait for an occupied slot', async () => {
  const gate = deferred(); let calls = 0;
  const scheduler = clockScheduler({ policy: { maxReadConcurrent: 1 }, fetchImpl: async () => {
    calls += 1; await gate.promise; return response();
  } });
  const active = scheduler.requestJson('https://example.test/active');
  await until(() => calls === 1);
  const controller = new AbortController();
  const rejection = assert.rejects(scheduler.requestJson('https://example.test/queued', {}, { signal: controller.signal }), { code: ERROR_CODES.CANCELLED });
  controller.abort(); await rejection;
  assert.equal(calls, 1);
  gate.resolve(); await active;
});

test('pause removes queued work even during a long rate-limit wait', async () => {
  let paused = false, calls = 0;
  const scheduler = new RequestScheduler({ policy: { maxReadAttempts: 1 }, fetchImpl: async () => {
    calls += 1; return response(429, {}, { 'Retry-After': '60' });
  } });
  await assert.rejects(scheduler.requestJson('https://example.test/limited'), { code: ERROR_CODES.RATE_LIMITED });
  const rejection = assert.rejects(scheduler.requestJson('https://example.test/queued', {}, { shouldPause: () => paused }), { code: ERROR_CODES.PAUSED });
  await nextTurn(); paused = true; scheduler.pausePending(); await rejection;
  assert.equal(calls, 1);
  assert.equal(scheduler.recovering, true);
});

test('credentials are rechecked when a queued request is actually sent', async () => {
  const gate = deferred(); let calls = 0, account = 'a';
  const scheduler = clockScheduler({ policy: { maxReadConcurrent: 1 }, fetchImpl: async () => {
    calls += 1; await gate.promise; return response(200, { code: 20000, data: {} });
  } });
  const active = scheduler.requestJson('https://example.test/active');
  await until(() => calls === 1);
  const api = new TreeholeApi({ scheduler,
    credentialsProvider: async () => ({ token: 'test', uuid: account, accountFingerprint: account }),
  }).forAccount('a');
  const rejection = assert.rejects(api.getHole('123456'), { code: ERROR_CODES.UNAUTHORIZED });
  await until(() => scheduler.queue.length === 1);
  account = 'b'; gate.resolve(); await active; await rejection;
  assert.equal(calls, 1);
});

function holes(count, reply = 1) {
  return Array.from({ length: count }, (_, i) => ({ pid: 10000 + i, text: `post ${i}`, reply, timestamp: i + 1 }));
}

test('six posts run together, refill on completion, serialize progress and retain archive order', async () => {
  const source = holes(8), gates = new Map(), events = [];
  const store = new MemoryJobStore();
  const job = new ExportJob({ store, accountFingerprint: 'test', onProgress: (event) => events.push(event), api: {
    getAllFollowed: async () => ({ complete: true, items: source }),
    getHole: async (pid) => source.find((hole) => String(hole.pid) === pid),
    getAllComments: async (pid) => {
      const gate = deferred(); gates.set(pid, gate); await gate.promise;
      return { complete: true, items: [{ cid: Number(pid), pid, text: 'comment' }] };
    },
  } });
  const running = job.run();
  await until(() => gates.size === 6);
  assert.equal(gates.has('10006'), false);
  gates.get('10005').resolve();
  await until(() => gates.size === 7);
  gates.get('10004').resolve();
  await until(() => gates.size === 8);
  [...gates.values()].reverse().forEach((gate) => gate.resolve());
  const result = await running;
  assert.deepEqual(parseArchiveBytes(result.archive.bytes).data.items.map((item) => item.pid), source.map((hole) => String(hole.pid)));
  assert.deepEqual(events.filter((event) => event.type === 'progress').map((event) => event.completed), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(events.filter((event) => event.type === 'comments').every((event) => event.total === 8));
  assert.equal((await store.getJob(result.job.id)).completed, 8);
});

test('explicit PID detail and comment work is pipelined rather than planning details serially', async () => {
  const source = holes(7), gates = new Map(), comments = [];
  const job = new ExportJob({ store: new MemoryJobStore(), accountFingerprint: 'test', api: {
    getHole: async (pid) => { const gate = deferred(); gates.set(pid, gate); await gate.promise; return source.find((hole) => String(hole.pid) === pid); },
    getAllComments: async (pid) => { comments.push(pid); return { complete: true, items: [] }; },
  } });
  const running = job.run({ scope: { type: 'pids', pids: source.map((hole) => hole.pid) } });
  await until(() => gates.size === 6);
  gates.get('10000').resolve();
  await until(() => gates.size === 7);
  assert.deepEqual(comments, ['10000']);
  gates.forEach((gate) => gate.resolve()); await running;
});

test('pause drains the six active posts, does not dispatch a seventh, and resume skips saved posts', async () => {
  const source = holes(8, 0), gates = [], calls = [], store = new MemoryJobStore();
  const api = {
    getAllFollowed: async () => ({ complete: true, items: source }),
    getHole: async (pid) => source.find((hole) => String(hole.pid) === pid),
    getAllComments: async (pid) => {
      calls.push(pid); const gate = deferred(); gates.push(gate); await gate.promise;
      return { complete: true, items: [] };
    },
  };
  const job = new ExportJob({ api, store, accountFingerprint: 'test' });
  const running = job.run(); await until(() => gates.length === 6);
  job.requestPause(); gates.forEach((gate) => gate.resolve());
  const paused = await running;
  assert.equal(paused.paused, true); assert.equal(calls.length, 6);
  api.getAllComments = async (pid) => { calls.push(pid); return { complete: true, items: [] }; };
  const resumed = await new ExportJob({ api, store, accountFingerprint: 'test' }).run(null, { jobId: paused.job.id });
  assert.equal(resumed.manifest.counts.exportedHoles, 8);
  assert.equal(calls.length, 8);
});

test('fatal auth errors abort peers and wait for late work before saving the terminal state', async () => {
  const gates = [], store = new MemoryJobStore(); let settled = false;
  const job = new ExportJob({ store, accountFingerprint: 'test', api: {
    getAllFollowed: async () => ({ complete: true, items: holes(8) }),
    getHole: async (pid) => holes(8).find((hole) => String(hole.pid) === pid),
    getAllComments: async () => { const gate = deferred(); gates.push(gate); return gate.promise; },
  } });
  const rejection = assert.rejects(job.run().finally(() => { settled = true; }), { code: ERROR_CODES.UNAUTHORIZED });
  await until(() => gates.length === 6);
  gates[0].reject(new AppError(ERROR_CODES.UNAUTHORIZED, 'expired'));
  await nextTurn(); assert.equal(settled, false);
  gates.slice(1).forEach((gate) => gate.resolve({ complete: true, items: [] }));
  await rejection;
  assert.equal(gates.length, 6);
  const checkpoints = await store.getItems(job.jobId);
  assert.equal(checkpoints.length, 6);
  assert.ok(checkpoints.every((item) => item.contentComplete === false && item.fetchStatus === 'partial'));
  assert.equal((await store.getJob(job.jobId)).state, 'paused');
});

test('reference fetching runs six workers and does not expand references recursively on resume', async () => {
  const gates = new Map(), store = new MemoryJobStore();
  const references = Array.from({ length: 8 }, (_, i) => String(20000 + i));
  const api = {
    getAllFollowed: async () => ({ complete: true, items: [{ pid: 10000, reply: 0, text: references.map((pid) => `#${pid}`).join(' ') }] }),
    getAllComments: async () => ({ complete: true, items: [] }),
    getHole: async (pid) => {
      if (pid === '10000') return { pid, reply: 0, text: references.map((reference) => `#${reference}`).join(' ') };
      const gate = deferred(); gates.set(pid, gate); await gate.promise;
      return { pid, reply: 0, text: '#30000' };
    },
  };
  const job = new ExportJob({ api, store, accountFingerprint: 'test' });
  const running = job.run({ referenceMode: 'body' });
  await until(() => gates.size === 6);
  job.requestPause(); gates.forEach((gate) => gate.resolve());
  const paused = await running;
  assert.equal(paused.paused, true);
  assert.equal((await store.getItems(paused.job.id)).length, 7);
  const resumedCalls = [];
  api.getHole = async (pid) => { resumedCalls.push(pid); return { pid, reply: 0, text: '#30000' }; };
  const result = await new ExportJob({ api, store, accountFingerprint: 'test' }).run(null, { jobId: paused.job.id });
  assert.deepEqual(resumedCalls, references.slice(6));
  assert.equal(result.manifest.complete, true);
  assert.deepEqual(parseArchiveBytes(result.archive.bytes).data.items.map((item) => item.pid), ['10000', ...references]);
});

test('cancelling six active reads releases every slot without dispatching queued work', async () => {
  const controller = new AbortController(); let calls = 0;
  const scheduler = clockScheduler({ fetchImpl: async (_url, { signal }) => {
    calls += 1;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return response();
  } });
  const requests = Array.from({ length: 8 }, () => scheduler.requestJson('https://example.test', {}, { signal: controller.signal }));
  const settled = Promise.allSettled(requests);
  await until(() => calls === 6);
  controller.abort();
  const results = await settled;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === ERROR_CODES.CANCELLED));
  assert.equal(calls, 6);
  assert.equal(scheduler.inFlight, 0);
  assert.equal(scheduler.queue.length, 0);
});
