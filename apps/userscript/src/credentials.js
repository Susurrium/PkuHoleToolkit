import { AppError, ERROR_CODES } from './errors.js';

export function parseCookieString(cookieString = '') {
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

export async function getCredentials({
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

export function createAuthHeaders(credentials, extra = {}) {
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
