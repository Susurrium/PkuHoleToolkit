export const APP_VERSION = '1.3.0-beta.4';
export const API_ORIGIN = 'https://treehole.pku.edu.cn';
export const API_BASE = `${API_ORIGIN}/api`;
export const JOB_DB_NAME = 'pku-hole-tool';
export const JOB_DB_VERSION = 1;
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const PID_PATTERN = /^\d{5,7}$/;
export const REFERENCE_PATTERN = /#(\d{5,7})\b/g;
export const LEADING_REFERENCE_PATTERN = /^(\d{5,7})(?=\s)/;

export const REQUEST_POLICY = Object.freeze({
  readIntervalMs: 600,
  writeIntervalMs: 1000,
  jitterMs: 300,
  timeoutMs: 20_000,
  maxReadAttempts: 3,
  missingRetryAfterMs: 60_000,
});

export const LIMITS = Object.freeze({
  followedPages: 1024,
  commentPages: 500,
  maxReferencedPids: 2000,
  confirmReferencedPids: 200,
  maxImportPids: 20_000,
  maxArchiveBytes: 200 * 1024 * 1024,
  maxUncompressedBytes: 500 * 1024 * 1024,
});

export const JOB_STATES = Object.freeze({
  PLANNING: 'planning',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});
