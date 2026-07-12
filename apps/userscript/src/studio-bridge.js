import { AppError, ERROR_CODES } from './errors.js';

export function parseStudioPairingCode(value) {
  const match = String(value || '').trim().match(/^(\d{1,5}):([a-f0-9]{32})$/i);
  if (!match) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '配对码格式不正确，请从 Studio 归档导入页重新复制');
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '配对码中的端口无效');
  }
  return { port, token: match[2].toLowerCase() };
}

export function sendArchiveToStudio(code, archive, request = globalThis.GM_xmlhttpRequest) {
  const { port, token } = parseStudioPairingCode(code);
  if (!archive?.blob || !archive?.filename) {
    return Promise.reject(new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出'));
  }
  if (typeof request !== 'function') {
    return Promise.reject(new AppError(ERROR_CODES.NETWORK, '当前用户脚本管理器不支持本地桥接请求，请更新脚本后重试'));
  }
  const body = new FormData();
  body.append('file', archive.blob, archive.filename);
  return new Promise((resolve, reject) => {
    request({
      method: 'POST',
      url: `http://127.0.0.1:${port}/api/v1/bridge/pairings/${token}/archive`,
      data: body,
      timeout: 120_000,
      onload(response) {
        let decoded;
        try {
          decoded = JSON.parse(response.responseText || '{}');
        } catch {
          reject(new AppError(ERROR_CODES.NETWORK, 'Studio 返回了无法识别的响应'));
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          reject(new AppError(ERROR_CODES.INVALID_INPUT, decoded?.error?.message || `Studio 拒绝了归档 (${response.status})`));
          return;
        }
        resolve(decoded.data);
      },
      ontimeout() {
        reject(new AppError(ERROR_CODES.TIMEOUT, '连接 Studio 超时，请确认 Studio 仍在运行'));
      },
      onerror() {
        reject(new AppError(ERROR_CODES.NETWORK, '无法连接 Studio，请确认程序、端口和配对码均正确'));
      },
    });
  });
}
