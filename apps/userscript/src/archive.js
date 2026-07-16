import { APP_VERSION, LIMITS, PID_PATTERN } from './config.js';
import { AppError, ERROR_CODES } from './errors.js';
import { createZip, readZip } from './zip.js';

const SENSITIVE_KEY_PATTERN = /token|authorization|cookie|uuid|accountFingerprint/i;
export const ARCHIVE_SPEC_VERSION = '2.1.0';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validArchiveScope(value) {
  if (!isPlainObject(value)) return false;
  const selector = isPlainObject(value.scope) ? value.scope : value;
  return typeof selector.type === 'string' && selector.type.length > 0;
}

export function sanitizeForArchive(value, seen = new WeakSet()) {
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

export function flattenLegacyComments(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const visit = (item) => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') result.push(item);
  };
  value.forEach(visit);
  return result;
}

export function legacyArchiveToItems(value) {
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

export function validateArchiveV2(manifest, data) {
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

export function buildReadableText(items) {
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

export function createManifest({
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

export function createArchive({ manifest, items, includeReadable = true }) {
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

export function parseArchiveBytes(bytes, filename = 'archive.zip') {
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

export async function parseArchiveFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '请选择归档文件');
  }
  if (file.size > LIMITS.maxArchiveBytes) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '归档文件超过 200MB');
  }
  return parseArchiveBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}
