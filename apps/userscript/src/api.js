import { API_BASE, LIMITS, PID_PATTERN } from './config.js';
import { createAuthHeaders } from './credentials.js';
import { AppError, ERROR_CODES, isAppError } from './errors.js';

export function normalizePid(value) {
  const pid = String(value ?? '').trim();
  if (!PID_PATTERN.test(pid)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, `非法 PID：${pid || '(空)'}`);
  }
  return pid;
}

function apiUrl(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

function unwrapPayload(payload, operation) {
  if (!payload || typeof payload !== 'object') {
    throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'API 响应不是对象', { operation });
  }
  if (payload.success === false || (payload.code !== undefined && payload.code !== 20000)) {
    const message = payload.message || payload.msg || 'API 请求失败';
    const code = /不存在|not\s*found/i.test(message)
      ? ERROR_CODES.NOT_FOUND
      : ERROR_CODES.BUSINESS_ERROR;
    throw new AppError(code, message, {
      operation,
      details: payload,
    });
  }
  return payload.data ?? payload;
}

function normalizePaginator(value, operation, fallbackPage = 1, requestedSize = null) {
  if (Array.isArray(value)) {
    return { items: value, nextPage: null, lastPage: 1, total: value.length };
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.data)) {
    throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'API 分页结构发生变化', {
      operation,
      details: value,
    });
  }
  const currentPage = Number(value.current_page || fallbackPage);
  if (!Number.isInteger(currentPage) || currentPage !== fallbackPage) {
    throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'API 返回了错误的分页页码', { operation });
  }
  const parsedLastPage = value.last_page == null ? NaN : Number(value.last_page);
  const lastPage = Number.isInteger(parsedLastPage) && parsedLastPage >= currentPage
    ? parsedLastPage
    : value.next_page_url
      ? Number.POSITIVE_INFINITY
      : currentPage;
  return {
    items: value.data,
    nextPage: value.next_page_url || currentPage < lastPage ? currentPage + 1 : null,
    lastPage,
    total: value.total != null && Number.isInteger(Number(value.total)) && Number(value.total) >= 0
      ? Number(value.total) : null,
    pageSize: Number.isInteger(Number(value.per_page)) && Number(value.per_page) > 0
      ? Math.min(requestedSize, Number(value.per_page)) : requestedSize,
  };
}

export class TreeholeApi {
  constructor({ scheduler, credentialsProvider, expectedAccountFingerprint = null, pageSizes = null }) {
    this.scheduler = scheduler;
    this.credentialsProvider = credentialsProvider;
    this.expectedAccountFingerprint = expectedAccountFingerprint;
    this.pageSizes = pageSizes || { followed: LIMITS.followedPageSize, comments: LIMITS.commentPageSize };
  }

  forAccount(accountFingerprint) {
    const expectedAccountFingerprint = String(accountFingerprint || '').trim();
    if (!expectedAccountFingerprint) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '无法绑定空账号指纹');
    }
    return new TreeholeApi({
      scheduler: this.scheduler,
      credentialsProvider: this.credentialsProvider,
      expectedAccountFingerprint,
      pageSizes: this.pageSizes,
    });
  }

  async request(path, { params, method = 'GET', kind = 'read', signal, operation, shouldPause }) {
    const currentCredentials = async () => {
      if (shouldPause?.()) throw new AppError(ERROR_CODES.PAUSED, '任务已暂停', { operation });
      const credentials = await this.credentialsProvider();
      if (this.expectedAccountFingerprint && credentials.accountFingerprint !== this.expectedAccountFingerprint) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, '登录账号已切换，任务已停止以避免跨账号操作', { operation });
      }
      return credentials;
    };
    const credentials = await currentCredentials();
    const body = await this.scheduler.requestJson(
      apiUrl(path, params),
      {
        method,
        credentials: 'include',
        headers: createAuthHeaders(credentials),
        referrer: 'https://treehole.pku.edu.cn/web/',
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      { operation, kind, signal, shouldPause, beforeSend: async () => ({ headers: createAuthHeaders(await currentCredentials()) }) },
    );
    return unwrapPayload(body, operation);
  }

  async listBookmarks(signal) {
    const value = await this.request('/bookmark', { signal, operation: 'list_bookmarks' });
    if (!Array.isArray(value)) {
      throw new AppError(ERROR_CODES.INVALID_RESPONSE, '收藏分组结构发生变化', {
        operation: 'list_bookmarks',
      });
    }
    return value.map((bookmark) => ({
      id: String(bookmark.id),
      name: String(bookmark.bookmark_name || bookmark.name || bookmark.id),
    }));
  }

  async readPage(path, options, category, legacySize) {
    let size = options.params.limit;
    let value;
    try {
      value = await this.request(path, options);
    } catch (error) {
      const rejectsLimit = /limit|per.page|分页|每页|条数/i.test(`${error.message} ${JSON.stringify(error.details)}`);
      const canFallBack = [400, 422].includes(error.status) ||
        (error.status == null && error.code === ERROR_CODES.BUSINESS_ERROR);
      if (size <= legacySize || !rejectsLimit || !canFallBack) throw error;
      size = legacySize;
      this.pageSizes[category] = size;
      value = await this.request(path, { ...options, params: { ...options.params, limit: size } });
    }
    const result = normalizePaginator(value, options.operation, options.params.page, size);
    if (result.pageSize) this.pageSizes[category] = result.pageSize;
    return { ...result, pageSize: result.pageSize || size };
  }

  async listFollowedPage({ page, limit = this.pageSizes.followed, bookmarkId, signal, shouldPause }) {
    return this.readPage('/follow_v2', {
      params: { page, limit, bookmark_id: bookmarkId },
      signal,
      shouldPause,
      operation: 'list_followed',
    }, 'followed', 25);
  }

  async listCommentsPage(pidValue, { page, limit = this.pageSizes.comments, signal, shouldPause }) {
    const pid = normalizePid(pidValue);
    return this.readPage(`/pku_comment_v3/${encodeURIComponent(pid)}`, {
      params: { page, limit, sort: 'asc' },
      signal,
      shouldPause,
      operation: 'list_comments',
    }, 'comments', 15);
  }

  async getHole(pidValue, signal, { shouldPause } = {}) {
    const pid = normalizePid(pidValue);
    return this.request(`/pku/${encodeURIComponent(pid)}/`, {
      signal,
      shouldPause,
      operation: 'get_hole',
    });
  }

  async getAllFollowed({ bookmarkId = null, signal, onPage = () => {}, shouldPause = () => false } = {}) {
    const seen = new Map();
    let page = 1;
    let expectedTotal = null;
    let pageSize = this.pageSizes.followed;
    let reason = 'followed_page_limit';
    while (page <= LIMITS.followedPages) {
      if (shouldPause()) { reason = 'paused'; break; }
      let result;
      try {
        result = await this.listFollowedPage({ page, bookmarkId, signal, shouldPause });
      } catch (error) {
        if (!isAppError(error, ERROR_CODES.PAUSED)) throw error;
        reason = 'paused'; break;
      }
      if (page > 1 && result.pageSize !== pageSize) {
        seen.clear(); page = 1; pageSize = result.pageSize; continue;
      }
      pageSize = result.pageSize;
      expectedTotal = result.total ?? expectedTotal;
      const previousCount = seen.size;
      for (const hole of result.items) {
        if (hole?.pid) seen.set(String(hole.pid), hole);
      }
      onPage({ page, count: seen.size, total: expectedTotal });
      if (!result.nextPage || page >= result.lastPage) {
        const complete = expectedTotal === null || seen.size >= expectedTotal;
        return {
          items: [...seen.values()],
          expectedTotal,
          complete,
          reason: complete ? null : 'followed_count_mismatch',
        };
      }
      if (seen.size === previousCount) { reason = 'followed_no_progress'; break; }
      page = result.nextPage;
    }
    return {
      items: [...seen.values()],
      expectedTotal,
      complete: false,
      reason,
    };
  }

  async getAllComments(pidValue, { signal, onPage = () => {}, shouldPause = () => false } = {}) {
    const pid = normalizePid(pidValue);
    const seen = new Map();
    const unkeyed = [];
    let page = 1;
    let expectedTotal = null;
    let pageSize = this.pageSizes.comments;
    let reason = 'comment_page_limit';
    while (page <= LIMITS.commentPages) {
      if (shouldPause()) { reason = 'paused'; break; }
      let result;
      try {
        result = await this.listCommentsPage(pid, { page, signal, shouldPause });
      } catch (error) {
        if (!isAppError(error, ERROR_CODES.PAUSED)) throw error;
        reason = 'paused'; break;
      }
      if (page > 1 && result.pageSize !== pageSize) {
        seen.clear(); unkeyed.length = 0; page = 1; pageSize = result.pageSize; continue;
      }
      pageSize = result.pageSize;
      expectedTotal = result.total ?? expectedTotal;
      const previousCount = seen.size + unkeyed.length;
      for (const comment of result.items) {
        const key = comment?.cid ?? comment?.id;
        if (key === undefined || key === null) unkeyed.push(comment);
        else seen.set(String(key), comment);
      }
      onPage({ page, count: seen.size + unkeyed.length, total: expectedTotal });
      if (!result.nextPage || page >= result.lastPage) {
        const count = seen.size + unkeyed.length;
        const complete = expectedTotal === null || count >= expectedTotal;
        return {
          items: [...seen.values(), ...unkeyed],
          expectedTotal,
          complete,
          reason: complete ? null : 'comment_count_mismatch',
        };
      }
      if (seen.size + unkeyed.length === previousCount) { reason = 'comment_no_progress'; break; }
      page = result.nextPage;
    }
    return {
      items: [...seen.values(), ...unkeyed],
      expectedTotal,
      complete: false,
      reason,
    };
  }

  async followHole(pidValue, signal) {
    const pid = normalizePid(pidValue);
    const before = await this.getHole(pid, signal);
    if (before?.is_follow) return { status: 'already_followed', pid };

    let postError = null;
    try {
      await this.request(`/pku_attention/${encodeURIComponent(pid)}`, {
        method: 'POST',
        kind: 'write',
        signal,
        operation: 'follow_hole',
      });
    } catch (error) {
      postError = error;
      if (
        isAppError(error, ERROR_CODES.UNAUTHORIZED) ||
        isAppError(error, ERROR_CODES.CANCELLED) ||
        isAppError(error, ERROR_CODES.RATE_LIMITED)
      ) {
        throw error;
      }
    }

    try {
      const after = await this.getHole(pid, signal);
      if (after?.is_follow) {
        return { status: postError ? 'followed_reconciled' : 'followed', pid };
      }
    } catch (reconcileError) {
      throw new AppError(ERROR_CODES.UNKNOWN_RESULT, `无法确认 #${pid} 的最终关注状态`, {
        cause: postError || reconcileError,
        operation: 'follow_hole',
        retryable: false,
      });
    }

    throw new AppError(ERROR_CODES.UNKNOWN_RESULT, `#${pid} 未处于关注状态`, {
      cause: postError,
      operation: 'follow_hole',
      retryable: false,
    });
  }
}
