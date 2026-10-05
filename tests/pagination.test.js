import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeholeApi } from '../apps/userscript/src/api.js';
import { AppError, ERROR_CODES } from '../apps/userscript/src/errors.js';

function apiWith(handler) {
  return new TreeholeApi({
    scheduler: { requestJson: async (url, options, context) => ({ code: 20000, data: await handler(new URL(url), options, context) }) },
    credentialsProvider: async () => ({ token: 'test', uuid: 'test' }),
  });
}

test('200-row pages fetch all comments in sequence, including last_page-only pagination', async () => {
  const calls = [];
  const api = apiWith(async (url) => {
    const page = Number(url.searchParams.get('page'));
    calls.push({ page, limit: Number(url.searchParams.get('limit')) });
    return { current_page: page, last_page: 3, total: 450, per_page: 200,
      data: Array.from({ length: page === 3 ? 50 : 200 }, (_, i) => ({ cid: (page - 1) * 200 + i, pid: 123456 })) };
  });
  const result = await api.getAllComments('123456');
  assert.equal(result.complete, true); assert.equal(result.items.length, 450);
  assert.deepEqual(calls, [{ page: 1, limit: 200 }, { page: 2, limit: 200 }, { page: 3, limit: 200 }]);
});

test('followed and comment page limits fall back independently only on explicit limit rejection', async () => {
  const calls = [];
  const api = apiWith(async (url) => {
    const limit = Number(url.searchParams.get('limit')); calls.push([url.pathname, limit]);
    if (url.pathname === '/api/follow_v2' && limit > 25) {
      throw new AppError(ERROR_CODES.BUSINESS_ERROR, 'limit must be at most 25', { status: 422 });
    }
    return { data: [], current_page: 1, last_page: 1, total: 0 };
  });
  await api.getAllFollowed(); await api.getAllFollowed(); await api.getAllComments('123456');
  assert.deepEqual(calls.map((call) => call[1]), [200, 25, 25, 200]);
});

test('authentication and rate-limit errors cannot trigger pagination fallback', async () => {
  for (const code of [ERROR_CODES.UNAUTHORIZED, ERROR_CODES.RATE_LIMITED]) {
    let calls = 0;
    const api = apiWith(async () => { calls += 1; throw new AppError(code, 'limit test', { status: code === ERROR_CODES.UNAUTHORIZED ? 403 : 429 }); });
    await assert.rejects(api.getAllFollowed(), { code });
    assert.equal(calls, 1);
  }
});

test('a late page-size rejection restarts enumeration instead of skipping offsets', async () => {
  const calls = [];
  const api = apiWith(async (url) => {
    const page = Number(url.searchParams.get('page')), limit = Number(url.searchParams.get('limit'));
    calls.push([page, limit]);
    if (page === 2 && limit === 200) throw new AppError(ERROR_CODES.BUSINESS_ERROR, 'invalid limit', { status: 400 });
    return { current_page: page, per_page: limit, last_page: Math.ceil(205 / limit), total: 205,
      data: Array.from({ length: Math.min(limit, 205 - (page - 1) * limit) }, (_, i) => ({ pid: 10000 + (page - 1) * limit + i })) };
  });
  const result = await api.getAllFollowed();
  assert.equal(result.complete, true); assert.equal(result.items.length, 205);
  assert.deepEqual(calls.slice(0, 4), [[1, 200], [2, 200], [2, 25], [1, 25]]);
  assert.equal(new Set(result.items.map((item) => item.pid)).size, 205);
});

test('server-reported smaller pages are used for the next request', async () => {
  const limits = [];
  const api = apiWith(async (url) => {
    const page = Number(url.searchParams.get('page')); limits.push(Number(url.searchParams.get('limit')));
    return { current_page: page, per_page: 25, last_page: 2, total: 30,
      data: Array.from({ length: page === 1 ? 25 : 5 }, (_, i) => ({ pid: 10000 + (page - 1) * 25 + i })) };
  });
  assert.equal((await api.getAllFollowed()).complete, true);
  assert.deepEqual(limits, [200, 25]);
});

test('repeated comment pages terminate as incomplete rather than looping to the page cap', async () => {
  let calls = 0;
  const api = apiWith(async (url) => ({ data: [{ cid: 1, pid: 123456 }], current_page: ++calls, last_page: 10, total: 10, next_page_url: `?page=${calls + 1}` }));
  const result = await api.getAllComments('123456');
  assert.equal(result.complete, false); assert.equal(result.reason, 'comment_no_progress');
  assert.equal(calls, 2);
});

test('pause after a comment page preserves the collected rows for the whole-post checkpoint', async () => {
  let paused = false, calls = 0;
  const api = apiWith(async () => { calls += 1; return { data: [{ cid: 1, pid: 123456 }], current_page: 1, last_page: 2, total: 2 }; });
  const result = await api.getAllComments('123456', { shouldPause: () => paused, onPage: () => { paused = true; } });
  assert.equal(result.complete, false); assert.equal(result.reason, 'paused');
  assert.equal(result.items.length, 1); assert.equal(calls, 1);
});

test('null total is unknown, not a fabricated zero count', async () => {
  const api = apiWith(async () => ({ data: [{ pid: 123456 }], current_page: 1, last_page: 1, total: null }));
  const result = await api.getAllFollowed();
  assert.equal(result.expectedTotal, null); assert.equal(result.complete, true);
});
