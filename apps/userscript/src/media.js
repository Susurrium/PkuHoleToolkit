import { LIMITS } from './config.js';
import { AppError, ERROR_CODES, toErrorRecord, throwIfAborted } from './errors.js';

export const MEDIA_EXTENSION = 'io.github.susurrium.pkuhole.media';

export function parseMediaIds(raw) {
  if (raw === undefined || raw === null) return [];
  const parts = String(raw).replace(/[\[\]"']/g, '').split(/[,;\s|]+/);
  return [...new Set(parts.filter((id) => /^\d+$/.test(id)))];
}

export function mediaTargets(hole, comments = []) {
  const targets = [];
  const add = (ownerType, ownerId, remoteId) => targets.push({
    ownerType, ownerId: Number(ownerId), remoteId, variant: 'original',
  });
  if (hole) {
    const ids = parseMediaIds(hole.media_ids);
    for (const id of ids) add('post', hole.pid, id);
    if (!ids.length && String(hole.type || '').trim().toLowerCase() === 'image') {
      add('post', hole.pid, '');
    }
  }
  for (const comment of comments) {
    for (const id of parseMediaIds(comment.media_ids)) add('comment', comment.cid, id);
  }
  return targets;
}

export function mediaTargetKey(target) {
  return `${target.ownerType}:${target.ownerId}:${target.remoteId}`;
}

export async function mediaSHA256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function invalidMedia(message, retryable = false) {
  return new AppError(ERROR_CODES.INVALID_RESPONSE, message, { operation: 'download_media', retryable });
}

export function detectImageType(bytes) {
  const starts = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (starts(0xff, 0xd8, 0xff)) return { mimeType: 'image/jpeg', extension: '.jpg' };
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return { mimeType: 'image/png', extension: '.png' };
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { mimeType: 'image/gif', extension: '.gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mimeType: 'image/webp', extension: '.webp' };
  if (starts(66, 77)) return { mimeType: 'image/bmp', extension: '.bmp' };
  if (starts(73, 73, 42, 0) || starts(77, 77, 0, 42)) return { mimeType: 'image/tiff', extension: '.tif' };
  if (ascii(4, 8) === 'ftyp') {
    const brands = [ascii(8, 12)];
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    for (let index = 16; index + 4 <= Math.min(boxSize, bytes.length, 256); index += 4) {
      brands.push(ascii(index, index + 4));
    }
    if (brands.some((brand) => ['avif', 'avis'].includes(brand))) return { mimeType: 'image/avif', extension: '.avif' };
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand))) {
      return { mimeType: 'image/heif', extension: '.heif' };
    }
  }
  return null;
}

export async function readMediaResponse(response, maxBytes = LIMITS.maxMediaBytes) {
  const declaredType = (response.headers.get('Content-Type') || '').toLowerCase();
  const declaredSize = Number(response.headers.get('Content-Length'));
  if (/text\/html|application\/(?:json|[^;]+\+json)/.test(declaredType)) {
    await response.body?.cancel?.();
    throw invalidMedia('图片接口返回了错误页面或 JSON，未保存为图片');
  }
  if (declaredSize > maxBytes) {
    await response.body?.cancel?.();
    throw invalidMedia('图片超过本次备份的大小上限');
  }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw invalidMedia('图片超过本次备份的大小上限');
        }
        chunks.push(value);
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } finally {
      reader.releaseLock();
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (!bytes.length) throw invalidMedia('图片响应为空', true);
  if (bytes.length > maxBytes) throw invalidMedia('图片超过本次备份的大小上限');
  // Browsers transparently decompress responses, so compressed wire lengths
  // cannot be compared to the decoded byte length.
  if (!response.headers.get('Content-Encoding') && declaredSize > 0 && bytes.length !== declaredSize) {
    throw invalidMedia('图片响应不完整，长度与服务器声明不一致', true);
  }
  const type = detectImageType(bytes);
  if (!type) throw invalidMedia('图片内容格式无法确认，未保存为图片');
  return { bytes, ...type };
}

export async function verifyStoredMedia(record, bytes, verifiedHash = null) {
  const type = bytes instanceof Uint8Array ? detectImageType(bytes) : null;
  return Boolean(record?.status === 'available' && bytes instanceof Uint8Array && bytes.length > 0 &&
    bytes.length === record.size && bytes.length <= LIMITS.maxMediaBytes &&
    /^[a-f0-9]{64}$/.test(record.sha256 || '') && type && record.mimeType === type.mimeType &&
    record.path === `media/${record.sha256}${type.extension}` &&
    (verifiedHash || await mediaSHA256(bytes)) === record.sha256);
}

export class MediaCapture {
  constructor({ api, store, jobId, onProgress = () => {}, checkPause = () => {}, shouldPause = () => false, limits = LIMITS }) {
    Object.assign(this, { api, store, jobId, onProgress, checkPause, shouldPause, limits });
    this.records = new Map();
    this.fileSizes = new Map();
    this.verified = new Set();
    this.attempted = new Set();
    this.downloads = new Map();
    this.reservedBytes = 0;
    this.capacityChanged = new Promise((resolve) => { this.wakeCapacity = resolve; });
  }

  async initialize() {
    for (const record of await this.store.getMedia(this.jobId)) {
      this.records.set(mediaTargetKey(record), record);
      if (record.status === 'available' && Number.isSafeInteger(record.size) && record.size > 0 &&
        record.size <= this.limits.maxMediaBytes) this.fileSizes.set(record.sha256, record.size);
    }
  }

  releaseCapacity(bytes) {
    this.reservedBytes -= bytes;
    this.wakeCapacity();
    this.capacityChanged = new Promise((resolve) => { this.wakeCapacity = resolve; });
  }

  async reserveCapacity(signal) {
    while (true) {
      throwIfAborted(signal, 'capture_media');
      this.checkPause();
      const used = [...this.fileSizes.values()].reduce((sum, size) => sum + size, 0);
      const remaining = this.limits.mediaBudgetBytes - used - this.reservedBytes;
      const bytes = Math.min(this.limits.maxMediaBytes, this.limits.mediaBudgetBytes - used);
      if (bytes > 0 && remaining >= bytes) {
        this.reservedBytes += bytes;
        return bytes;
      }
      if (!this.reservedBytes) throw invalidMedia('图片总量已达到本次备份上限，请缩小备份范围');
      const changed = this.capacityChanged;
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new AppError(ERROR_CODES.CANCELLED, '操作已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        changed.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
  }

  async captureTarget(target, pid, signal) {
    const key = mediaTargetKey(target);
    const existing = this.records.get(key);
    if (existing?.status === 'available') {
      const bytes = await this.store.getMediaFile(this.jobId, existing.sha256);
      if (await verifyStoredMedia(existing, bytes, this.verified.has(existing.sha256) ? existing.sha256 : null)) {
        this.verified.add(existing.sha256);
        return existing;
      }
      this.fileSizes.delete(existing.sha256);
    }
    const shared = target.remoteId && [...this.records.values()].find((record) =>
      record.remoteId === target.remoteId && record.status === 'available' && this.verified.has(record.sha256));
    if (shared) return shared;
    const missing = { ...target, pid: String(pid), status: 'missing' };
    await this.store.putMedia(this.jobId, missing);
    this.records.set(key, missing);
    let reserved = 0;
    try {
      reserved = await this.reserveCapacity(signal);
      const result = await this.api.downloadMedia(target.remoteId, pid, signal, reserved, { shouldPause: this.shouldPause });
      throwIfAborted(signal, 'capture_media');
      const type = detectImageType(result.bytes);
      if (!type || !result.bytes.length || result.bytes.length > reserved) {
        throw invalidMedia('图片内容无效或超过本次备份上限');
      }
      const sha256 = await mediaSHA256(result.bytes);
      throwIfAborted(signal, 'capture_media');
      const available = { ...target, pid: String(pid), status: 'available', sha256,
        size: result.bytes.length, mimeType: type.mimeType, path: `media/${sha256}${type.extension}` };
      await this.store.putMedia(this.jobId, available, result.bytes);
      this.records.set(key, available);
      this.fileSizes.set(sha256, available.size);
      this.verified.add(sha256);
      return available;
    } catch (error) {
      if ([ERROR_CODES.UNAUTHORIZED, ERROR_CODES.RATE_LIMITED, ERROR_CODES.CANCELLED,
        ERROR_CODES.STORAGE_ERROR, ERROR_CODES.PAUSED].includes(error.code)) throw error;
      const record = { ...missing, error: toErrorRecord(error, { pid: String(pid), phase: 'media',
        ownerType: target.ownerType, ownerId: target.ownerId, remoteId: target.remoteId }) };
      await this.store.putMedia(this.jobId, record);
      this.records.set(key, record);
      return record;
    } finally {
      if (reserved) this.releaseCapacity(reserved);
    }
  }

  async capture(hole, comments, pid, signal) {
    for (const target of mediaTargets(hole, comments)) {
      throwIfAborted(signal, 'capture_media');
      this.checkPause();
      const key = mediaTargetKey(target);
      if (this.attempted.has(key)) continue;
      this.attempted.add(key);
      // Share in-flight downloads across post/comment owners, including failures.
      const remoteKey = target.remoteId ? `id:${target.remoteId}` : `pid:${pid}`;
      if (!this.downloads.has(remoteKey)) this.downloads.set(remoteKey, this.captureTarget(target, pid, signal));
      const captured = await this.downloads.get(remoteKey);
      throwIfAborted(signal, 'capture_media');
      const record = { ...captured, ...target, pid: String(pid) };
      if (captured.error) record.error = { ...captured.error, pid: String(pid),
        ownerType: target.ownerType, ownerId: target.ownerId, remoteId: target.remoteId };
      if (mediaTargetKey(captured) !== key) await this.store.putMedia(this.jobId, record);
      this.records.set(key, record);
      this.onProgress({ type: 'media', pid: String(pid),
        mediaAvailable: [...this.records.values()].filter((value) => value.status === 'available').length,
        mediaMissing: [...this.records.values()].filter((value) => value.status === 'missing').length,
        mediaBytes: [...this.fileSizes.values()].reduce((sum, size) => sum + size, 0) });
    }
  }

  complete(hole, comments) {
    return mediaTargets(hole, comments).every((target) => this.records.get(mediaTargetKey(target))?.status === 'available');
  }
}

export async function prepareExportMedia(store, jobId, items) {
  const saved = new Map((await store.getMedia(jobId)).map((record) => [mediaTargetKey(record), record]));
  const index = [];
  const files = {};
  const errors = [];
  for (const item of items) {
    for (const target of mediaTargets(item.hole, item.comments)) {
      const record = saved.get(mediaTargetKey(target));
      let available = false;
      if (record?.status === 'available') {
        const cached = files[record.path];
        const bytes = cached || await store.getMediaFile(jobId, record.sha256);
        if (await verifyStoredMedia(record, bytes, cached ? record.sha256 : null)) {
          files[record.path] = bytes;
          available = true;
        }
      }
      if (available) {
        index.push({ ...target, status: 'available', path: record.path,
          mimeType: record.mimeType, size: record.size, sha256: record.sha256 });
      } else {
        index.push({ ...target, status: 'missing' });
        errors.push(record?.error || { code: ERROR_CODES.INVALID_RESPONSE,
          message: '图片尚未保存或本地文件校验失败', pid: item.pid, phase: 'media',
          ownerType: target.ownerType, ownerId: target.ownerId, remoteId: target.remoteId, retryable: true });
      }
    }
  }
  return { index, files, errors };
}
