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

function normalizePaginator(value, operation, fallbackPage = 1) {
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
  const parsedLastPage = Number(value.last_page);
  const lastPage = Number.isFinite(parsedLastPage)
    ? parsedLastPage
    : value.next_page_url
      ? Number.POSITIVE_INFINITY
      : currentPage;
  return {
    items: value.data,
    nextPage: value.next_page_url ? currentPage + 1 : null,
    lastPage,
    total: Number.isFinite(Number(value.total)) ? Number(value.total) : null,
  };
}

export class TreeholeApi {
  constructor({ scheduler, credentialsProvider }) {
    this.scheduler = scheduler;
    this.credentialsProvider = credentialsProvider;
  }

  async request(path, { params, method = 'GET', kind = 'read', signal, operation }) {
    const credentials = await this.credentialsProvider();
    const body = await this.scheduler.requestJson(
      apiUrl(path, params),
      {
        method,
        credentials: 'include',
        headers: createAuthHeaders(credentials),
        referrer: 'https://treehole.pku.edu.cn/web/',
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      { operation, kind, signal },
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

  async listFollowedPage({ page, limit = 25, bookmarkId, signal }) {
    const value = await this.request('/follow_v2', {
      params: { page, limit, bookmark_id: bookmarkId },
      signal,
      operation: 'list_followed',
    });
    return normalizePaginator(value, 'list_followed', page);
  }

  async listCommentsPage(pidValue, { page, limit = 15, signal }) {
    const pid = normalizePid(pidValue);
    const value = await this.request(`/pku_comment_v3/${encodeURIComponent(pid)}`, {
      params: { page, limit, sort: 'asc' },
      signal,
      operation: 'list_comments',
    });
    return normalizePaginator(value, 'list_comments', page);
  }

  async getHole(pidValue, signal) {
    const pid = normalizePid(pidValue);
    return this.request(`/pku/${encodeURIComponent(pid)}/`, {
      signal,
      operation: 'get_hole',
    });
  }

  async getAllFollowed({ bookmarkId = null, signal, onPage = () => {} } = {}) {
    const seen = new Map();
    let page = 1;
    let expectedTotal = null;
    while (page <= LIMITS.followedPages) {
      const result = await this.listFollowedPage({ page, bookmarkId, signal });
      expectedTotal = result.total ?? expectedTotal;
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
      page = result.nextPage;
    }
    return {
      items: [...seen.values()],
      expectedTotal,
      complete: false,
      reason: 'followed_page_limit',
    };
  }

  async getAllComments(pidValue, { signal, onPage = () => {} } = {}) {
    const pid = normalizePid(pidValue);
    const seen = new Map();
    const unkeyed = [];
    let page = 1;
    let expectedTotal = null;
    while (page <= LIMITS.commentPages) {
      const result = await this.listCommentsPage(pid, { page, signal });
      expectedTotal = result.total ?? expectedTotal;
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
      page = result.nextPage;
    }
    return {
      items: [...seen.values(), ...unkeyed],
      expectedTotal,
      complete: false,
      reason: 'comment_page_limit',
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
