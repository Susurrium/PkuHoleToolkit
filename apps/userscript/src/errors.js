export const ERROR_CODES = Object.freeze({
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

export class AppError extends Error {
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

export function isAppError(error, code = null) {
  return error instanceof AppError && (code === null || error.code === code);
}

export function toErrorRecord(error, fallback = {}) {
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

export function throwIfAborted(signal, operation = null) {
  if (signal?.aborted) {
    throw new AppError(ERROR_CODES.CANCELLED, '操作已取消', { operation });
  }
}
