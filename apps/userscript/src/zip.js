import { AppError, ERROR_CODES } from './errors.js';

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

export function crc32(bytes) {
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

export function createZip(entries, date = new Date()) {
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

export function readZip(input, { maxUncompressedBytes = Infinity } = {}) {
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
