import { JOB_STATES, LIMITS } from './config.js';
import { parseArchiveFile } from './archive.js';
import { AppError, ERROR_CODES, isAppError, toErrorRecord, throwIfAborted } from './errors.js';
import { normalizePid } from './api.js';

function importRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `import-${stamp}-${suffix}`;
}

export class ImportJob {
  constructor({ api, store, accountFingerprint, onProgress = () => {} }) {
    this.api = api;
    this.store = store;
    this.accountFingerprint = accountFingerprint;
    this.onProgress = onProgress;
    this.controller = null;
    this.pauseRequested = false;
  }

  requestPause() {
    this.pauseRequested = true;
  }

  cancel() {
    this.controller?.abort('cancelled');
  }

  async preview(files, { signal } = {}) {
    const unique = new Set();
    let duplicateCount = 0;
    const invalidFiles = [];
    const archives = [];
    for (const file of files || []) {
      throwIfAborted(signal, 'import_preview');
      try {
        const archive = await parseArchiveFile(file);
        archives.push({ name: file.name, format: archive.format });
        for (const item of archive.data.items) {
          try {
            const pid = normalizePid(item.pid);
            if (unique.has(pid)) duplicateCount += 1;
            unique.add(pid);
          } catch (error) {
            invalidFiles.push({ file: file.name, error: toErrorRecord(error) });
          }
        }
      } catch (error) {
        invalidFiles.push({ file: file.name, error: toErrorRecord(error) });
      }
    }
    if (unique.size > LIMITS.maxImportPids) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '导入 PID 数量超过 20000');
    }
    const followed = await this.api.getAllFollowed({ signal });
    const followedPids = new Set(followed.items.map((hole) => String(hole.pid)));
    const alreadyFollowed = [...unique].filter((pid) => followedPids.has(pid));
    const newPids = [...unique].filter((pid) => !followedPids.has(pid));
    return {
      archives,
      allPids: [...unique],
      newPids,
      alreadyFollowed,
      duplicateCount,
      invalidFiles,
      remoteComplete: followed.complete,
    };
  }

  async execute(preview, { signal: externalSignal, jobId = null } = {}) {
    this.pauseRequested = false;
    this.controller = new AbortController();
    const onExternalAbort = () => this.controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const signal = this.controller.signal;
    this.api.scheduler?.resetRateLimitCount?.();

    let job = jobId ? await this.store.getJob(jobId) : null;
    if (job && job.accountFingerprint !== this.accountFingerprint) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, '该导入断点属于另一个账号');
    }
    if (!job) {
      job = {
        id: importRunId(),
        type: 'import',
        state: JOB_STATES.PLANNING,
        createdAt: Date.now(),
        accountFingerprint: this.accountFingerprint,
        pids: preview.newPids,
        preview: {
          archives: preview.archives,
          allPids: preview.allPids,
          newPids: preview.newPids,
          alreadyFollowed: preview.alreadyFollowed,
          duplicateCount: preview.duplicateCount,
          invalidFiles: preview.invalidFiles,
          remoteComplete: preview.remoteComplete,
        },
        total: preview.newPids.length,
        completed: 0,
        results: [],
      };
    }
    await this.store.putJob({ ...job, state: JOB_STATES.RUNNING });
    const previous = await this.store.getItems(job.id);
    const completedPids = new Set(previous.map((result) => result.pid));
    const results = [...previous];

    try {
      for (const pid of job.pids) {
        throwIfAborted(signal, 'import');
        if (this.pauseRequested) {
          job.state = JOB_STATES.PAUSED;
          job.results = results;
          await this.store.putJob(job);
          return { job, paused: true, audit: this.buildAudit(preview, results) };
        }
        if (completedPids.has(pid)) continue;
        let result;
        try {
          const response = await this.api.followHole(pid, signal);
          result = { pid, status: response.status };
        } catch (error) {
          if (
            isAppError(error, ERROR_CODES.UNAUTHORIZED) ||
            isAppError(error, ERROR_CODES.RATE_LIMITED) ||
            isAppError(error, ERROR_CODES.CANCELLED)
          ) {
            throw error;
          }
          result = { pid, status: 'failed', error: toErrorRecord(error) };
        }
        results.push(result);
        completedPids.add(pid);
        await this.store.putItem(job.id, pid, result);
        job.completed = completedPids.size;
        job.results = results;
        await this.store.putJob(job);
        this.onProgress({ ...job, type: 'progress', pid });
      }
      const audit = this.buildAudit(preview, results);
      job.state = audit.failed === 0 && audit.unknown === 0 ? JOB_STATES.COMPLETED : JOB_STATES.PARTIAL;
      job.audit = audit;
      await this.store.putJob(job);
      return { job, paused: false, audit };
    } catch (error) {
      if (isAppError(error, ERROR_CODES.CANCELLED)) job.state = JOB_STATES.CANCELLED;
      else if (isAppError(error, ERROR_CODES.RATE_LIMITED)) job.state = JOB_STATES.PAUSED;
      else job.state = JOB_STATES.FAILED;
      job.fatalError = toErrorRecord(error);
      await this.store.putJob(job);
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.controller = null;
    }
  }

  buildAudit(preview, results) {
    const count = (statuses) => results.filter((result) => statuses.includes(result.status)).length;
    return {
      totalFiles: preview.archives.length,
      totalUnique: preview.allPids.length,
      requested: preview.newPids.length,
      alreadyFollowed: preview.alreadyFollowed.length,
      duplicates: preview.duplicateCount,
      invalidFiles: preview.invalidFiles,
      followed: count(['followed', 'followed_reconciled']),
      skipped: count(['already_followed']),
      notFound: results.filter((result) => result.error?.code === ERROR_CODES.NOT_FOUND).length,
      unknown: results.filter((result) => result.error?.code === ERROR_CODES.UNKNOWN_RESULT).length,
      failed: count(['failed']),
      results,
    };
  }
}

export function buildImportAuditText(audit) {
  return [
    '北大树洞关注导入审计报告',
    `文件数: ${audit.totalFiles}`,
    `唯一 PID: ${audit.totalUnique}`,
    `计划新增: ${audit.requested}`,
    `已关注: ${audit.alreadyFollowed}`,
    `成功关注: ${audit.followed}`,
    `结果未知: ${audit.unknown}`,
    `失败: ${audit.failed}`,
    '',
    ...audit.results.map(
      (result) => `#${result.pid}\t${result.status}\t${result.error?.message || ''}`,
    ),
  ].join('\n');
}
