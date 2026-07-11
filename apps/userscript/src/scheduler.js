import { AppError, ERROR_CODES, throwIfAborted } from './errors.js';
import { REQUEST_POLICY } from './config.js';

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

export class RequestScheduler {
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
