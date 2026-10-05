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
    onRateLimitRecovered = () => {},
  } = {}) {
    if (!fetchImpl) throw new TypeError('fetchImpl is required');
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.now = now;
    this.random = random;
    this.policy = { ...REQUEST_POLICY, ...policy };
    if (policy.jitterMs !== undefined) {
      this.policy.readJitterMs = policy.jitterMs;
      this.policy.writeJitterMs = policy.jitterMs;
    }
    this.onRateLimit = onRateLimit;
    this.onRateLimitRecovered = onRateLimitRecovered;
    this.queue = [];
    this.draining = false;
    this.inFlight = 0;
    this.writeInFlight = false;
    this.lastStartedAt = null;
    this.rateLimitCount = 0;
    this.blockedUntil = 0;
    this.blockVersion = 0;
    this.recovering = false;
    this.probeLease = null;
    this.changed = new Promise((resolve) => { this.wake = resolve; });
  }

  resetRateLimitCount() {
    this.rateLimitCount = 0;
  }

  pausePending() {
    for (const entry of [...this.queue]) {
      if (!entry.shouldPause?.()) continue;
      entry.remove();
      entry.reject(new AppError(ERROR_CODES.PAUSED, '任务已暂停', { operation: entry.operation }));
    }
    this.notify();
  }

  notify() {
    this.wake();
    this.changed = new Promise((resolve) => { this.wake = resolve; });
  }

  block(retryAfter, status) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryAfter);
    this.blockVersion += 1;
    this.recovering = true;
    this.rateLimitCount += 1;
    this.notify();
    this.onRateLimit({ retryAfter, blockedUntil: this.blockedUntil, count: this.rateLimitCount, status });
  }

  recovered(lease) {
    if (!this.recovering) return;
    // An older in-flight success cannot clear a newer server cooldown.
    if (this.probeLease !== lease || lease.blockVersion !== this.blockVersion) return;
    this.recovering = false;
    this.blockedUntil = 0;
    this.rateLimitCount = 0;
    this.notify();
    this.onRateLimitRecovered();
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const changed = this.changed;
        const entry = this.recovering
          ? this.queue.find((candidate) => candidate.kind === 'read')
          : this.queue[0];
        if (
          !entry || this.inFlight >= this.policy.maxReadConcurrent ||
          (entry.kind === 'write' && this.writeInFlight) ||
          (this.recovering && this.probeLease)
        ) {
          await changed;
          continue;
        }
        try {
          throwIfAborted(entry.signal);
          const interval = entry.kind === 'write' ? this.policy.writeIntervalMs : this.policy.readIntervalMs;
          const jitterRange = entry.kind === 'write' ? this.policy.writeJitterMs : this.policy.readJitterMs;
          const jitter = Math.floor(this.random() * (jitterRange + 1));
          const startsAfter = this.lastStartedAt === null ? this.now() : this.lastStartedAt + interval + jitter;
          let remaining = Math.max(startsAfter, this.blockedUntil) - this.now();
          while (remaining > 0) {
            await this.sleepImpl(remaining, entry.waitController.signal);
            throwIfAborted(entry.signal);
            remaining = Math.max(startsAfter, this.blockedUntil) - this.now();
          }
          if (this.recovering && (this.probeLease || entry.kind !== 'read')) continue;
          const overrides = await entry.beforeSend?.();
          throwIfAborted(entry.signal);
          if (!this.queue.includes(entry)) continue;
          if (this.now() < this.blockedUntil || (this.recovering && (this.probeLease || entry.kind !== 'read'))) continue;
          const lease = { kind: entry.kind, blockVersion: this.blockVersion, overrides };
          if (this.recovering) this.probeLease = lease;
          this.inFlight += 1;
          if (entry.kind === 'write') this.writeInFlight = true;
          this.lastStartedAt = this.now();
          entry.remove();
          entry.resolve(lease);
          // Let the admitted request start before timing the next admission.
          await Promise.resolve();
        } catch (error) {
          entry.remove();
          entry.reject(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async enqueue(context, callback) {
    throwIfAborted(context.signal);
    if (context.shouldPause?.()) throw new AppError(ERROR_CODES.PAUSED, '任务已暂停', { operation: context.operation });
    const lease = await new Promise((resolve, reject) => {
      const entry = { ...context, resolve, reject, waitController: new AbortController() };
      const onAbort = () => {
        entry.remove();
        reject(new AppError(ERROR_CODES.CANCELLED, '操作已取消', { operation: context.operation }));
        this.notify();
      };
      entry.remove = () => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        entry.waitController.abort('dequeued');
        entry.signal?.removeEventListener('abort', onAbort);
      };
      entry.signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
      this.notify();
      void this.drain();
    });
    try {
      throwIfAborted(context.signal);
      return await callback(lease);
    } finally {
      this.inFlight -= 1;
      if (lease.kind === 'write') this.writeInFlight = false;
      if (this.probeLease === lease) this.probeLease = null;
      this.notify();
    }
  }

  async fetchAttempt(url, options, context) {
    return this.enqueue(context, async (lease) => {
      const controller = new AbortController();
      let externallyAborted = false;
      const onAbort = () => {
        externallyAborted = true;
        controller.abort(context.signal?.reason);
      };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort('timeout'), this.policy.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...options, ...lease.overrides, signal: controller.signal });
        if (response.status === 429) {
          this.block(
            retryAfterMilliseconds(response.headers?.get?.('Retry-After'), this.now) ?? this.policy.missingRetryAfterMs,
            429,
          );
        } else if (response.status === 503) {
          const retryAfter = retryAfterMilliseconds(response.headers?.get?.('Retry-After'), this.now);
          if (retryAfter !== null) this.block(retryAfter, 503);
        }
        throwIfAborted(context.signal, context.operation);
        let body;
        try {
          if (response.ok && context.readBody) body = await context.readBody(response);
          else if (context.readBody) {
            await response.body?.cancel?.();
            body = null;
          } else body = await response.json();
        } catch (error) {
          if (error instanceof AppError) throw error;
          if (controller.signal.aborted || context.readBody) throw error;
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
        if (response.ok && body?.success !== false && (body?.code === undefined || body.code === 20000)) {
          throwIfAborted(context.signal, context.operation);
          this.recovered(lease);
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
    return this.request(url, options, context);
  }

  async requestBinary(url, options = {}, context = {}) {
    return this.request(url, options, { ...context, kind: 'read' });
  }

  async request(url, options = {}, context = {}) {
    const normalized = {
      operation: context.operation || 'request',
      kind: context.kind === 'write' ? 'write' : 'read',
      signal: context.signal,
      readBody: context.readBody,
      beforeSend: context.beforeSend || context.beforeAttempt,
      shouldPause: context.shouldPause,
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
          const retryAfter =
            retryAfterMilliseconds(response.headers?.get?.('Retry-After'), this.now) ??
            this.policy.missingRetryAfterMs;
          if (attempt === maxAttempts || normalized.kind === 'write') {
            throw new AppError(ERROR_CODES.RATE_LIMITED, '请求过于频繁，任务已暂停', {
              status,
              retryable: true,
              operation: normalized.operation,
              details: { retryAfter },
            });
          }
          // Re-enter the shared gate; one read probes before the queue resumes.
          continue;
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
