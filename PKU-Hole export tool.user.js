// ==UserScript==
// @name         PKU-Hole export tool
// @name:zh-CN   北大树洞归档与关注迁移工具
// @author       WindMan, Susurrium
// @namespace    https://github.com/Susurrium/PkuHoleToolkit
// @version      1.3.0
// @license      MIT
// @description  安全、可恢复地导入/导出北大树洞关注列表
// @match        https://treehole.pku.edu.cn/web/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      127.0.0.1
// @run-at       document-end
// @homepageURL  https://github.com/Susurrium/PkuHoleToolkit
// @supportURL   https://github.com/Susurrium/PkuHoleToolkit/issues
// ==/UserScript==

// GENERATED FILE. Edit apps/userscript/src instead of this bundle.

(() => {
  'use strict';

// ---- config.js ----
const APP_VERSION = '1.3.0';
const API_ORIGIN = 'https://treehole.pku.edu.cn';
const API_BASE = `${API_ORIGIN}/api`;
const JOB_DB_NAME = 'pku-hole-tool';
const JOB_DB_VERSION = 1;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PID_PATTERN = /^\d{5,7}$/;
const REFERENCE_PATTERN = /#(\d{5,7})\b/g;
const LEADING_REFERENCE_PATTERN = /^(\d{5,7})(?=\s)/;

const REQUEST_POLICY = Object.freeze({
  readIntervalMs: 600,
  writeIntervalMs: 1000,
  jitterMs: 300,
  timeoutMs: 20_000,
  maxReadAttempts: 3,
  missingRetryAfterMs: 60_000,
});

const LIMITS = Object.freeze({
  followedPages: 1024,
  commentPages: 500,
  maxReferencedPids: 2000,
  confirmReferencedPids: 200,
  maxImportPids: 20_000,
  maxArchiveBytes: 200 * 1024 * 1024,
  maxUncompressedBytes: 500 * 1024 * 1024,
});

const JOB_STATES = Object.freeze({
  PLANNING: 'planning',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});


// ---- errors.js ----
const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'not_found',
  UNAUTHORIZED: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  NETWORK_ERROR: 'network_error',
  TIMEOUT: 'timeout',
  INVALID_RESPONSE: 'invalid_response',
  BUSINESS_ERROR: 'business_error',
  UNKNOWN_RESULT: 'unknown_result',
  CANCELLED: 'cancelled',
  INVALID_INPUT: 'invalid_input',
  STORAGE_ERROR: 'storage_error',
});

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = Boolean(options.retryable);
    this.operation = options.operation ?? null;
    this.details = options.details ?? null;
  }
}

function isAppError(error, code = null) {
  return error instanceof AppError && (code === null || error.code === code);
}

function toErrorRecord(error, fallback = {}) {
  const normalized =
    error instanceof AppError
      ? error
      : new AppError(ERROR_CODES.NETWORK_ERROR, error?.message || '未知错误', {
          cause: error,
          retryable: true,
        });
  return {
    code: normalized.code,
    message: normalized.message,
    operation: normalized.operation,
    status: normalized.status,
    retryable: normalized.retryable,
    ...fallback,
  };
}

function throwIfAborted(signal, operation = null) {
  if (signal?.aborted) {
    throw new AppError(ERROR_CODES.CANCELLED, '操作已取消', { operation });
  }
}


// ---- credentials.js ----
function parseCookieString(cookieString = '') {
  const result = {};
  for (const rawPair of cookieString.split(';')) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);
    try {
      result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      result[rawKey] = rawValue;
    }
  }
  return result;
}

async function sha256Hex(value, cryptoObject) {
  if (!cryptoObject?.subtle) {
    throw new AppError(ERROR_CODES.INVALID_RESPONSE, '当前浏览器不支持安全账号指纹');
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoObject.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function getCredentials({
  documentObject = globalThis.document,
  storage = globalThis.localStorage,
  cryptoObject = globalThis.crypto,
} = {}) {
  const cookies = parseCookieString(documentObject?.cookie || '');
  const token = cookies.pku_token;
  const uuid = storage?.getItem('pku-uuid');
  if (!token || !uuid) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, '登录凭证缺失，请重新登录北大树洞', {
      retryable: false,
      operation: 'credentials',
    });
  }
  return {
    token,
    uuid,
    accountFingerprint: await sha256Hex(uuid, cryptoObject),
  };
}

function createAuthHeaders(credentials, extra = {}) {
  if (!credentials?.token || !credentials?.uuid) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, '登录凭证无效');
  }
  return {
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${credentials.token}`,
    uuid: credentials.uuid,
    ...extra,
  };
}


// ---- scheduler.js ----
function defaultSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError(ERROR_CODES.CANCELLED, '操作已取消'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError(ERROR_CODES.CANCELLED, '操作已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMilliseconds(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}

function isRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

class RequestScheduler {
  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    sleepImpl = defaultSleep,
    now = Date.now,
    random = Math.random,
    policy = REQUEST_POLICY,
    onRateLimit = () => {},
  } = {}) {
    if (!fetchImpl) throw new TypeError('fetchImpl is required');
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.now = now;
    this.random = random;
    this.policy = { ...REQUEST_POLICY, ...policy };
    this.onRateLimit = onRateLimit;
    this.queue = Promise.resolve();
    this.lastStartedAt = 0;
    this.rateLimitCount = 0;
  }

  resetRateLimitCount() {
    this.rateLimitCount = 0;
  }

  async enqueue(kind, signal, callback) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      throwIfAborted(signal);
      const interval =
        kind === 'write' ? this.policy.writeIntervalMs : this.policy.readIntervalMs;
      const jitter = Math.floor(this.random() * (this.policy.jitterMs + 1));
      const remaining = this.lastStartedAt + interval + jitter - this.now();
      if (remaining > 0) await this.sleepImpl(remaining, signal);
      this.lastStartedAt = this.now();
      return await callback();
    } finally {
      release();
    }
  }

  async fetchAttempt(url, options, context) {
    return this.enqueue(context.kind, context.signal, async () => {
      const controller = new AbortController();
      let externallyAborted = false;
      const onAbort = () => {
        externallyAborted = true;
        controller.abort(context.signal?.reason);
      };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort('timeout'), this.policy.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
        let body;
        try {
          body = await response.json();
        } catch (error) {
          if (!response.ok) body = null;
          else {
            throw new AppError(ERROR_CODES.INVALID_RESPONSE, '服务器返回了无法解析的数据', {
              cause: error,
              status: response.status,
              retryable: context.kind === 'read',
              operation: context.operation,
            });
          }
        }
        return { response, body };
      } catch (error) {
        if (externallyAborted || context.signal?.aborted) {
          throw new AppError(ERROR_CODES.CANCELLED, '操作已取消', {
            cause: error,
            operation: context.operation,
          });
        }
        if (error instanceof AppError) throw error;
        throw new AppError(ERROR_CODES.NETWORK_ERROR, '网络请求失败或超时', {
          cause: error,
          retryable: context.kind === 'read',
          operation: context.operation,
        });
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
      }
    });
  }

  async requestJson(url, options = {}, context = {}) {
    const normalized = {
      operation: context.operation || 'request',
      kind: context.kind === 'write' ? 'write' : 'read',
      signal: context.signal,
    };
    const maxAttempts =
      normalized.kind === 'write' ? 1 : Math.max(1, this.policy.maxReadAttempts);
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(normalized.signal, normalized.operation);
      try {
        const { response, body } = await this.fetchAttempt(url, options, normalized);
        const status = response.status;
        if (response.ok) return body;

        if (status === 401 || status === 403) {
          throw new AppError(ERROR_CODES.UNAUTHORIZED, '登录已过期或没有访问权限', {
            status,
            operation: normalized.operation,
          });
        }
        if (status === 404) {
          throw new AppError(ERROR_CODES.NOT_FOUND, '目标不存在', {
            status,
            operation: normalized.operation,
          });
        }
        if (status === 429) {
          this.rateLimitCount += 1;
          const retryAfter =
            retryAfterMilliseconds(response.headers?.get?.('Retry-After'), this.now) ??
            this.policy.missingRetryAfterMs;
          this.onRateLimit({ retryAfter, count: this.rateLimitCount });
          if (this.rateLimitCount >= 2 || normalized.kind === 'write') {
            throw new AppError(ERROR_CODES.RATE_LIMITED, '请求过于频繁，任务已暂停', {
              status,
              retryable: true,
              operation: normalized.operation,
              details: { retryAfter },
            });
          }
          if (attempt < maxAttempts) {
            await this.sleepImpl(retryAfter, normalized.signal);
            continue;
          }
        }

        throw new AppError(ERROR_CODES.BUSINESS_ERROR, `HTTP ${status}`, {
          status,
          retryable: normalized.kind === 'read' && isRetryableStatus(status),
          operation: normalized.operation,
          details: body,
        });
      } catch (error) {
        lastError = error;
        const canRetry =
          normalized.kind === 'read' &&
          error instanceof AppError &&
          error.retryable &&
          error.code !== ERROR_CODES.RATE_LIMITED &&
          attempt < maxAttempts;
        if (!canRetry) throw error;
        const delay = 1000 * 2 ** (attempt - 1) + Math.floor(this.random() * 300);
        await this.sleepImpl(delay, normalized.signal);
      }
    }
    throw lastError;
  }
}


// ---- api.js ----
function normalizePid(value) {
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

class TreeholeApi {
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


// ---- zip.js ----
const ZIP_SIGNATURES = Object.freeze({
  LOCAL: 0x04034b50,
  CENTRAL: 0x02014b50,
  END: 0x06054b50,
});

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crcTable[value] = crc >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value));
}

function safeArchiveName(name) {
  const normalized = String(name).replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('../') ||
    normalized.includes('/..')
  ) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, `不安全的归档路径：${name}`);
  }
  return normalized;
}

function createZip(entries, date = new Date()) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const dos = dosDateTime(date);

  for (const [rawName, rawData] of Object.entries(entries)) {
    const name = safeArchiveName(rawName);
    const nameBytes = new TextEncoder().encode(name);
    const data = asBytes(rawData);
    const checksum = crc32(data);
    const localHeader = new Uint8Array([
      ...uint32(ZIP_SIGNATURES.LOCAL),
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(dos.time),
      ...uint16(dos.date),
      ...uint32(checksum),
      ...uint32(data.length),
      ...uint32(data.length),
      ...uint16(nameBytes.length),
      ...uint16(0),
    ]);
    const localRecord = concatBytes([localHeader, nameBytes, data]);
    localParts.push(localRecord);

    const centralHeader = new Uint8Array([
      ...uint32(ZIP_SIGNATURES.CENTRAL),
      ...uint16(20),
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(dos.time),
      ...uint16(dos.date),
      ...uint32(checksum),
      ...uint32(data.length),
      ...uint32(data.length),
      ...uint16(nameBytes.length),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(localOffset),
    ]);
    centralParts.push(concatBytes([centralHeader, nameBytes]));
    localOffset += localRecord.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = new Uint8Array([
    ...uint32(ZIP_SIGNATURES.END),
    ...uint16(0),
    ...uint16(0),
    ...uint16(centralParts.length),
    ...uint16(centralParts.length),
    ...uint32(centralDirectory.length),
    ...uint32(localOffset),
    ...uint16(0),
  ]);
  return concatBytes([...localParts, centralDirectory, end]);
}

function findEndOffset(view) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_SIGNATURES.END) return offset;
  }
  return -1;
}

function readZip(input, { maxUncompressedBytes = Infinity } = {}) {
  const bytes = asBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOffset(view);
  if (endOffset === -1) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '不是有效的 ZIP 文件');
  }
  const entryCount = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);
  let totalUncompressed = 0;
  const entries = {};

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(centralOffset, true) !== ZIP_SIGNATURES.CENTRAL) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, 'ZIP 中央目录损坏');
    }
    const compression = view.getUint16(centralOffset + 10, true);
    const checksum = view.getUint32(centralOffset + 16, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const uncompressedSize = view.getUint32(centralOffset + 24, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localHeaderOffset = view.getUint32(centralOffset + 42, true);
    const nameBytes = bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength);
    const name = safeArchiveName(new TextDecoder().decode(nameBytes));
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, 'ZIP 解压后超过允许大小');
    }
    if (compression !== 0) {
      throw new AppError(
        ERROR_CODES.INVALID_INPUT,
        `ZIP 条目 ${name} 使用了暂不支持的压缩方式`,
      );
    }
    if (view.getUint32(localHeaderOffset, true) !== ZIP_SIGNATURES.LOCAL) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, 'ZIP 本地文件头损坏');
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataOffset, dataOffset + compressedSize);
    if (data.length !== uncompressedSize || crc32(data) !== checksum) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, `ZIP 条目 ${name} 校验失败`);
    }
    entries[name] = data;
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}


// ---- archive.js ----
const SENSITIVE_KEY_PATTERN = /token|authorization|cookie|uuid|accountFingerprint/i;
const ARCHIVE_SPEC_VERSION = '2.1.0';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validArchiveScope(value) {
  if (!isPlainObject(value)) return false;
  const selector = isPlainObject(value.scope) ? value.scope : value;
  return typeof selector.type === 'string' && selector.type.length > 0;
}

function sanitizeForArchive(value, seen = new WeakSet()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForArchive(item, seen));
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeForArchive(nested, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  seen.delete(value);
  return result;
}

function flattenLegacyComments(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const visit = (item) => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') result.push(item);
  };
  value.forEach(visit);
  return result;
}

function legacyArchiveToItems(value) {
  if (!value || !Array.isArray(value.holes)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '旧版 JSON 缺少 holes 数组');
  }
  const comments = Array.isArray(value.comments) ? value.comments : [];
  return value.holes.map((hole, index) => {
    if (!hole || !PID_PATTERN.test(String(hole.pid))) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, `旧版 JSON 第 ${index + 1} 条洞记录 PID 无效`);
    }
    return {
      pid: String(hole.pid),
      source: 'legacy-v1',
      hole: sanitizeForArchive(hole),
      comments: sanitizeForArchive(flattenLegacyComments(comments[index])),
      fetchStatus: 'ok',
    };
  });
}

function validateArchiveV2(manifest, data) {
  if (
    !isPlainObject(manifest) ||
    manifest.schemaVersion !== 2 ||
    typeof manifest.toolVersion !== 'string' ||
    manifest.toolVersion.length === 0 ||
    typeof manifest.runId !== 'string' ||
    manifest.runId.length === 0 ||
    typeof manifest.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.exportedAt)) ||
    !validArchiveScope(manifest.scope) ||
    typeof manifest.complete !== 'boolean' ||
    !isPlainObject(manifest.counts) ||
    !Array.isArray(manifest.errors) ||
    (manifest.specVersion !== undefined && manifest.errors.some((error) => !isPlainObject(error)))
  ) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档 manifest 不符合 v2 协议');
  }
  if (manifest.specVersion !== undefined && !/^2\.\d+\.\d+$/.test(manifest.specVersion)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档 specVersion 不受支持');
  }
  if (
    manifest.producer !== undefined &&
    (!isPlainObject(manifest.producer) ||
      typeof manifest.producer.name !== 'string' ||
      manifest.producer.name.length === 0 ||
      (manifest.producer.version !== undefined &&
        (typeof manifest.producer.version !== 'string' || manifest.producer.version.length === 0)))
  ) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档 producer 信息无效');
  }
  if (manifest.extensions !== undefined && !isPlainObject(manifest.extensions)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档 extensions 信息无效');
  }
  for (const [name, descriptor] of Object.entries(manifest.extensions || {})) {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(name) ||
      !isPlainObject(descriptor) ||
      !Number.isInteger(descriptor.version) ||
      descriptor.version < 1
    ) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, `归档扩展声明无效：${name}`);
    }
    if (descriptor.required === true) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, `归档需要当前 Toolkit 不支持的扩展：${name}`);
    }
  }
  for (const name of ['expectedHoles', 'exportedHoles', 'comments', 'failed', 'media', 'missingMedia', 'localTags', 'localNotes']) {
    const value = manifest.counts[name];
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, `归档 counts.${name} 无效`);
    }
  }
  if (manifest.requiredExtensions !== undefined) {
    if (!Array.isArray(manifest.requiredExtensions) || manifest.requiredExtensions.some((name) => typeof name !== 'string')) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '归档 requiredExtensions 信息无效');
    }
    if (manifest.requiredExtensions.length > 0) {
      throw new AppError(
        ERROR_CODES.INVALID_INPUT,
        `归档需要当前 Toolkit 不支持的扩展：${manifest.requiredExtensions.join(', ')}`,
      );
    }
  }
  if (!isPlainObject(data) || Object.keys(data).some((key) => key !== 'items') || !Array.isArray(data.items)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档缺少 data.items');
  }
  if (data.items.length > LIMITS.maxImportPids) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, `归档记录超过 ${LIMITS.maxImportPids} 条`);
  }
  const sources = new Set(['followed', 'referenced', 'explicit', 'legacy-v1']);
  for (const item of data.items) {
    if (
      !isPlainObject(item) ||
      !PID_PATTERN.test(String(item.pid)) ||
      !sources.has(item.source) ||
      !['ok', 'partial'].includes(item.fetchStatus) ||
      !isPlainObject(item.hole) ||
      String(item.hole.pid) !== String(item.pid) ||
      !Array.isArray(item.comments) ||
      item.comments.some(
        (comment) =>
          !isPlainObject(comment) ||
          !Number.isInteger(Number(comment.cid)) ||
          Number(comment.cid) <= 0 ||
          (comment.pid !== undefined && String(comment.pid) !== String(item.pid)),
      )
    ) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '归档中存在无效的洞记录');
    }
  }
  return { manifest, data };
}

function buildReadableText(items) {
  const lines = [];
  for (const item of items) {
    const hole = item.hole || {};
    const timestamp = Number(hole.timestamp);
    const formattedTime = Number.isFinite(timestamp)
      ? new Date(timestamp * 1000).toLocaleString()
      : '未知';
    lines.push(
      `Id:${item.pid}  Likenum:${hole.likenum ?? 0}  Reply:${hole.reply ?? 0}  Time:${formattedTime}`,
      `洞主: ${hole.text ?? ''}`,
    );
    for (const comment of item.comments || []) {
      lines.push(`${comment.name || '匿名'}: ${comment.text || ''}`);
    }
    lines.push('', '======================', '');
  }
  return lines.join('\n');
}

function createManifest({
  runId,
  scope,
  complete,
  items,
  errors = [],
  expectedHoles = null,
  exportedAt = new Date().toISOString(),
}) {
  const normalizedScope = isPlainObject(scope?.scope) ? scope.scope : scope;
  const exportOptions = isPlainObject(scope?.scope)
    ? {
        includeComments: scope.includeComments,
        includeReadable: scope.includeReadable,
        referenceMode: scope.referenceMode,
      }
    : undefined;
  const timestamps = items
    .map((item) => Number(item.hole?.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp));
  return {
    schemaVersion: 2,
    specVersion: ARCHIVE_SPEC_VERSION,
    toolVersion: APP_VERSION,
    producer: { name: 'PkuHoleToolkit', version: APP_VERSION },
    runId,
    exportedAt,
    scope: sanitizeForArchive(normalizedScope),
    ...(exportOptions ? { exportOptions: sanitizeForArchive(exportOptions) } : {}),
    complete: Boolean(complete),
    counts: {
      expectedHoles,
      exportedHoles: items.length,
      comments: items.reduce((total, item) => total + item.comments.length, 0),
      failed: errors.length,
    },
    dateRange: timestamps.length
      ? {
          earliest: new Date(Math.min(...timestamps) * 1000).toISOString(),
          latest: new Date(Math.max(...timestamps) * 1000).toISOString(),
        }
      : null,
    errors: sanitizeForArchive(errors),
  };
}

function createArchive({ manifest, items, includeReadable = true }) {
  const sanitizedItems = sanitizeForArchive(items);
  const data = { items: sanitizedItems };
  validateArchiveV2(manifest, data);
  const entries = {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'data.json': `${JSON.stringify(data)}\n`,
  };
  if (includeReadable) entries['readable.txt'] = buildReadableText(sanitizedItems);
  const bytes = createZip(entries, new Date(manifest.exportedAt));
  return {
    bytes,
    blob: new Blob([bytes], { type: 'application/zip' }),
    filename: `pku-treehole-${manifest.runId}.treehole.zip`,
  };
}

function decodeJson(bytes, name) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, `${name} 不是有效 JSON`, { cause: error });
  }
}

function parseArchiveBytes(bytes, filename = 'archive.zip') {
  if (bytes.byteLength > LIMITS.maxArchiveBytes) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档文件超过 200MB');
  }
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    const legacy = decodeJson(bytes, filename);
    const items = legacyArchiveToItems(legacy);
    return {
      format: 'legacy-v1',
      manifest: {
        schemaVersion: 1,
        complete: true,
        counts: { exportedHoles: items.length },
        errors: [],
      },
      data: { items },
    };
  }
  const entries = readZip(bytes, { maxUncompressedBytes: LIMITS.maxUncompressedBytes });
  if (!entries['manifest.json'] || !entries['data.json']) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, 'ZIP 缺少 manifest.json 或 data.json');
  }
  const manifest = decodeJson(entries['manifest.json'], 'manifest.json');
  const data = decodeJson(entries['data.json'], 'data.json');
  validateArchiveV2(manifest, data);
  return { format: 'v2', manifest, data };
}

async function parseArchiveFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '请选择归档文件');
  }
  if (file.size > LIMITS.maxArchiveBytes) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档文件超过 200MB');
  }
  return parseArchiveBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}


// ---- studio-bridge.js ----
const BRIDGE_PROTOCOL = '2';
const BRIDGE_STATE_KEY = 'pkuhole-studio-bridge-v2';
const DEFAULT_STUDIO_PORT = 8080;
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const studioCapabilityCache = new Map();

function parseStudioPairingCode(value) {
  const match = String(value || '').trim().match(/^(\d{1,5}):([a-f0-9]{32})$/i);
  if (!match) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '接收码格式不正确，请从 Studio 导入与导出页重新复制');
  }
  return { port: normalizeStudioPort(match[1]), token: match[2].toLowerCase() };
}

function normalizeStudioPort(value) {
  const port = Number(value || DEFAULT_STUDIO_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, 'Studio 端口无效');
  }
  return port;
}

async function sendArchiveToStudio(code, archive, request = globalThis.GM_xmlhttpRequest) {
  const { port, token } = parseStudioPairingCode(code);
  const bytes = await archiveBytes(archive);
  const capabilities = await getStudioArchiveCapabilities({ port, request });
  assertStudioCanImportArchive(capabilities, bytes, archive.filename);
  return uploadArchive({
    port,
    path: `/api/v1/bridge/pairings/${token}/archive`,
    archive,
    request,
    errorHint: '请确认 Studio、端口和一次性接收码均正确',
  });
}

async function getStudioArchiveCapabilities({
  port = DEFAULT_STUDIO_PORT,
  request = globalThis.GM_xmlhttpRequest,
  cacheKey,
  now = Date.now,
} = {}) {
  port = normalizeStudioPort(port);
  const key = String(cacheKey || `port:${port}`);
  const cached = studioCapabilityCache.get(key);
  if (cached && cached.expiresAt > now()) return cached.contract;
  const capabilities = await studioRequest(
    {
      port,
      path: '/api/v1/capabilities',
      headers: bridgeHeaders(),
      errorHint: '无法读取 Studio 的归档兼容能力',
    },
    request,
  );
  if (!capabilities || capabilities.archive_import !== true) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '当前 Studio 未启用归档导入能力');
  }
  const contract = capabilities.archive_contract || null;
  studioCapabilityCache.set(key, { contract, expiresAt: now() + CAPABILITY_CACHE_TTL_MS });
  return contract;
}

function clearStudioCapabilityCache() {
  studioCapabilityCache.clear();
}

function assertStudioCanImportArchive(contract, bytes, filename = 'archive.zip') {
  const parsed = parseArchiveBytes(bytes, filename);
  const schemaVersion = Number(parsed.manifest?.schemaVersion || (parsed.format === 'legacy-v1' ? 1 : 0));
  const requiredExtensions = Array.isArray(parsed.manifest?.requiredExtensions)
    ? parsed.manifest.requiredExtensions
    : [];
  if (!contract) {
    if (schemaVersion > 2 || requiredExtensions.length > 0) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, 'Studio 未声明足以读取此归档的协议能力');
    }
    return parsed;
  }
  if (!Array.isArray(contract.schema_versions) || !contract.schema_versions.includes(schemaVersion)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, `Studio 不支持 Archive schema v${schemaVersion}`);
  }
  if (Array.isArray(contract.read_zip_methods) && !contract.read_zip_methods.includes('store')) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, 'Studio 未声明支持 Archive 2.1 的 ZIP STORE 基线');
  }
  if (Number.isFinite(contract.max_archive_bytes) && bytes.byteLength > contract.max_archive_bytes) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档超过 Studio 声明的接收上限');
  }
  const supportedExtensions = contract.extensions && typeof contract.extensions === 'object'
    ? contract.extensions
    : {};
  for (const extensionName of requiredExtensions) {
    const requiredVersion = parsed.manifest?.extensions?.[extensionName]?.version;
    if (!Number.isInteger(requiredVersion) || supportedExtensions[extensionName] !== requiredVersion) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, `Studio 不支持归档必需扩展 ${extensionName}`);
    }
  }
  return parsed;
}

async function requestStudioDevicePairing({
  port = DEFAULT_STUDIO_PORT,
  name = defaultDeviceName(),
  request = globalThis.GM_xmlhttpRequest,
  storage = createStudioBridgeStorage(),
  cryptoObject = globalThis.crypto,
} = {}) {
  port = normalizeStudioPort(port);
  const identity = await createStudioDeviceIdentity(cryptoObject);
  const response = await studioRequest(
    {
      port,
      method: 'POST',
      path: '/api/v1/bridge/device-requests',
      headers: bridgeJSONHeaders(),
      data: JSON.stringify({ name, public_key_spki: identity.publicKeySPKI }),
    },
    request,
  );
  const pending = {
    version: 2,
    status: 'pending',
    port,
    name,
    requestToken: response.token,
    verificationCode: response.verification_code,
    expiresAt: response.expires_at,
    privateKeyPKCS8: identity.privateKeyPKCS8,
    publicKeySPKI: identity.publicKeySPKI,
  };
  await storage.set(pending);
  return pending;
}

async function refreshStudioDevicePairing({
  state,
  request = globalThis.GM_xmlhttpRequest,
  storage = createStudioBridgeStorage(),
} = {}) {
  const current = state || (await storage.get());
  if (!current || current.status !== 'pending') return current || null;
  let response;
  try {
    response = await studioRequest(
      {
        port: current.port,
        path: `/api/v1/bridge/device-requests/${current.requestToken}`,
        headers: bridgeHeaders(),
      },
      request,
    );
  } catch (error) {
    if (error.status === 404) await storage.delete();
    throw error;
  }
  if (response.status === 'approved') {
    const paired = {
      version: 2,
      status: 'paired',
      port: current.port,
      name: current.name,
      deviceId: response.device_id,
      instanceId: response.instance_id,
      privateKeyPKCS8: current.privateKeyPKCS8,
      publicKeySPKI: current.publicKeySPKI,
      pairedAt: new Date().toISOString(),
    };
    await storage.set(paired);
    return paired;
  }
  if (response.status === 'rejected') {
    await storage.delete();
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Studio 已拒绝此 Toolkit 关联请求');
  }
  return { ...current, verificationCode: response.verification_code, expiresAt: response.expires_at };
}

async function waitForStudioDevicePairing({
  state,
  request = globalThis.GM_xmlhttpRequest,
  storage = createStudioBridgeStorage(),
  signal,
  intervalMs = 1500,
  onUpdate = () => {},
} = {}) {
  let current = state || (await storage.get());
  if (!current) throw new AppError(ERROR_CODES.INVALID_INPUT, '没有等待确认的 Studio 关联请求');
  while (current?.status === 'pending') {
    if (signal?.aborted) throw new AppError(ERROR_CODES.CANCELLED, '已取消 Studio 关联');
    current = await refreshStudioDevicePairing({ state: current, request, storage });
    onUpdate(current);
    if (current?.status === 'paired') return current;
    const expiresAt = Date.parse(current.expiresAt || '');
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      await storage.delete();
      throw new AppError(ERROR_CODES.TIMEOUT, 'Studio 关联请求已过期，请重新发起');
    }
    await delay(intervalMs, signal);
  }
  return current;
}

async function sendArchiveToTrustedStudio(
  archive,
  {
    state,
    request = globalThis.GM_xmlhttpRequest,
    storage = createStudioBridgeStorage(),
    cryptoObject = globalThis.crypto,
  } = {},
) {
  const connection = state || (await storage.get());
  if (!connection || connection.status !== 'paired') {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, '请先关联本机 PkuHoleStudio');
  }
  const bytes = await archiveBytes(archive);
  const capabilities = await getStudioArchiveCapabilities({
    port: connection.port,
    request,
    cacheKey: connection.instanceId,
  });
  assertStudioCanImportArchive(capabilities, bytes, archive.filename);
  const sha256 = bytesToHex(new Uint8Array(await cryptoObject.subtle.digest('SHA-256', bytes)));
  const challenge = await studioRequest(
    {
      port: connection.port,
      method: 'POST',
      path: '/api/v1/bridge/challenges',
      headers: bridgeJSONHeaders(),
      data: JSON.stringify({ device_id: connection.deviceId }),
    },
    request,
  );
  if (challenge.instance_id !== connection.instanceId) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, '当前端口上的 Studio 不是已关联的实例');
  }
  const signature = await signTransfer(
    {
      deviceId: connection.deviceId,
      instanceId: connection.instanceId,
      challenge: challenge.challenge,
      filename: archive.filename,
      size: bytes.byteLength,
      sha256,
      privateKeyPKCS8: connection.privateKeyPKCS8,
    },
    cryptoObject,
  );
  const transfer = await studioRequest(
    {
      port: connection.port,
      method: 'POST',
      path: '/api/v1/bridge/transfers',
      headers: bridgeJSONHeaders(),
      data: JSON.stringify({
        device_id: connection.deviceId,
        instance_id: connection.instanceId,
        challenge: challenge.challenge,
        filename: archive.filename,
        size: bytes.byteLength,
        sha256,
        signature,
      }),
    },
    request,
  );
  return uploadArchive({
    port: connection.port,
    path: `/api/v1/bridge/transfers/${transfer.id}/archive`,
    archive: { ...archive, blob: archive.blob || new Blob([bytes], { type: 'application/zip' }) },
    request,
    headers: { Authorization: `Bearer ${transfer.upload_ticket}`, ...bridgeHeaders() },
    errorHint: 'Studio 已撤销关联或传输票据已过期',
  });
}

async function forgetStudioDevice({
  state,
  request = globalThis.GM_xmlhttpRequest,
  storage = createStudioBridgeStorage(),
  cryptoObject = globalThis.crypto,
} = {}) {
  const connection = state || (await storage.get());
  let revoked = false;
  try {
    if (connection?.status === 'paired') {
      const challenge = await studioRequest(
        {
          port: connection.port,
          method: 'POST',
          path: '/api/v1/bridge/challenges',
          headers: bridgeJSONHeaders(),
          data: JSON.stringify({ device_id: connection.deviceId }),
        },
        request,
      );
      if (challenge.instance_id !== connection.instanceId) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, '当前端口上的 Studio 不是已关联的实例');
      }
      const message = ['pkuhole-bridge-v2-revoke', connection.deviceId, connection.instanceId, challenge.challenge].join('\n');
      const signature = await signMessage(connection.privateKeyPKCS8, message, cryptoObject);
      await studioRequest(
        {
          port: connection.port,
          method: 'POST',
          path: `/api/v1/bridge/devices/${connection.deviceId}/revoke`,
          headers: bridgeJSONHeaders(),
          data: JSON.stringify({
            device_id: connection.deviceId,
            instance_id: connection.instanceId,
            challenge: challenge.challenge,
            signature,
          }),
        },
        request,
      );
      revoked = true;
    }
  } finally {
    await storage.delete();
  }
  return { revoked };
}

async function restoreLatestExportArchive(store, accountFingerprint = null) {
  const jobs = (await store.listJobs())
    .filter(
      (job) =>
        job.type === 'export' &&
        ['completed', 'partial'].includes(job.state) &&
        job.manifest &&
        (!accountFingerprint || job.accountFingerprint === accountFingerprint),
    )
    .sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0));
  const job = jobs[0];
  if (!job) return null;
  const items = await store.getItems(job.id);
  if (!items.length) return null;
  return {
    job,
    archive: createArchive({
      manifest: job.manifest,
      items,
      includeReadable: job.options?.includeReadable !== false,
    }),
  };
}

function createStudioBridgeStorage({
  getValue = globalThis.GM_getValue,
  setValue = globalThis.GM_setValue,
  deleteValue = globalThis.GM_deleteValue,
} = {}) {
  return {
    async get() {
      if (typeof getValue !== 'function') return null;
      const value = await getValue(BRIDGE_STATE_KEY, null);
      return value && value.version === 2 ? value : null;
    },
    async set(value) {
      if (typeof setValue !== 'function') {
        throw new AppError(ERROR_CODES.STORAGE_ERROR, '用户脚本管理器不支持私有设备凭据存储');
      }
      await setValue(BRIDGE_STATE_KEY, value);
    },
    async delete() {
      if (typeof deleteValue === 'function') await deleteValue(BRIDGE_STATE_KEY);
    },
  };
}

async function createStudioDeviceIdentity(cryptoObject = globalThis.crypto) {
  if (!cryptoObject?.subtle) {
    throw new AppError(ERROR_CODES.STORAGE_ERROR, '当前浏览器不支持本机设备签名');
  }
  const keys = await cryptoObject.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const [privateKey, publicKey] = await Promise.all([
    cryptoObject.subtle.exportKey('pkcs8', keys.privateKey),
    cryptoObject.subtle.exportKey('spki', keys.publicKey),
  ]);
  return {
    privateKeyPKCS8: bytesToBase64(new Uint8Array(privateKey)),
    publicKeySPKI: bytesToBase64(new Uint8Array(publicKey)),
  };
}

function transferSignatureMessage({ deviceId, instanceId, challenge, filename, size, sha256 }) {
  return ['pkuhole-bridge-v2', deviceId, instanceId, challenge, filename, String(size), sha256].join('\n');
}

async function signTransfer(input, cryptoObject) {
  return signMessage(input.privateKeyPKCS8, transferSignatureMessage(input), cryptoObject);
}

async function signMessage(privateKeyPKCS8, messageText, cryptoObject) {
  const privateKey = await cryptoObject.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKeyPKCS8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const message = new TextEncoder().encode(messageText);
  const signature = new Uint8Array(
    await cryptoObject.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message),
  );
  return bytesToBase64(normalizeECDSASignature(signature));
}

function normalizeECDSASignature(signature) {
  if (signature.byteLength === 64) return signature;
  // WebCrypto normally returns IEEE-P1363 r||s. Accept DER as a defensive
  // compatibility path for older user-script/browser combinations.
  if (signature[0] !== 0x30) throw new AppError(ERROR_CODES.INVALID_RESPONSE, '浏览器返回了未知签名格式');
  let offset = 2;
  if (signature[1] & 0x80) offset = 2 + (signature[1] & 0x7f);
  if (signature[offset++] !== 0x02) throw new AppError(ERROR_CODES.INVALID_RESPONSE, '浏览器返回了无效签名');
  const rLength = signature[offset++];
  const r = signature.slice(offset, offset + rLength);
  offset += rLength;
  if (signature[offset++] !== 0x02) throw new AppError(ERROR_CODES.INVALID_RESPONSE, '浏览器返回了无效签名');
  const sLength = signature[offset++];
  const s = signature.slice(offset, offset + sLength);
  const raw = new Uint8Array(64);
  raw.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length));
  raw.set(s.slice(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length));
  return raw;
}

async function uploadArchive({ port, path, archive, request, headers = {}, errorHint }) {
  if (!archive?.blob || !archive?.filename) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出');
  }
  const body = new FormData();
  body.append('file', archive.blob, archive.filename);
  return studioRequest(
    { port, method: 'POST', path, headers, data: body, timeout: 120_000, errorHint },
    request,
  );
}

function studioRequest(options, request = globalThis.GM_xmlhttpRequest) {
  if (typeof request !== 'function') {
    return Promise.reject(new AppError(ERROR_CODES.NETWORK_ERROR, '当前用户脚本管理器不支持本地桥接请求'));
  }
  const port = normalizeStudioPort(options.port);
  return new Promise((resolve, reject) => {
    request({
      method: options.method || 'GET',
      url: `http://127.0.0.1:${port}${options.path}`,
      headers: options.headers,
      data: options.data,
      timeout: options.timeout || 20_000,
      onload(response) {
        let decoded;
        try {
          decoded = JSON.parse(response.responseText || '{}');
        } catch (error) {
          reject(new AppError(ERROR_CODES.INVALID_RESPONSE, 'Studio 返回了无法识别的响应', { cause: error, status: response.status }));
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          reject(
            new AppError(ERROR_CODES.INVALID_INPUT, decoded?.error?.message || options.errorHint || `Studio 拒绝了请求 (${response.status})`, {
              status: response.status,
              details: decoded?.error?.details,
            }),
          );
          return;
        }
        resolve(decoded.data);
      },
      ontimeout() {
        reject(new AppError(ERROR_CODES.TIMEOUT, '连接 Studio 超时，请确认 Studio 仍在运行'));
      },
      onerror() {
        reject(new AppError(ERROR_CODES.NETWORK_ERROR, options.errorHint || '无法连接本机 Studio'));
      },
    });
  });
}

function bridgeHeaders() {
  return { 'X-PkuHole-Toolkit': BRIDGE_PROTOCOL };
}

function bridgeJSONHeaders() {
  return { ...bridgeHeaders(), 'Content-Type': 'application/json' };
}

async function archiveBytes(archive) {
  if (archive?.bytes instanceof Uint8Array) return archive.bytes;
  if (archive?.blob?.arrayBuffer) return new Uint8Array(await archive.blob.arrayBuffer());
  throw new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出');
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function defaultDeviceName() {
  const browser = String(globalThis.navigator?.userAgent || '').includes('Firefox') ? 'Firefox' : 'Browser';
  return `${browser} Toolkit`;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError(ERROR_CODES.CANCELLED, '操作已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}


// ---- storage.js ----
function cloneValue(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
  });
}

class JobStore {
  constructor({ indexedDBObject = globalThis.indexedDB, now = Date.now } = {}) {
    if (!indexedDBObject) throw new AppError(ERROR_CODES.STORAGE_ERROR, '浏览器不支持 IndexedDB');
    this.indexedDBObject = indexedDBObject;
    this.now = now;
    this.databasePromise = null;
  }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDBObject.open(JOB_DB_NAME, JOB_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('jobs')) {
          database.createObjectStore('jobs', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('items')) {
          const store = database.createObjectStore('items', { keyPath: 'key' });
          store.createIndex('jobId', 'jobId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.databasePromise;
  }

  async putJob(job) {
    try {
      const database = await this.open();
      const transaction = database.transaction('jobs', 'readwrite');
      transaction.objectStore('jobs').put(cloneValue({ ...job, updatedAt: this.now() }));
      await transactionPromise(transaction);
      return job;
    } catch (error) {
      throw new AppError(ERROR_CODES.STORAGE_ERROR, '无法保存任务进度', { cause: error });
    }
  }

  async getJob(id) {
    const database = await this.open();
    const transaction = database.transaction('jobs', 'readonly');
    return requestPromise(transaction.objectStore('jobs').get(id));
  }

  async listJobs() {
    const database = await this.open();
    const transaction = database.transaction('jobs', 'readonly');
    return requestPromise(transaction.objectStore('jobs').getAll());
  }

  async putItem(jobId, pid, item) {
    const database = await this.open();
    const transaction = database.transaction('items', 'readwrite');
    transaction.objectStore('items').put({
      key: `${jobId}:${pid}`,
      jobId,
      pid: String(pid),
      item: cloneValue(item),
    });
    await transactionPromise(transaction);
  }

  async getItems(jobId) {
    const database = await this.open();
    const transaction = database.transaction('items', 'readonly');
    const index = transaction.objectStore('items').index('jobId');
    const records = await requestPromise(index.getAll(IDBKeyRange.only(jobId)));
    return records.map((record) => record.item);
  }

  async deleteJob(jobId) {
    const database = await this.open();
    const transaction = database.transaction(['jobs', 'items'], 'readwrite');
    transaction.objectStore('jobs').delete(jobId);
    const index = transaction.objectStore('items').index('jobId');
    const request = index.openKeyCursor(IDBKeyRange.only(jobId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore('items').delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionPromise(transaction);
  }

  async cleanup() {
    const jobs = await this.listJobs();
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const job of jobs) {
      if ((job.updatedAt || job.createdAt || 0) < cutoff) await this.deleteJob(job.id);
    }
  }
}

class MemoryJobStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.jobs = new Map();
    this.items = new Map();
  }

  async putJob(job) {
    this.jobs.set(job.id, cloneValue({ ...job, updatedAt: this.now() }));
    return job;
  }

  async getJob(id) {
    return cloneValue(this.jobs.get(id));
  }

  async listJobs() {
    return [...this.jobs.values()].map(cloneValue);
  }

  async putItem(jobId, pid, item) {
    this.items.set(`${jobId}:${pid}`, cloneValue(item));
  }

  async getItems(jobId) {
    return [...this.items.entries()]
      .filter(([key]) => key.startsWith(`${jobId}:`))
      .map(([, item]) => cloneValue(item));
  }

  async deleteJob(jobId) {
    this.jobs.delete(jobId);
    for (const key of this.items.keys()) {
      if (key.startsWith(`${jobId}:`)) this.items.delete(key);
    }
  }

  async cleanup() {
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const job of await this.listJobs()) {
      if ((job.updatedAt || job.createdAt || 0) < cutoff) await this.deleteJob(job.id);
    }
  }
}


// ---- export-job.js ----
function createRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `${timestamp}-${suffix}`;
}

function referencesFromText(text) {
  const pids = [];
  if (!text) return pids;
  const value = String(text);
  const leadingReference = value.match(LEADING_REFERENCE_PATTERN);
  if (leadingReference) pids.push(leadingReference[1]);
  for (const match of value.matchAll(REFERENCE_PATTERN)) pids.push(match[1]);
  return pids;
}

function normalizedOptions(options = {}) {
  const scope = options.scope || { type: 'all' };
  if (!['all', 'group', 'pids', 'date'].includes(scope.type)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '未知导出范围');
  }
  return {
    scope: {
      type: scope.type,
      bookmarkId: scope.bookmarkId ? String(scope.bookmarkId) : null,
      pids: Array.isArray(scope.pids) ? [...new Set(scope.pids.map(normalizePid))] : [],
      startDate: scope.startDate || null,
      endDate: scope.endDate || null,
    },
    includeComments: options.includeComments !== false,
    includeReadable: options.includeReadable !== false,
    referenceMode: ['none', 'body', 'all'].includes(options.referenceMode)
      ? options.referenceMode
      : 'none',
    confirmedLargeReferences: Boolean(options.confirmedLargeReferences),
  };
}

function filterByDate(holes, scope) {
  if (scope.type !== 'date') return holes;
  const start = scope.startDate ? Date.parse(scope.startDate) / 1000 : -Infinity;
  const end = scope.endDate ? (Date.parse(scope.endDate) + 86_399_999) / 1000 : Infinity;
  return holes.filter((hole) => {
    const timestamp = Number(hole.timestamp);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}

class ExportJob {
  constructor({
    api,
    store,
    accountFingerprint,
    now = () => new Date(),
    onProgress = () => {},
    confirmReferences = async (count) => count <= LIMITS.confirmReferencedPids,
  }) {
    this.api = api;
    this.store = store;
    this.accountFingerprint = accountFingerprint;
    this.now = now;
    this.onProgress = onProgress;
    this.confirmReferences = confirmReferences;
    this.pauseRequested = false;
    this.controller = null;
    this.jobId = null;
  }

  requestPause() {
    this.pauseRequested = true;
  }

  cancel() {
    this.controller?.abort('cancelled');
  }

  emit(event) {
    this.onProgress(event);
  }

  async saveState(job, state, patch = {}) {
    Object.assign(job, patch, { state });
    await this.store.putJob(job);
    this.emit({ type: 'state', state, jobId: job.id, ...patch });
  }

  async planHoles(options, signal) {
    if (options.scope.type === 'pids') {
      const holes = [];
      const errors = [];
      for (const pid of options.scope.pids) {
        throwIfAborted(signal, 'plan_explicit_pids');
        try {
          holes.push(await this.api.getHole(pid, signal));
        } catch (error) {
          if (
            isAppError(error, ERROR_CODES.UNAUTHORIZED) ||
            isAppError(error, ERROR_CODES.RATE_LIMITED) ||
            isAppError(error, ERROR_CODES.CANCELLED)
          ) {
            throw error;
          }
          errors.push(toErrorRecord(error, { pid, phase: 'hole' }));
        }
      }
      return { holes, complete: errors.length === 0, errors };
    }
    const result = await this.api.getAllFollowed({
      bookmarkId: options.scope.type === 'group' ? options.scope.bookmarkId : null,
      signal,
      onPage: (progress) => this.emit({ type: 'planning', ...progress }),
    });
    return {
      holes: filterByDate(result.items, options.scope),
      complete: result.complete,
      errors: result.complete
        ? []
        : [
            {
              code: ERROR_CODES.INVALID_RESPONSE,
              message:
                result.reason === 'followed_count_mismatch'
                  ? '关注列表实际数量与服务端总数不一致'
                  : '关注列表达到安全页数上限',
              phase: 'followed',
              retryable: true,
            },
          ],
    };
  }

  async processHole({ job, hole, source, options, signal, references }) {
    const pid = normalizePid(hole.pid);
    let comments = [];
    let fetchStatus = 'ok';
    let error = null;
    if (options.includeComments && Number(hole.reply || 0) > 0) {
      try {
        const result = await this.api.getAllComments(pid, {
          signal,
          onPage: (progress) => this.emit({ type: 'comments', pid, ...progress }),
        });
        comments = result.items;
        if (!result.complete) {
          fetchStatus = 'partial';
          error = {
            code: ERROR_CODES.INVALID_RESPONSE,
            message:
              result.reason === 'comment_count_mismatch'
                ? `#${pid} 评论实际数量与服务端总数不一致`
                : `#${pid} 评论达到安全页数上限`,
            pid,
            phase: 'comments',
            retryable: true,
          };
        }
      } catch (caught) {
        if (
          isAppError(caught, ERROR_CODES.UNAUTHORIZED) ||
          isAppError(caught, ERROR_CODES.RATE_LIMITED) ||
          isAppError(caught, ERROR_CODES.CANCELLED)
        ) {
          throw caught;
        }
        fetchStatus = 'partial';
        error = toErrorRecord(caught, { pid, phase: 'comments' });
      }
    }

    const item = sanitizeForArchive({
      pid,
      source,
      hole,
      comments,
      fetchStatus,
    });
    await this.store.putItem(job.id, pid, item);

    if (options.referenceMode !== 'none') {
      referencesFromText(hole.text).forEach((reference) => references.add(reference));
      if (options.referenceMode === 'all') {
        comments.forEach((comment) =>
          referencesFromText(comment.text).forEach((reference) => references.add(reference)),
        );
      }
    }
    return error;
  }

  async run(rawOptions = null, { jobId = null, signal: externalSignal } = {}) {
    this.pauseRequested = false;
    this.controller = new AbortController();
    const onExternalAbort = () => this.controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const signal = this.controller.signal;
    this.api.scheduler?.resetRateLimitCount?.();

    let job = jobId ? await this.store.getJob(jobId) : null;
    const options = normalizedOptions(rawOptions || job?.options);
    if (job && job.accountFingerprint !== this.accountFingerprint) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, '该断点属于另一个账号，不能恢复');
    }
    if (!job) {
      const createdAt = this.now().toISOString();
      job = {
        id: createRunId(this.now()),
        type: 'export',
        state: JOB_STATES.PLANNING,
        createdAt: Date.parse(createdAt),
        accountFingerprint: this.accountFingerprint,
        options,
        errors: [],
        total: 0,
        completed: 0,
      };
      await this.store.putJob(job);
    } else {
      job.options = options;
      job.errors = [];
    }
    this.jobId = job.id;

    try {
      await this.saveState(job, JOB_STATES.PLANNING);
      const plan = await this.planHoles(options, signal);
      const basePids = new Set(plan.holes.map((hole) => String(hole.pid)));
      const existingItems = await this.store.getItems(job.id);
      const completedPids = new Set(
        existingItems.filter((item) => item.fetchStatus === 'ok').map((item) => item.pid),
      );
      const errors = [...plan.errors];
      job.total = plan.holes.length;
      job.completed = completedPids.size;
      await this.saveState(job, JOB_STATES.RUNNING, {
        total: job.total,
        completed: job.completed,
      });

      const references = new Set();
      if (options.referenceMode !== 'none') {
        for (const item of existingItems) {
          referencesFromText(item.hole?.text).forEach((reference) => references.add(reference));
          if (options.referenceMode === 'all') {
            item.comments?.forEach((comment) =>
              referencesFromText(comment.text).forEach((reference) => references.add(reference)),
            );
          }
        }
      }
      for (const hole of plan.holes) {
        throwIfAborted(signal, 'export');
        if (this.pauseRequested) {
          await this.saveState(job, JOB_STATES.PAUSED, { errors });
          return { job, paused: true };
        }
        const pid = normalizePid(hole.pid);
        if (!completedPids.has(pid)) {
          const error = await this.processHole({
            job,
            hole,
            source: options.scope.type === 'pids' ? 'explicit' : 'followed',
            options,
            signal,
            references,
          });
          if (error) errors.push(error);
          completedPids.add(pid);
          job.completed = completedPids.size;
          await this.store.putJob({ ...job, completed: job.completed, errors });
          this.emit({ ...job, type: 'progress', phase: 'followed', pid });
        }
      }

      for (const pid of basePids) references.delete(pid);
      if (references.size > LIMITS.maxReferencedPids) {
        errors.push({
          code: ERROR_CODES.INVALID_INPUT,
          message: `引用洞数量 ${references.size} 超过安全上限 ${LIMITS.maxReferencedPids}`,
          phase: 'references',
          retryable: false,
        });
      }
      const referencePids = [...references].slice(0, LIMITS.maxReferencedPids);
      if (
        referencePids.length > LIMITS.confirmReferencedPids &&
        !options.confirmedLargeReferences
      ) {
        const confirmed = await this.confirmReferences(referencePids.length);
        if (!confirmed) referencePids.length = 0;
      }
      job.total += referencePids.length;
      await this.store.putJob(job);

      for (const pid of referencePids) {
        throwIfAborted(signal, 'export_references');
        if (this.pauseRequested) {
          await this.saveState(job, JOB_STATES.PAUSED, { errors });
          return { job, paused: true };
        }
        if (completedPids.has(pid)) continue;
        try {
          const hole = await this.api.getHole(pid, signal);
          const error = await this.processHole({
            job,
            hole,
            source: 'referenced',
            options,
            signal,
            references: new Set(),
          });
          if (error) errors.push(error);
          completedPids.add(pid);
        } catch (error) {
          if (
            isAppError(error, ERROR_CODES.UNAUTHORIZED) ||
            isAppError(error, ERROR_CODES.RATE_LIMITED) ||
            isAppError(error, ERROR_CODES.CANCELLED)
          ) {
            throw error;
          }
          errors.push(toErrorRecord(error, { pid, phase: 'referenced' }));
        }
        job.completed = completedPids.size;
        await this.store.putJob({ ...job, completed: job.completed, errors });
        this.emit({ ...job, type: 'progress', phase: 'referenced', pid });
      }

      const items = await this.store.getItems(job.id);
      const complete = plan.complete && errors.length === 0 && items.every((item) => item.fetchStatus === 'ok');
      const manifest = createManifest({
        runId: job.id,
        scope: options,
        complete,
        items,
        errors,
        expectedHoles: job.total,
        exportedAt: this.now().toISOString(),
      });
      const archive = createArchive({
        manifest,
        items,
        includeReadable: options.includeReadable,
      });
      await this.saveState(job, complete ? JOB_STATES.COMPLETED : JOB_STATES.PARTIAL, {
        completed: items.length,
        errors,
        manifest,
      });
      return { job, manifest, archive, paused: false };
    } catch (error) {
      let state = JOB_STATES.FAILED;
      if (isAppError(error, ERROR_CODES.CANCELLED)) state = JOB_STATES.CANCELLED;
      else if (isAppError(error, ERROR_CODES.RATE_LIMITED)) state = JOB_STATES.PAUSED;
      await this.saveState(job, state, {
        errors: [...(job.errors || []), toErrorRecord(error, { phase: 'job' })],
      });
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.controller = null;
    }
  }
}


// ---- import-job.js ----
function importRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `import-${stamp}-${suffix}`;
}

const IMPORTABLE_SOURCES = new Set(['followed', 'explicit', 'legacy-v1']);

class ImportJob {
  constructor({ api, store, accountFingerprint, onProgress = () => {} }) {
    this.api = api;
    this.store = store;
    this.accountFingerprint = accountFingerprint;
    this.onProgress = onProgress;
    this.controller = null;
    this.pauseRequested = false;
    this.jobId = null;
  }

  requestPause() {
    this.pauseRequested = true;
  }

  cancel() {
    this.controller?.abort('cancelled');
  }

  async preview(files, { signal: externalSignal } = {}) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    this.controller = controller;
    const signal = controller.signal;
    this.api.scheduler?.resetRateLimitCount?.();
    const inputFiles = [...(files || [])];
    const unique = new Set();
    let duplicateCount = 0;
    let excludedReferenced = 0;
    const invalidFiles = [];
    const archives = [];
    try {
      for (const [index, file] of inputFiles.entries()) {
        throwIfAborted(signal, 'import_preview');
        try {
          const archive = await parseArchiveFile(file);
          archives.push({ name: file.name, format: archive.format });
          for (const item of archive.data.items) {
            if (item.source === 'referenced') {
              excludedReferenced += 1;
              continue;
            }
            if (!IMPORTABLE_SOURCES.has(item.source)) continue;
            try {
              const pid = normalizePid(item.pid);
              if (unique.has(pid)) duplicateCount += 1;
              unique.add(pid);
            } catch (error) {
              invalidFiles.push({ file: file.name, error: toErrorRecord(error) });
            }
          }
        } catch (error) {
          invalidFiles.push({ file: file.name, error: toErrorRecord(error) });
        }
        this.onProgress({
          type: 'progress',
          state: 'previewing',
          phase: 'archive_files',
          completed: index + 1,
          total: inputFiles.length,
        });
      }
      if (unique.size > LIMITS.maxImportPids) {
        throw new AppError(ERROR_CODES.INVALID_INPUT, '导入 PID 数量超过 20000');
      }
      const followed = await this.api.getAllFollowed({
        signal,
        onPage: ({ count, total }) =>
          this.onProgress({
            type: 'progress',
            state: 'previewing',
            phase: 'remote_followed',
            completed: count,
            total,
          }),
      });
      const followedPids = new Set(followed.items.map((hole) => String(hole.pid)));
      const alreadyFollowed = [...unique].filter((pid) => followedPids.has(pid));
      const newPids = [...unique].filter((pid) => !followedPids.has(pid));
      return {
        archives,
        allPids: [...unique],
        newPids,
        alreadyFollowed,
        duplicateCount,
        excludedReferenced,
        invalidFiles,
        remoteComplete: followed.complete,
      };
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (this.controller === controller) this.controller = null;
    }
  }

  async execute(preview, { signal: externalSignal, jobId = null } = {}) {
    if (!preview || preview.remoteComplete !== true) {
      throw new AppError(
        ERROR_CODES.INVALID_RESPONSE,
        '当前关注列表读取不完整，已禁止导入；请重新预检后再试',
      );
    }
    this.pauseRequested = false;
    this.controller = new AbortController();
    const onExternalAbort = () => this.controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const signal = this.controller.signal;
    this.api.scheduler?.resetRateLimitCount?.();

    let job = jobId ? await this.store.getJob(jobId) : null;
    if (job && job.accountFingerprint !== this.accountFingerprint) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, '该导入断点属于另一个账号');
    }
    if (!job) {
      job = {
        id: importRunId(),
        type: 'import',
        state: JOB_STATES.PLANNING,
        createdAt: Date.now(),
        accountFingerprint: this.accountFingerprint,
        pids: preview.newPids,
        preview: {
          archives: preview.archives,
          allPids: preview.allPids,
          newPids: preview.newPids,
          alreadyFollowed: preview.alreadyFollowed,
          duplicateCount: preview.duplicateCount,
          excludedReferenced: preview.excludedReferenced,
          invalidFiles: preview.invalidFiles,
          remoteComplete: preview.remoteComplete,
        },
        total: preview.newPids.length,
        completed: 0,
        results: [],
      };
    }
    this.jobId = job.id;
    await this.store.putJob({ ...job, state: JOB_STATES.RUNNING });
    const previous = await this.store.getItems(job.id);
    const completedPids = new Set(previous.map((result) => result.pid));
    const results = [...previous];

    try {
      for (const pid of job.pids) {
        throwIfAborted(signal, 'import');
        if (this.pauseRequested) {
          job.state = JOB_STATES.PAUSED;
          job.results = results;
          await this.store.putJob(job);
          return { job, paused: true, audit: this.buildAudit(preview, results) };
        }
        if (completedPids.has(pid)) continue;
        let result;
        try {
          const response = await this.api.followHole(pid, signal);
          result = { pid, status: response.status };
        } catch (error) {
          if (
            isAppError(error, ERROR_CODES.UNAUTHORIZED) ||
            isAppError(error, ERROR_CODES.RATE_LIMITED) ||
            isAppError(error, ERROR_CODES.CANCELLED)
          ) {
            throw error;
          }
          result = { pid, status: 'failed', error: toErrorRecord(error) };
        }
        results.push(result);
        completedPids.add(pid);
        await this.store.putItem(job.id, pid, result);
        job.completed = completedPids.size;
        job.results = results;
        await this.store.putJob(job);
        this.onProgress({ ...job, type: 'progress', pid });
      }
      const audit = this.buildAudit(preview, results);
      job.state = audit.failed === 0 && audit.unknown === 0 ? JOB_STATES.COMPLETED : JOB_STATES.PARTIAL;
      job.audit = audit;
      await this.store.putJob(job);
      return { job, paused: false, audit };
    } catch (error) {
      if (isAppError(error, ERROR_CODES.CANCELLED)) job.state = JOB_STATES.CANCELLED;
      else if (isAppError(error, ERROR_CODES.RATE_LIMITED)) job.state = JOB_STATES.PAUSED;
      else job.state = JOB_STATES.FAILED;
      job.fatalError = toErrorRecord(error);
      await this.store.putJob(job);
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.controller = null;
    }
  }

  buildAudit(preview, results) {
    const count = (statuses) => results.filter((result) => statuses.includes(result.status)).length;
    return {
      totalFiles: preview.archives.length,
      totalUnique: preview.allPids.length,
      requested: preview.newPids.length,
      alreadyFollowed: preview.alreadyFollowed.length,
      duplicates: preview.duplicateCount,
      excludedReferenced: preview.excludedReferenced || 0,
      invalidFiles: preview.invalidFiles,
      followed: count(['followed', 'followed_reconciled']),
      skipped: count(['already_followed']),
      notFound: results.filter((result) => result.error?.code === ERROR_CODES.NOT_FOUND).length,
      unknown: results.filter((result) => result.error?.code === ERROR_CODES.UNKNOWN_RESULT).length,
      failed: count(['failed']),
      results,
    };
  }
}

function buildImportAuditText(audit) {
  return [
    '北大树洞关注导入审计报告',
    `文件数: ${audit.totalFiles}`,
    `唯一 PID: ${audit.totalUnique}`,
    `计划新增: ${audit.requested}`,
    `已关注: ${audit.alreadyFollowed}`,
    `仅归档引用（未导入）: ${audit.excludedReferenced}`,
    `成功关注: ${audit.followed}`,
    `结果未知: ${audit.unknown}`,
    `失败: ${audit.failed}`,
    '',
    ...audit.results.map(
      (result) => `#${result.pid}\t${result.status}\t${result.error?.message || ''}`,
    ),
  ].join('\n');
}


// ---- ui.js ----
const ENTRY_ID = 'pku-hole-toolkit-entry';
const HOST_ID = 'pku-hole-toolkit-host';
const DELIVERY_PREFERENCE_KEY = 'pkuhole-export-delivery-v1';

function normalizeArchiveDestinations(value) {
  if (!value || typeof value !== 'object') return { download: true, studio: false };
  return {
    download: value.download === true,
    studio: value.studio === true,
  };
}

function readArchiveDestinations(storage) {
  try {
    const encoded = storage?.getItem?.(DELIVERY_PREFERENCE_KEY);
    return encoded ? normalizeArchiveDestinations(JSON.parse(encoded)) : normalizeArchiveDestinations();
  } catch {
    return normalizeArchiveDestinations();
  }
}

function writeArchiveDestinations(storage, value) {
  const destinations = normalizeArchiveDestinations(value);
  try {
    storage?.setItem?.(DELIVERY_PREFERENCE_KEY, JSON.stringify(destinations));
  } catch {
    // Exporting must remain available when browser storage is blocked or full.
  }
  return destinations;
}

async function deliverArchiveToDestinations({
  archive,
  destinations,
  studioConnected = false,
  downloadArchive = () => {},
  sendArchiveToStudio = async () => null,
}) {
  const selected = normalizeArchiveDestinations(destinations);
  const delivery = {
    download: selected.download ? 'ready' : 'not_selected',
    studio: selected.studio ? 'ready' : 'not_selected',
    studioResult: null,
    downloadError: null,
    studioError: null,
  };
  if (selected.download) {
    try {
      await downloadArchive(archive);
      delivery.download = 'started';
    } catch (error) {
      delivery.download = 'failed';
      delivery.downloadError = error;
    }
  }
  if (!selected.studio) return delivery;
  if (!studioConnected) {
    delivery.studio = 'not_connected';
    delivery.studioError = new AppError(
      ERROR_CODES.UNAUTHORIZED,
      '归档已经生成，但 Studio 尚未关联；可以先下载，或关联后发送最近归档',
    );
    return delivery;
  }
  try {
    delivery.studioResult = await sendArchiveToStudio(archive);
    delivery.studio = 'awaiting_confirmation';
  } catch (error) {
    delivery.studio = 'failed';
    delivery.studioError = error;
  }
  return delivery;
}

function ensureEntryBeforeAnchor(entry, anchor) {
  if (!entry || !anchor?.parentNode) return false;
  if (entry.parentNode === anchor.parentNode && entry.nextSibling === anchor) return false;
  anchor.parentNode.insertBefore(entry, anchor);
  return true;
}

const PANEL_STYLES = `
  :host { all: initial; color-scheme: light dark; }
  * { box-sizing: border-box; }
  .overlay { position: fixed; inset: 0; z-index: 2147483646; display: none; place-items: center; padding: 20px; background: rgba(0,0,0,.5); font-family: system-ui, -apple-system, sans-serif; color: #202124; }
  .overlay.open { display: grid; }
  .panel { width: min(720px, 100%); max-height: min(820px, calc(100vh - 40px)); overflow: auto; border-radius: 14px; background: #fff; box-shadow: 0 24px 80px rgba(0,0,0,.32); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid #e6e8eb; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 12px; font-size: 16px; }
  .close { border: 0; background: transparent; font-size: 26px; line-height: 1; cursor: pointer; color: inherit; }
  .tabs { display: flex; gap: 6px; padding: 12px 20px 0; }
  .tabs button { flex: 1; }
  main { padding: 18px 20px 22px; }
  section[hidden], .conditional[hidden] { display: none; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  .field { display: grid; gap: 6px; }
  .field.full { grid-column: 1 / -1; }
  label, legend { font-size: 14px; font-weight: 600; }
  input, select, textarea, button { font: inherit; }
  input, select, textarea { width: 100%; border: 1px solid #b8bec7; border-radius: 8px; padding: 9px 10px; background: #fff; color: #202124; }
  textarea { min-height: 80px; resize: vertical; }
  .checks { display: flex; flex-wrap: wrap; gap: 12px 20px; margin: 14px 0; }
  .checks label { display: flex; align-items: center; gap: 7px; font-weight: 500; }
  .checks input { width: auto; }
  fieldset { min-width: 0; margin: 16px 0 0; padding: 14px; border: 1px solid #d7dbe1; border-radius: 10px; }
  fieldset legend { padding: 0 6px; }
  .hint { margin: 8px 0 0; font-size: 12px; line-height: 1.6; color: #68707c; }
  button { border: 1px solid #aeb4bd; border-radius: 8px; padding: 9px 14px; background: #f7f8fa; color: #202124; cursor: pointer; }
  button.primary { border-color: #1a73e8; background: #1a73e8; color: #fff; }
  button.danger { border-color: #c5221f; color: #c5221f; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid rgba(26,115,232,.35); outline-offset: 2px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .status-card { margin-top: 18px; padding: 14px; border-radius: 10px; background: #f2f6fc; border: 1px solid #dce6f5; }
  .status-line { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
  progress { width: 100%; height: 12px; margin: 10px 0; }
  .message { min-height: 1.5em; margin: 8px 0 0; white-space: pre-wrap; font-size: 14px; }
  .message.error { color: #b3261e; }
  .preview { margin-top: 14px; padding: 12px; border: 1px solid #d7dbe1; border-radius: 8px; white-space: pre-wrap; font-size: 14px; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } .field.full { grid-column: auto; } }
  @media (prefers-color-scheme: dark) {
    .overlay { color: #e8eaed; }
    .panel { background: #202124; }
    header { border-color: #3c4043; }
    input, select, textarea { background: #292a2d; border-color: #5f6368; color: #e8eaed; }
    button { background: #303134; border-color: #5f6368; color: #e8eaed; }
    button.primary { background: #8ab4f8; border-color: #8ab4f8; color: #202124; }
    .status-card { background: #263248; border-color: #3b4e6d; }
    .preview, fieldset { border-color: #5f6368; }
    .hint { color: #bdc1c6; }
  }
`;

function panelTemplate() {
  return `
    <style>${PANEL_STYLES}</style>
    <div class="overlay" aria-hidden="true">
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="toolkit-title">
        <header><h2 id="toolkit-title">北大树洞归档与迁移</h2><button class="close" type="button" aria-label="关闭">×</button></header>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" data-tab="export" aria-selected="true">导出归档</button>
          <button type="button" role="tab" data-tab="import" aria-selected="false">导入关注</button>
        </div>
        <main>
          <section data-panel="export">
            <h3>导出设置</h3>
            <div class="grid">
              <div class="field"><label for="scope">范围</label><select id="scope"><option value="all">全部关注</option><option value="group">收藏分组</option><option value="pids">指定 PID</option><option value="date">日期范围</option></select></div>
              <div class="field conditional" data-for-scope="group" hidden><label for="bookmark">收藏分组</label><select id="bookmark"><option value="">正在加载分组…</option></select></div>
              <div class="field full conditional" data-for-scope="pids" hidden><label for="export-pids">PID（空格、逗号或换行分隔）</label><textarea id="export-pids" placeholder="123456 234567"></textarea></div>
              <div class="field conditional" data-for-scope="date" hidden><label for="start-date">开始日期</label><input id="start-date" type="date"></div>
              <div class="field conditional" data-for-scope="date" hidden><label for="end-date">结束日期</label><input id="end-date" type="date"></div>
              <div class="field"><label for="reference-mode">引用洞</label><select id="reference-mode"><option value="none">不抓取</option><option value="body">仅正文引用</option><option value="all">正文和评论引用</option></select></div>
            </div>
            <div class="checks"><label><input id="include-comments" type="checkbox" checked>包含评论</label><label><input id="include-readable" type="checkbox" checked>包含 readable.txt</label></div>
            <fieldset>
              <legend>归档生成后</legend>
              <div class="checks">
                <label><input id="delivery-download" type="checkbox">下载归档到本机</label>
                <label><input id="delivery-studio" type="checkbox">发送到已关联 Studio</label>
              </div>
              <p class="hint">可以同时选择。两种输出复用同一份归档；未选择 Studio 时不会连接本机端口。</p>
            </fieldset>
            <div class="actions"><button class="primary" type="button" data-action="export">开始生成归档</button></div>
            <div class="status-card">
              <h3>发送到 PkuHoleStudio</h3>
              <p class="message" data-studio-connection>尚未关联 Studio。首次关联需要在 Studio 核对一次，之后发送不再复制接收码。</p>
              <div class="grid">
                <div class="field"><label for="studio-port">本机 Studio 端口</label><input id="studio-port" inputmode="numeric" value="8080"></div>
              </div>
              <div class="actions"><button type="button" data-action="pair-studio">关联本机 Studio</button><button type="button" data-action="refresh-studio">检查关联状态</button><button type="button" data-action="forget-studio">撤销/忘记关联</button></div>
              <div class="actions"><button type="button" data-action="send-studio" disabled>发送到已关联 Studio</button><button type="button" data-action="download-last-export" disabled>重新下载最近归档</button></div>
              <details>
                <summary>兼容旧版 Toolkit：一次性接收码</summary>
                <p class="message">请先完成导出，再到 Studio 生成 15 分钟有效的一次性接收码。</p>
                <div class="field"><label for="studio-pairing-code">一次性接收码</label><input id="studio-pairing-code" inputmode="text" autocomplete="off" placeholder="8080:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
                <div class="actions"><button type="button" data-action="send-studio-legacy" disabled>使用接收码发送</button></div>
              </details>
            </div>
          </section>
          <section data-panel="import" hidden>
            <h3>导入关注</h3>
            <div class="field"><label for="archive-files">选择旧版 JSON 或 v2 ZIP</label><input id="archive-files" type="file" multiple accept=".json,.zip,.treehole.zip,application/json,application/zip"></div>
            <div class="actions"><button type="button" data-action="preview-import">解析并预检</button><button class="primary" type="button" data-action="execute-import" disabled>确认导入</button></div>
            <div class="preview" data-import-preview hidden></div>
          </section>
          <div class="status-card" aria-busy="false">
            <div class="status-line"><strong data-state>空闲</strong><span data-count>0 / 0</span></div>
            <progress value="0" max="1" aria-label="任务进度"></progress>
            <div class="actions"><button type="button" data-action="pause" disabled>暂停</button><button type="button" data-action="resume" disabled>继续</button><button class="danger" type="button" data-action="cancel" disabled>取消</button><button type="button" data-action="retry" disabled>仅重试失败项</button></div>
            <p class="message" role="status" aria-live="polite"></p>
          </div>
        </main>
      </div>
    </div>`;
}

function downloadBlob(documentObject, blob, filename) {
  const link = documentObject.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.hidden = true;
  documentObject.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 30_000);
}

function parsePidInput(value) {
  return String(value || '')
    .split(/[\s,，;；]+/)
    .map((pid) => pid.trim().replace(/^#/, ''))
    .filter(Boolean);
}

function mountToolkit({
  api,
  store,
  credentialsProvider,
  documentObject = globalThis.document,
  windowObject = globalThis.window,
}) {
  if (!documentObject?.body) return null;
  let entry = documentObject.getElementById(ENTRY_ID);
  let host = documentObject.getElementById(HOST_ID);
  let activeJob = null;
  let activeKind = null;
  let activeJobId = null;
  let lastExportOptions = null;
  let importPreview = null;
  let lastArchive = null;
  let studioBridgeState = null;
  let pairingWatch = null;
  let isRunning = false;
  let bookmarksLoaded = false;
  const mountedAt = Date.now();
  const studioBridgeStorage = createStudioBridgeStorage();
  let preferenceStorage = null;
  try {
    preferenceStorage = windowObject.localStorage;
  } catch {
    // Some hardened browser profiles deny access to origin storage.
  }
  const savedDestinations = readArchiveDestinations(preferenceStorage);

  if (!entry) {
    entry = documentObject.createElement('button');
    entry.id = ENTRY_ID;
    entry.type = 'button';
    entry.textContent = '归档/迁移';
    entry.style.minWidth = '78px';
    entry.style.marginInline = '4px';
  }
  if (!host) {
    host = documentObject.createElement('div');
    host.id = HOST_ID;
    documentObject.body.append(host);
  }
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  if (!shadow.querySelector('.overlay')) shadow.innerHTML = panelTemplate();

  const $ = (selector) => shadow.querySelector(selector);
  const overlay = $('.overlay');
  const statusLabel = $('[data-state]');
  const statusCard = statusLabel.closest('.status-card');
  const countLabel = $('[data-count]');
  const progress = $('progress');
  const message = statusCard.querySelector('.message');
  const pauseButton = $('[data-action="pause"]');
  const resumeButton = $('[data-action="resume"]');
  const cancelButton = $('[data-action="cancel"]');
  const retryButton = $('[data-action="retry"]');
  const importExecuteButton = $('[data-action="execute-import"]');
  const studioConnectionMessage = $('[data-studio-connection]');
  const studioPairButton = $('[data-action="pair-studio"]');
  const studioRefreshButton = $('[data-action="refresh-studio"]');
  const studioForgetButton = $('[data-action="forget-studio"]');
  const studioSendButton = $('[data-action="send-studio"]');
  const studioLegacySendButton = $('[data-action="send-studio-legacy"]');
  const lastExportDownloadButton = $('[data-action="download-last-export"]');
  const deliveryDownload = $('#delivery-download');
  const deliveryStudio = $('#delivery-studio');
  deliveryDownload.checked = savedDestinations.download;
  deliveryStudio.checked = savedDestinations.studio;

  function placeEntry() {
    const anchor = documentObject.querySelector('div.search-btn');
    if (anchor) {
      ensureEntryBeforeAnchor(entry, anchor);
      Object.assign(entry.style, { position: '', right: '', bottom: '', zIndex: '' });
    } else if (!entry.isConnected && Date.now() - mountedAt >= 10_000) {
      documentObject.body.append(entry);
      Object.assign(entry.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: '2147483645',
      });
    }
  }

  function setMessage(text, isError = false) {
    message.textContent = text || '';
    message.classList.toggle('error', isError);
  }

  function setRunning(running) {
    isRunning = running;
    statusCard.setAttribute('aria-busy', String(running));
    pauseButton.disabled = !running;
    cancelButton.disabled = !running;
    resumeButton.disabled = running || !activeJobId;
    retryButton.disabled = running || !activeJobId;
    $('[data-action="export"]').disabled = running;
    studioSendButton.disabled = running || !lastArchive || studioBridgeState?.status !== 'paired';
    studioLegacySendButton.disabled = running || !lastArchive;
    lastExportDownloadButton.disabled = running || !lastArchive;
    studioPairButton.disabled = running || studioBridgeState?.status === 'paired' || studioBridgeState?.status === 'pending';
    studioRefreshButton.disabled = running || !studioBridgeState;
    studioForgetButton.disabled = running || !studioBridgeState;
    deliveryDownload.disabled = running;
    deliveryStudio.disabled = running;
    $('[data-action="preview-import"]').disabled = running;
    importExecuteButton.disabled =
      running ||
      !importPreview ||
      importPreview.remoteComplete !== true ||
      importPreview.newPids?.length === 0;
  }

  function renderStudioBridgeState() {
    const state = studioBridgeState;
    if (state?.status === 'paired') {
      studioConnectionMessage.textContent = `已关联 ${state.name || 'Toolkit 设备'}，发送时会自动申请仅对当前归档有效的一次性票据。`;
      $('#studio-port').value = String(state.port || 8080);
      studioPairButton.textContent = 'Studio 已关联';
    } else if (state?.status === 'pending') {
      studioConnectionMessage.textContent = `等待 Studio 确认。请在 Studio“Toolkit 传输”页核对：${state.verificationCode || '------'}`;
      $('#studio-port').value = String(state.port || 8080);
      studioPairButton.textContent = '等待 Studio 确认';
    } else {
      studioConnectionMessage.textContent = '尚未关联 Studio。首次关联需要在 Studio 核对一次，之后发送不再复制接收码。';
      studioPairButton.textContent = '关联本机 Studio';
    }
    setRunning(isRunning);
  }

  function handleProgress(event) {
    const total = Number(event.total || 0);
    const completed = Number(event.completed || event.count || 0);
    progress.max = Math.max(1, total);
    progress.value = Math.min(completed, progress.max);
    countLabel.textContent = `${completed} / ${total || '?'}`;
    if (event.state) statusLabel.textContent = event.state;
    if (event.pid) setMessage(`正在处理 #${event.pid}（${event.phase || ''}）`);
    else if (event.phase === 'archive_files') {
      setMessage(`正在解析归档文件：${completed} / ${total || '?'}…`);
    } else if (event.phase === 'remote_followed') {
      setMessage(`正在读取当前关注：${completed} / ${total || '?'}…`);
    }
  }

  async function ensureBookmarks() {
    if (bookmarksLoaded) return;
    const select = $('#bookmark');
    try {
      const bookmarks = await api.listBookmarks();
      select.replaceChildren(
        ...bookmarks.map((bookmark) => {
          const option = documentObject.createElement('option');
          option.value = bookmark.id;
          option.textContent = bookmark.name;
          return option;
        }),
      );
      if (!bookmarks.length) {
        const option = documentObject.createElement('option');
        option.value = '';
        option.textContent = '暂无收藏分组';
        select.append(option);
      }
      bookmarksLoaded = true;
    } catch (error) {
      select.replaceChildren();
      const option = documentObject.createElement('option');
      option.value = '';
      option.textContent = '分组加载失败';
      select.append(option);
      setMessage(error.message, true);
    }
  }

  async function discoverResumableJob() {
    try {
      const credentials = await credentialsProvider();
      const restored = await restoreLatestExportArchive(store, credentials.accountFingerprint);
      if (restored) {
        lastArchive = restored.archive;
        lastExportOptions = restored.job.options;
        setRunning(false);
      }
      const jobs = (await store.listJobs())
        .filter(
          (job) =>
            job.accountFingerprint === credentials.accountFingerprint &&
            ['running', 'paused', 'partial'].includes(job.state),
        )
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
      const job = jobs[0];
      if (!job) {
        if (restored) setMessage('已恢复最近完成的归档，可重新下载或发送到 Studio。');
        return;
      }
      activeJobId = job.id;
      activeKind = job.type;
      if (job.type === 'export') lastExportOptions = job.options;
      if (job.type === 'import') importPreview = job.preview;
      if (job.state === 'running') {
        job.state = 'paused';
        await store.putJob(job);
      }
      statusLabel.textContent = 'paused';
      countLabel.textContent = `${job.completed || 0} / ${job.total || '?'}`;
      setMessage(`发现可恢复的${job.type === 'export' ? '导出' : '导入'}任务。`);
      resumeButton.disabled = false;
      retryButton.disabled = false;
      importExecuteButton.disabled = !importPreview;
      if (importPreview?.remoteComplete !== true || importPreview?.newPids?.length === 0) {
        importExecuteButton.disabled = true;
      }
    } catch (error) {
      if (error.code !== ERROR_CODES.UNAUTHORIZED) console.warn('[PKU Hole Toolkit]', error);
    }
  }

  function exportOptions() {
    const type = $('#scope').value;
    const scope = { type };
    if (type === 'group') scope.bookmarkId = $('#bookmark').value;
    if (type === 'pids') scope.pids = parsePidInput($('#export-pids').value);
    if (type === 'date') {
      scope.startDate = $('#start-date').value || null;
      scope.endDate = $('#end-date').value || null;
    }
    return {
      scope,
      includeComments: $('#include-comments').checked,
      includeReadable: $('#include-readable').checked,
      referenceMode: $('#reference-mode').value,
    };
  }

  function archiveDestinations() {
    return writeArchiveDestinations(preferenceStorage, {
      download: deliveryDownload.checked,
      studio: deliveryStudio.checked,
    });
  }

  async function deliverExportArchive(archive, destinations) {
    const delivery = await deliverArchiveToDestinations({
      archive,
      destinations,
      studioConnected: studioBridgeState?.status === 'paired',
      downloadArchive: (value) => downloadBlob(documentObject, value.blob, value.filename),
      sendArchiveToStudio: (value) => sendArchiveToTrustedStudio(value, {
        state: studioBridgeState,
        storage: studioBridgeStorage,
      }),
    });
    const studioError = delivery.studioError;
    if (
      delivery.studio === 'failed' &&
      studioError &&
      (studioError.status === 404 || studioError.code === ERROR_CODES.UNAUTHORIZED)
    ) {
      await studioBridgeStorage.delete();
      studioBridgeState = null;
      renderStudioBridgeState();
    }
    return delivery;
  }

  function deliveryMessage(delivery) {
    const messages = [];
    if (delivery.download === 'started') messages.push('已开始下载本地归档');
    else if (delivery.download === 'failed') {
      messages.push(`启动本地下载失败：${delivery.downloadError?.message || '未知错误'}`);
    }
    if (delivery.studio === 'awaiting_confirmation') {
      messages.push(
        `已发送到 Studio 并通过预检（${delivery.studioResult?.preflight?.counts?.valid_items ?? '?'} 个有效帖子），请在 Studio 确认导入`,
      );
    } else if (delivery.studio === 'not_connected') {
      messages.push('尚未发送到 Studio：请先完成关联');
    } else if (delivery.studio === 'failed') {
      messages.push(`发送 Studio 失败：${delivery.studioError?.message || '未知错误'}`);
    }
    return messages.join('；');
  }

  async function runExport(options, jobId = null) {
    const destinations = archiveDestinations();
    if (!destinations.download && !destinations.studio) {
      setMessage('请至少选择“下载归档到本机”或“发送到已关联 Studio”之一', true);
      return;
    }
    if (destinations.studio && !destinations.download && studioBridgeState?.status !== 'paired') {
      setMessage('当前只选择了发送 Studio，请先关联本机 Studio；也可以同时选择下载到本机', true);
      return;
    }
    setRunning(true);
    setMessage('正在规划导出范围…');
    statusLabel.textContent = 'planning';
    try {
      const credentials = await credentialsProvider();
      activeKind = 'export';
      activeJob = new ExportJob({
        api,
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
        confirmReferences: async (count) =>
          windowObject.confirm(`检测到 ${count} 个引用洞，是否继续抓取？`),
      });
      const result = await activeJob.run(options, { jobId });
      activeJobId = result.job.id;
      if (result.paused) {
        statusLabel.textContent = 'paused';
        setMessage('任务已暂停，可稍后继续。');
        return;
      }
      lastArchive = result.archive;
      const delivery = await deliverExportArchive(result.archive, destinations);
      statusLabel.textContent = result.job.state;
      countLabel.textContent = `${result.manifest.counts.exportedHoles} / ${result.manifest.counts.expectedHoles ?? '?'}`;
      const archiveMessage = result.manifest.complete
          ? '导出完成。断点保留 7 天，可重新下载。'
          : `部分导出：${result.manifest.errors.length} 项失败，请查看 manifest 或重试。`;
      const sentMessage = deliveryMessage(delivery);
      setMessage(
        sentMessage ? `${archiveMessage}\n${sentMessage}。` : archiveMessage,
        !result.manifest.complete || Boolean(delivery.downloadError || delivery.studioError),
      );
    } catch (error) {
      activeJobId = activeJobId || activeJob?.jobId || null;
      setMessage(error.message || '导出失败', true);
      statusLabel.textContent = error.code === ERROR_CODES.RATE_LIMITED ? 'paused' : 'failed';
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function previewImport() {
    const files = [...$('#archive-files').files];
    if (!files.length) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先选择归档文件');
    setRunning(true);
    statusLabel.textContent = 'previewing';
    countLabel.textContent = '0 / ?';
    progress.removeAttribute('value');
    setMessage('正在解析归档并读取当前关注列表；关注较多时可能需要几十秒…');
    try {
      const credentials = await credentialsProvider();
      activeKind = 'import';
      activeJob = new ImportJob({
        api,
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
      });
      importPreview = await activeJob.preview(files);
      const previewElement = $('[data-import-preview]');
      previewElement.hidden = false;
      previewElement.textContent = [
        `文件：${importPreview.archives.length}`,
        `唯一 PID：${importPreview.allPids.length}`,
        `将新增：${importPreview.newPids.length}`,
        `已关注：${importPreview.alreadyFollowed.length}`,
        `仅归档引用（不导入）：${importPreview.excludedReferenced}`,
        `重复：${importPreview.duplicateCount}`,
        `无效文件/记录：${importPreview.invalidFiles.length}`,
      ].join('\n');
      statusLabel.textContent = 'previewed';
      progress.max = 1;
      progress.value = 1;
      countLabel.textContent = `${importPreview.allPids.length} PID`;
      setMessage(
        importPreview.remoteComplete !== true
          ? '预检未完成：当前关注列表读取不完整，已禁止导入，请稍后重试。'
          : importPreview.newPids.length
          ? '预检完成。请核对数量后确认导入。'
          : '预检完成：所有 PID 均已关注，无需执行导入。',
        importPreview.remoteComplete !== true,
      );
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function executeImport(jobId = null) {
    if (!importPreview) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先执行预检');
    if (
      !windowObject.confirm(
        `将对当前账号新增关注 ${importPreview.newPids.length} 个洞。确认继续？`,
      )
    ) {
      return;
    }
    setRunning(true);
    try {
      const credentials = await credentialsProvider();
      activeKind = 'import';
      activeJob = new ImportJob({
        api,
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
      });
      const result = await activeJob.execute(importPreview, { jobId });
      activeJobId = result.job.id;
      statusLabel.textContent = result.job.state;
      if (!result.paused) {
        const text = buildImportAuditText(result.audit);
        downloadBlob(
          documentObject,
          new Blob([text], { type: 'text/plain;charset=utf-8' }),
          `${result.job.id}-audit.txt`,
        );
      }
      setMessage(
        result.paused
          ? '导入已暂停。'
          : `导入结束：成功 ${result.audit.followed}，失败 ${result.audit.failed}，未知 ${result.audit.unknown}。`,
        !result.paused && (result.audit.failed > 0 || result.audit.unknown > 0),
      );
    } catch (error) {
      activeJobId = activeJobId || activeJob?.jobId || null;
      setMessage(error.message || '导入失败', true);
      statusLabel.textContent = error.code === ERROR_CODES.RATE_LIMITED ? 'paused' : 'failed';
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function refreshStudioConnection() {
    try {
      studioBridgeState = await studioBridgeStorage.get();
      if (studioBridgeState?.status === 'pending') {
        studioBridgeState = await refreshStudioDevicePairing({ state: studioBridgeState, storage: studioBridgeStorage });
      }
    } catch (error) {
      if (error.status === 404 || error.code === ERROR_CODES.UNAUTHORIZED) studioBridgeState = null;
      else throw error;
    } finally {
      renderStudioBridgeState();
    }
    return studioBridgeState;
  }

  function watchStudioPairing(state) {
    if (pairingWatch || state?.status !== 'pending') return;
    pairingWatch = waitForStudioDevicePairing({
      state,
      storage: studioBridgeStorage,
      onUpdate(next) {
        studioBridgeState = next;
        renderStudioBridgeState();
      },
    })
      .then((paired) => {
        studioBridgeState = paired;
        renderStudioBridgeState();
        statusLabel.textContent = 'studio_paired';
        setMessage('Studio 关联成功。今后可直接发送，不再复制接收码。');
      })
      .catch((error) => {
        studioBridgeState = null;
        renderStudioBridgeState();
        statusLabel.textContent = 'failed';
        setMessage(error.message || 'Studio 关联失败', true);
      })
      .finally(() => {
        pairingWatch = null;
      });
  }

  async function pairStudio() {
    const port = $('#studio-port').value.trim();
    setRunning(true);
    statusLabel.textContent = 'pairing_studio';
    setMessage('正在向本机 Studio 发起关联请求…');
    try {
      studioBridgeState = await requestStudioDevicePairing({ port, storage: studioBridgeStorage });
      renderStudioBridgeState();
      const studioURL = `http://127.0.0.1:${studioBridgeState.port}/imports?view=bridge`;
      windowObject.open?.(studioURL, '_blank', 'noopener');
      setMessage(`关联请求已发出，请在 Studio 核对 ${studioBridgeState.verificationCode} 并确认。`);
      watchStudioPairing(studioBridgeState);
    } catch (error) {
      statusLabel.textContent = 'failed';
      setMessage(error.message || '无法发起 Studio 关联', true);
    } finally {
      setRunning(false);
    }
  }

  async function sendToTrustedStudio() {
    if (!lastArchive) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出');
    if (studioBridgeState?.status !== 'paired') throw new AppError(ERROR_CODES.UNAUTHORIZED, '请先关联本机 Studio');
    setRunning(true);
    statusLabel.textContent = 'sending';
    setMessage('正在签名并把归档发送到已关联 Studio…');
    try {
      const result = await sendArchiveToTrustedStudio(lastArchive, { state: studioBridgeState, storage: studioBridgeStorage });
      statusLabel.textContent = 'awaiting_confirmation';
      setMessage(`发送成功：${result.preflight?.counts?.valid_items ?? '?'} 个有效帖子。请回到 Studio 确认导入。`);
    } catch (error) {
      if (error.status === 404 || error.code === ERROR_CODES.UNAUTHORIZED) {
        await studioBridgeStorage.delete();
        studioBridgeState = null;
        renderStudioBridgeState();
      }
      statusLabel.textContent = 'failed';
      setMessage(error.message || '发送到 Studio 失败', true);
    } finally {
      setRunning(false);
    }
  }

  async function forgetStudioConnection() {
    const previous = studioBridgeState;
    setRunning(true);
    try {
      const result = await forgetStudioDevice({ state: previous, storage: studioBridgeStorage });
      studioBridgeState = null;
      renderStudioBridgeState();
      setMessage(result.revoked ? '已从 Toolkit 和 Studio 撤销设备关联。' : '已删除本地关联请求。');
    } catch (error) {
      studioBridgeState = null;
      renderStudioBridgeState();
      setMessage(`本地关联已删除；Studio 当前不可达，稍后可在 Studio 设备列表清理。${error.message ? `（${error.message}）` : ''}`);
    } finally {
      setRunning(false);
    }
  }

  async function sendToStudioWithCode() {
    if (!lastArchive) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出');
    const code = $('#studio-pairing-code').value.trim();
    if (!code) throw new AppError(ERROR_CODES.INVALID_INPUT, '请粘贴 Studio 生成的一次性接收码');
    setRunning(true);
    statusLabel.textContent = 'sending';
    setMessage('正在把归档发送到本机 Studio…');
    try {
      const result = await sendArchiveToStudio(code, lastArchive);
      statusLabel.textContent = 'awaiting_confirmation';
      setMessage(`发送成功：${result.preflight?.counts?.valid_items ?? '?'} 个有效帖子。请回到 Studio 确认导入。`);
      $('#studio-pairing-code').value = '';
    } catch (error) {
      statusLabel.textContent = 'failed';
      setMessage(error.message || '发送到 Studio 失败', true);
    } finally {
      setRunning(false);
    }
  }

  function downloadLastExport() {
    if (!lastArchive) throw new AppError(ERROR_CODES.INVALID_INPUT, '没有可重新下载的完成归档');
    downloadBlob(documentObject, lastArchive.blob, lastArchive.filename);
    setMessage(`已重新下载 ${lastArchive.filename}`);
  }

  function openPanel() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    $('.close').focus();
    discoverResumableJob();
    refreshStudioConnection()
      .then((state) => watchStudioPairing(state))
      .catch((error) => setMessage(error.message || '读取 Studio 关联状态失败', true));
  }

  function closePanel() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    entry.focus();
  }

  entry.addEventListener('click', openPanel);
  $('.close').addEventListener('click', closePanel);
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });
  $('#scope').addEventListener('change', (event) => {
    shadow.querySelectorAll('[data-for-scope]').forEach((element) => {
      element.hidden = element.dataset.forScope !== event.target.value;
    });
    if (event.target.value === 'group') ensureBookmarks();
  });
  shadow.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      shadow.querySelectorAll('[data-tab]').forEach((other) =>
        other.setAttribute('aria-selected', String(other === tab)),
      );
      shadow.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      });
    });
  });
  $('[data-action="export"]').addEventListener('click', () => {
    lastExportOptions = exportOptions();
    runExport(lastExportOptions);
  });
  deliveryDownload.addEventListener('change', archiveDestinations);
  deliveryStudio.addEventListener('change', archiveDestinations);
  $('[data-action="send-studio"]').addEventListener('click', () =>
    sendToTrustedStudio().catch((error) => {
      statusLabel.textContent = 'failed';
      setMessage(error.message || '发送到 Studio 失败', true);
    }),
  );
  $('[data-action="send-studio-legacy"]').addEventListener('click', () =>
    sendToStudioWithCode().catch((error) => {
      statusLabel.textContent = 'failed';
      setMessage(error.message || '发送到 Studio 失败', true);
    }),
  );
  studioPairButton.addEventListener('click', () => pairStudio());
  studioForgetButton.addEventListener('click', () => forgetStudioConnection());
  studioRefreshButton.addEventListener('click', () =>
    refreshStudioConnection()
      .then((state) => {
        watchStudioPairing(state);
        if (state?.status === 'paired') setMessage('Studio 关联有效，可以直接发送。');
      })
      .catch((error) => setMessage(error.message || '检查 Studio 关联失败', true)),
  );
  lastExportDownloadButton.addEventListener('click', () => {
    try {
      downloadLastExport();
    } catch (error) {
      setMessage(error.message, true);
    }
  });
  $('[data-action="preview-import"]').addEventListener('click', () =>
    previewImport().catch((error) => {
      statusLabel.textContent = error.code === ERROR_CODES.CANCELLED ? 'cancelled' : 'failed';
      setMessage(error.message, true);
    }),
  );
  importExecuteButton.addEventListener('click', () => executeImport());
  pauseButton.addEventListener('click', () => {
    activeJob?.requestPause();
    setMessage('将在当前洞处理完成后暂停…');
  });
  cancelButton.addEventListener('click', () => activeJob?.cancel());
  resumeButton.addEventListener('click', () => {
    if (activeKind === 'export') runExport(lastExportOptions, activeJobId);
    else if (activeKind === 'import') executeImport(activeJobId);
  });
  retryButton.addEventListener('click', () => {
    if (activeKind === 'export') runExport(lastExportOptions, activeJobId);
    else if (activeKind === 'import') executeImport(activeJobId);
  });

  placeEntry();
  const fallbackTimer = setTimeout(placeEntry, 10_000);
  const Observer = windowObject.MutationObserver || globalThis.MutationObserver;
  let placementScheduled = false;
  const schedulePlacement = () => {
    if (placementScheduled) return;
    placementScheduled = true;
    const run = () => {
      placementScheduled = false;
      placeEntry();
    };
    if (typeof windowObject.requestAnimationFrame === 'function') {
      windowObject.requestAnimationFrame(run);
    } else {
      windowObject.setTimeout(run, 0);
    }
  };
  const observer = new Observer(schedulePlacement);
  observer.observe(documentObject.body, { childList: true, subtree: true });

  return {
    entry,
    host,
    open: openPanel,
    close: closePanel,
    destroy() {
      clearTimeout(fallbackTimer);
      observer.disconnect();
      entry.remove();
      host.remove();
    },
    reportError(error) {
      const record = toErrorRecord(error);
      openPanel();
      setMessage(record.message, true);
    },
  };
}


// ---- main.js ----
function startToolkit({
  documentObject = globalThis.document,
  windowObject = globalThis.window,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  indexedDBObject = globalThis.indexedDB,
} = {}) {
  let credentialsPromise = null;
  const credentialsProvider = () => {
    if (!credentialsPromise) {
      credentialsPromise = getCredentials({
        documentObject,
        storage: windowObject.localStorage,
        cryptoObject: windowObject.crypto,
      }).catch((error) => {
        credentialsPromise = null;
        throw error;
      });
    }
    return credentialsPromise;
  };
  const scheduler = new RequestScheduler({ fetchImpl });
  const api = new TreeholeApi({ scheduler, credentialsProvider });
  const store = new JobStore({ indexedDBObject });
  store.cleanup().catch((error) => console.warn('[PKU Hole Toolkit] 清理旧任务失败', error));
  return mountToolkit({ api, store, credentialsProvider, documentObject, windowObject });
}

function bootstrap() {
  try {
    startToolkit();
  } catch (error) {
    console.error('[PKU Hole Toolkit] 启动失败', error);
  }
}

if (globalThis.document?.body) bootstrap();
else globalThis.document?.addEventListener('DOMContentLoaded', bootstrap, { once: true });

})();
