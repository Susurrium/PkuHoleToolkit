import { JOB_STATES, LIMITS } from './config.js';
import { parseArchiveFile } from './archive.js';
import { AppError, ERROR_CODES, isAppError, toErrorRecord, throwIfAborted } from './errors.js';
import { normalizePid } from './api.js';

function importRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `import-${stamp}-${suffix}`;
}

const IMPORTABLE_SOURCES = new Set(['followed', 'explicit', 'legacy-v1']);
const COMPLETED_IMPORT_STATUSES = new Set([
  'followed',
  'followed_reconciled',
  'already_followed',
]);

function orderedResults(pids, resultsByPid) {
  return pids.map((pid) => resultsByPid.get(String(pid))).filter(Boolean);
}

export class ImportJob {
  constructor({ api, store, accountFingerprint, onProgress = () => {} }) {
    this.api = api;
    this.store = store;
    this.accountFingerprint = accountFingerprint;
    this.onProgress = onProgress;
    this.controller = null;
    this.pauseRequested = false;
    this.jobId = null;
  }

  requestPause() {
    this.pauseRequested = true;
  }

  cancel() {
    this.controller?.abort('cancelled');
  }

  async preview(files, { signal: externalSignal } = {}) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    this.controller = controller;
    const signal = controller.signal;
    this.api.scheduler?.resetRateLimitCount?.();
    const inputFiles = [...(files || [])];
    const unique = new Set();
    let duplicateCount = 0;
    let excludedReferenced = 0;
    const invalidFiles = [];
    const archives = [];
    try {
      for (const [index, file] of inputFiles.entries()) {
        throwIfAborted(signal, 'import_preview');
        try {
          const archive = await parseArchiveFile(file);
          archives.push({ name: file.name, format: archive.format });
          for (const item of archive.data.items) {
            if (item.source === 'referenced') {
              excludedReferenced += 1;
              continue;
            }
            if (!IMPORTABLE_SOURCES.has(item.source)) continue;
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
        this.onProgress({
          type: 'progress',
          state: 'previewing',
          phase: 'archive_files',
          completed: index + 1,
          total: inputFiles.length,
        });
      }
      if (unique.size > LIMITS.maxImportPids) {
        throw new AppError(ERROR_CODES.INVALID_INPUT, '导入 PID 数量超过 20000');
      }
      const followed = await this.api.getAllFollowed({
        signal,
        onPage: ({ count, total }) =>
          this.onProgress({
            type: 'progress',
            state: 'previewing',
            phase: 'remote_followed',
            completed: count,
            total,
          }),
      });
      const followedPids = new Set(followed.items.map((hole) => String(hole.pid)));
      const alreadyFollowed = [...unique].filter((pid) => followedPids.has(pid));
      const newPids = [...unique].filter((pid) => !followedPids.has(pid));
      return {
        accountFingerprint: this.accountFingerprint,
        archives,
        allPids: [...unique],
        newPids,
        alreadyFollowed,
        duplicateCount,
        excludedReferenced,
        invalidFiles,
        remoteComplete: followed.complete,
      };
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (this.controller === controller) this.controller = null;
    }
  }

  async execute(preview, { signal: externalSignal, jobId = null } = {}) {
    const storedJob = jobId ? await this.store.getJob(jobId) : null;
    if (jobId && !storedJob) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '找不到要恢复的导入任务');
    }
    if (storedJob && storedJob.type !== 'import') {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '任务类型不是导入任务');
    }
    if (storedJob && storedJob.accountFingerprint !== this.accountFingerprint) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, '该导入断点属于另一个账号');
    }
    const effectivePreview = storedJob?.preview || preview;
    const previewAccountFingerprint =
      effectivePreview?.accountFingerprint || storedJob?.accountFingerprint;
    if (previewAccountFingerprint !== this.accountFingerprint) {
      throw new AppError(
        ERROR_CODES.UNAUTHORIZED,
        '预检账号与当前账号不一致，请重新预检后再导入',
      );
    }
    if (!effectivePreview || effectivePreview.remoteComplete !== true) {
      throw new AppError(
        ERROR_CODES.INVALID_RESPONSE,
        '当前关注列表读取不完整，已禁止导入；请重新预检后再试',
      );
    }
    this.pauseRequested = false;
    this.controller = new AbortController();
    const onExternalAbort = () => this.controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const signal = this.controller.signal;
    this.api.scheduler?.resetRateLimitCount?.();

    let job = storedJob;
    if (!job) {
      job = {
        id: importRunId(),
        type: 'import',
        state: JOB_STATES.PLANNING,
        createdAt: Date.now(),
        accountFingerprint: this.accountFingerprint,
        pids: effectivePreview.newPids,
        preview: {
          accountFingerprint: effectivePreview.accountFingerprint,
          archives: effectivePreview.archives,
          allPids: effectivePreview.allPids,
          newPids: effectivePreview.newPids,
          alreadyFollowed: effectivePreview.alreadyFollowed,
          duplicateCount: effectivePreview.duplicateCount,
          excludedReferenced: effectivePreview.excludedReferenced,
          invalidFiles: effectivePreview.invalidFiles,
          remoteComplete: effectivePreview.remoteComplete,
        },
        total: effectivePreview.newPids.length,
        completed: 0,
        results: [],
      };
    }
    this.jobId = job.id;
    job.state = JOB_STATES.RUNNING;
    delete job.audit;
    delete job.fatalError;
    const previous = await this.store.getItems(job.id);
    const jobPids = new Set(job.pids.map(String));
    const resultsByPid = new Map(
      previous
        .filter((result) => jobPids.has(String(result.pid)))
        .map((result) => [String(result.pid), result]),
    );
    job.completed = resultsByPid.size;
    job.results = orderedResults(job.pids, resultsByPid);
    await this.store.putJob(job);

    try {
      for (const pid of job.pids) {
        throwIfAborted(signal, 'import');
        if (this.pauseRequested) {
          job.state = JOB_STATES.PAUSED;
          job.results = orderedResults(job.pids, resultsByPid);
          job.completed = job.results.length;
          await this.store.putJob(job);
          return {
            job,
            paused: true,
            audit: this.buildAudit(effectivePreview, job.results),
          };
        }
        const previousResult = resultsByPid.get(String(pid));
        if (COMPLETED_IMPORT_STATUSES.has(previousResult?.status)) continue;
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
          const errorRecord = toErrorRecord(error);
          result = {
            pid,
            status: errorRecord.code === ERROR_CODES.UNKNOWN_RESULT ? 'unknown' : 'failed',
            error: errorRecord,
          };
        }
        resultsByPid.set(String(pid), result);
        await this.store.putItem(job.id, pid, result);
        job.completed = resultsByPid.size;
        job.results = orderedResults(job.pids, resultsByPid);
        await this.store.putJob(job);
        this.onProgress({ ...job, type: 'progress', pid });
      }
      const results = orderedResults(job.pids, resultsByPid);
      const audit = this.buildAudit(effectivePreview, results);
      job.completed = results.length;
      job.results = results;
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
      excludedReferenced: preview.excludedReferenced || 0,
      invalidFiles: preview.invalidFiles,
      followed: count(['followed', 'followed_reconciled']),
      skipped: count(['already_followed']),
      notFound: results.filter((result) => result.error?.code === ERROR_CODES.NOT_FOUND).length,
      unknown: results.filter(
        (result) =>
          result.status === 'unknown' || result.error?.code === ERROR_CODES.UNKNOWN_RESULT,
      ).length,
      failed: results.filter(
        (result) =>
          result.status === 'failed' && result.error?.code !== ERROR_CODES.UNKNOWN_RESULT,
      ).length,
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
    `仅归档引用（未导入）: ${audit.excludedReferenced}`,
    `成功关注: ${audit.followed}`,
    `结果未知: ${audit.unknown}`,
    `失败: ${audit.failed}`,
    '',
    ...audit.results.map(
      (result) => `#${result.pid}\t${result.status}\t${result.error?.message || ''}`,
    ),
  ].join('\n');
}
