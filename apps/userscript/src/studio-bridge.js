import { createArchive, parseArchiveBytes } from './archive.js';
import { AppError, ERROR_CODES } from './errors.js';

const BRIDGE_PROTOCOL = '2';
const BRIDGE_STATE_KEY = 'pkuhole-studio-bridge-v2';
const DEFAULT_STUDIO_PORT = 8080;
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const studioCapabilityCache = new Map();

export function parseStudioPairingCode(value) {
  const match = String(value || '').trim().match(/^(\d{1,5}):([a-f0-9]{32})$/i);
  if (!match) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '接收码格式不正确，请从 Studio 导入与导出页重新复制');
  }
  return { port: normalizeStudioPort(match[1]), token: match[2].toLowerCase() };
}

export function normalizeStudioPort(value) {
  const port = Number(value || DEFAULT_STUDIO_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, 'Studio 端口无效');
  }
  return port;
}

export async function sendArchiveToStudio(code, archive, request = globalThis.GM_xmlhttpRequest) {
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

export async function getStudioArchiveCapabilities({
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

export function clearStudioCapabilityCache() {
  studioCapabilityCache.clear();
}

export function assertStudioCanImportArchive(contract, bytes, filename = 'archive.zip') {
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

export async function requestStudioDevicePairing({
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

export async function refreshStudioDevicePairing({
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

export async function waitForStudioDevicePairing({
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

export async function sendArchiveToTrustedStudio(
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

export async function forgetStudioDevice({
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

export async function restoreLatestExportArchive(store, accountFingerprint = null) {
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

export function createStudioBridgeStorage({
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

export async function createStudioDeviceIdentity(cryptoObject = globalThis.crypto) {
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

export function transferSignatureMessage({ deviceId, instanceId, challenge, filename, size, sha256 }) {
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
