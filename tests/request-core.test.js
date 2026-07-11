import test from 'node:test';
import assert from 'node:assert/strict';

import { RequestScheduler } from '../apps/userscript/src/scheduler.js';
import { TreeholeApi, normalizePid } from '../apps/userscript/src/api.js';
import { ERROR_CODES } from '../apps/userscript/src/errors.js';

function response(status, body = {}, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
  };
}

const policy = {
  readIntervalMs: 0,
  writeIntervalMs: 0,
  jitterMs: 0,
  timeoutMs: 1000,
  maxReadAttempts: 3,
  missingRetryAfterMs: 1,
};

test('read requests retry selected server errors at most three times', async () => {
  let calls = 0;
  const scheduler = new RequestScheduler({
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? response(503) : response(200, { ok: true });
    },
    sleepImpl: async () => {},
    random: () => 0,
    policy,
  });
  assert.deepEqual(await scheduler.requestJson('https://example.test'), { ok: true });
  assert.equal(calls, 3);
});

test('write requests are never automatically retried', async () => {
  let calls = 0;
  const scheduler = new RequestScheduler({
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('connection reset');
    },
    sleepImpl: async () => {},
    policy,
  });
  await assert.rejects(
    scheduler.requestJson('https://example.test', { method: 'POST' }, { kind: 'write' }),
    (error) => error.code === ERROR_CODES.NETWORK_ERROR,
  );
  assert.equal(calls, 1);
});

test('401 stops immediately without retry', async () => {
  let calls = 0;
  const scheduler = new RequestScheduler({
    fetchImpl: async () => {
      calls += 1;
      return response(401);
    },
    sleepImpl: async () => {},
    policy,
  });
  await assert.rejects(
    scheduler.requestJson('https://example.test'),
    (error) => error.code === ERROR_CODES.UNAUTHORIZED,
  );
  assert.equal(calls, 1);
});

test('a second 429 pauses the job', async () => {
  let calls = 0;
  const scheduler = new RequestScheduler({
    fetchImpl: async () => {
      calls += 1;
      return response(429, {}, { 'Retry-After': '0' });
    },
    sleepImpl: async () => {},
    policy,
  });
  await assert.rejects(
    scheduler.requestJson('https://example.test'),
    (error) => error.code === ERROR_CODES.RATE_LIMITED,
  );
  assert.equal(calls, 2);
});

test('PID validation blocks path and query injection', () => {
  assert.equal(normalizePid('123456'), '123456');
  for (const value of ['../logout#', '123?limit=999', '1', 'abcdef']) {
    assert.throws(() => normalizePid(value), (error) => error.code === ERROR_CODES.INVALID_INPUT);
  }
});

test('follow operation performs one POST and verifies final state', async () => {
  const calls = [];
  let detailCalls = 0;
  const scheduler = {
    async requestJson(url, options, context) {
      calls.push({ url, method: options.method, kind: context.kind });
      if (url.includes('/pku/123456/')) {
        detailCalls += 1;
        return { code: 20000, data: { pid: 123456, is_follow: detailCalls > 1 ? 1 : 0 } };
      }
      return { code: 20000, data: '关注成功' };
    },
  };
  const api = new TreeholeApi({
    scheduler,
    credentialsProvider: async () => ({ token: 't', uuid: 'u' }),
  });
  assert.deepEqual(await api.followHole('123456'), { status: 'followed', pid: '123456' });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(detailCalls, 2);
});

test('ambiguous POST failure is reconciled with one final read and no repeated write', async () => {
  let detailCalls = 0;
  let postCalls = 0;
  const scheduler = {
    async requestJson(url, options) {
      if (url.includes('/pku/345678/')) {
        detailCalls += 1;
        return { code: 20000, data: { pid: 345678, is_follow: detailCalls > 1 ? 1 : 0 } };
      }
      if (options.method === 'POST') {
        postCalls += 1;
        const error = new Error('response lost');
        error.code = ERROR_CODES.NETWORK_ERROR;
        throw error;
      }
      throw new Error('unexpected request');
    },
  };
  const api = new TreeholeApi({
    scheduler,
    credentialsProvider: async () => ({ token: 't', uuid: 'u' }),
  });
  assert.deepEqual(await api.followHole('345678'), {
    status: 'followed_reconciled',
    pid: '345678',
  });
  assert.equal(postCalls, 1);
  assert.equal(detailCalls, 2);
});

test('pagination reports incomplete data when the service total does not match', async () => {
  const scheduler = {
    async requestJson() {
      return {
        code: 20000,
        data: { data: [{ pid: 123456 }], total: 2, current_page: 1, last_page: 1 },
      };
    },
  };
  const api = new TreeholeApi({
    scheduler,
    credentialsProvider: async () => ({ token: 't', uuid: 'u' }),
  });
  const result = await api.getAllFollowed();
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'followed_count_mismatch');
});
