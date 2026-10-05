import {
  JOB_STATES,
  LEADING_REFERENCE_PATTERN,
  LIMITS,
  REFERENCE_PATTERN,
} from './config.js';
import { createArchive, createManifest, sanitizeForArchive } from './archive.js';
import { AppError, ERROR_CODES, isAppError, toErrorRecord, throwIfAborted } from './errors.js';
import { normalizePid } from './api.js';
import { MediaCapture, prepareExportMedia } from './media.js';

function createRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `${timestamp}-${suffix}`;
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalidScope(message) {
  throw new AppError(ERROR_CODES.INVALID_INPUT, message);
}

function normalizeDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  const match = normalized.match(LOCAL_DATE_PATTERN);
  if (!match) invalidScope(`${fieldName}必须使用 YYYY-MM-DD 格式`);

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year === 0) invalidScope(`${fieldName}不是有效日期`);
  const date = new Date(year, month - 1, day);
  if (year >= 0 && year < 100) date.setFullYear(year);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    invalidScope(`${fieldName}不是有效日期`);
  }
  return normalized;
}

function localDateTimestamp(value, endOfDay = false) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
  if (year >= 0 && year < 100) date.setFullYear(year);
  return date.getTime() / 1000;
}

export function referencesFromText(text) {
  const pids = [];
  if (!text) return pids;
  const value = String(text);
  const leadingReference = value.match(LEADING_REFERENCE_PATTERN);
  if (leadingReference) pids.push(leadingReference[1]);
  for (const match of value.matchAll(REFERENCE_PATTERN)) pids.push(match[1]);
  return pids;
}

function normalizeScope(scope) {
  let bookmarkId = null;
  let pids = [];
  let startDate = null;
  let endDate = null;

  if (scope.type === 'group') {
    bookmarkId =
      scope.bookmarkId === undefined || scope.bookmarkId === null
        ? null
        : String(scope.bookmarkId).trim() || null;
    if (!bookmarkId) invalidScope('分组导出必须选择收藏分组');
  }
  if (scope.type === 'pids') {
    pids = Array.isArray(scope.pids) ? [...new Set(scope.pids.map(normalizePid))] : [];
    if (pids.length === 0) invalidScope('指定 PID 导出至少需要一个 PID');
  }
  if (scope.type === 'date') {
    startDate = normalizeDate(scope.startDate, '开始日期');
    endDate = normalizeDate(scope.endDate, '结束日期');
    if (!startDate && !endDate) invalidScope('日期导出至少需要填写开始日期或结束日期');
    if (startDate && endDate && startDate > endDate) {
      invalidScope('开始日期不能晚于结束日期');
    }
  }

  return { type: scope.type, bookmarkId, pids, startDate, endDate };
}

function normalizedOptions(options = {}) {
  options = options || {};
  const scope = options.scope || { type: 'all' };
  if (!['all', 'group', 'pids', 'date'].includes(scope.type)) {
    throw new AppError(ERROR_CODES.INVALID_INPUT, '未知导出范围');
  }
  return {
    scope: normalizeScope(scope),
    includeComments: options.includeComments !== false,
    includeReadable: options.includeReadable !== false,
    includeMedia: options.includeMedia !== false,
    referenceMode: ['none', 'body', 'all'].includes(options.referenceMode)
      ? options.referenceMode
      : 'none',
    confirmedLargeReferences: Boolean(options.confirmedLargeReferences),
  };
}

function filterByDate(holes, scope) {
  if (scope.type !== 'date') return holes;
  const start = scope.startDate ? localDateTimestamp(scope.startDate) : -Infinity;
  const end = scope.endDate ? localDateTimestamp(scope.endDate, true) : Infinity;
  return holes.filter((hole) => {
    const timestamp = Number(hole.timestamp);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}

export class ExportJob {
  constructor({
    api,
    store,
    accountFingerprint,
    now = () => new Date(),
    onProgress = () => {},
    confirmReferences = async (count) => count <= LIMITS.confirmReferencedPids,
    limits = LIMITS,
  }) {
    this.api = api;
    this.store = store;
    this.accountFingerprint = accountFingerprint;
    this.now = now;
    this.onProgress = onProgress;
    this.confirmReferences = confirmReferences;
    this.limits = limits;
    this.pauseRequested = false;
    this.controller = null;
    this.jobId = null;
  }

  requestPause() {
    this.pauseRequested = true;
  }

  cancel() {
    this.controller?.abort('cancelled');
  }

  emit(event) {
    this.onProgress(event);
  }

  async saveState(job, state, patch = {}) {
    Object.assign(job, patch, { state });
    await this.store.putJob(job);
    this.emit({ type: 'state', state, jobId: job.id, ...patch });
  }

  async planHoles(options, signal) {
    if (options.scope.type === 'pids') {
      const holes = [];
      const errors = [];
      for (const pid of options.scope.pids) {
        throwIfAborted(signal, 'plan_explicit_pids');
        try {
          const saved = this.existingItems.get(pid);
          holes.push(saved?.detailComplete ? saved.hole : await this.api.getHole(pid, signal));
        } catch (error) {
          if (
            isAppError(error, ERROR_CODES.UNAUTHORIZED) ||
            isAppError(error, ERROR_CODES.RATE_LIMITED) ||
            isAppError(error, ERROR_CODES.CANCELLED)
          ) {
            throw error;
          }
          errors.push(toErrorRecord(error, { pid, phase: 'hole' }));
        }
      }
      return { holes, complete: errors.length === 0, errors };
    }
    const result = await this.api.getAllFollowed({
      bookmarkId: options.scope.type === 'group' ? options.scope.bookmarkId : null,
      signal,
      onPage: (progress) => this.emit({ type: 'planning', ...progress }),
    });
    return {
      holes: filterByDate(result.items, options.scope),
      complete: result.complete,
      errors: result.complete
        ? []
        : [
            {
              code: ERROR_CODES.INVALID_RESPONSE,
              message:
                result.reason === 'followed_count_mismatch'
                  ? '关注列表实际数量与服务端总数不一致'
                  : '关注列表达到安全页数上限',
              phase: 'followed',
              retryable: true,
            },
          ],
    };
  }

  async processHole({ job, hole, source, options, signal, references }) {
    const pid = normalizePid(hole.pid);
    const previous = this.existingItems.get(pid);
    let detailComplete = previous?.detailComplete === true || source !== 'followed';
    const reuseContent = previous?.contentComplete === true && previous?.detailComplete === true;
    if (previous?.detailComplete === true) hole = previous.hole;
    let comments = previous?.comments || [];
    let contentComplete = detailComplete && (reuseContent || !options.includeComments);
    const errors = [];
    const snapshot = () => sanitizeForArchive({ pid, source, hole, comments,
      fetchStatus: 'partial', contentComplete, detailComplete });
    // Keep list text as a fallback, but only verified detail can complete an
    // item. Old checkpoints lack this evidence and must be checked once.
    let item = snapshot();
    await this.store.putItem(job.id, pid, item);
    if (!detailComplete) {
      try {
        hole = await this.api.getHole(pid, signal);
        detailComplete = true;
        contentComplete = !options.includeComments;
      } catch (error) {
        if ([ERROR_CODES.UNAUTHORIZED, ERROR_CODES.RATE_LIMITED, ERROR_CODES.CANCELLED,
          ERROR_CODES.STORAGE_ERROR].includes(error.code)) throw error;
        errors.push(toErrorRecord(error, { pid, phase: 'hole' }));
      }
      await this.store.putItem(job.id, pid, snapshot());
    }
    this.checkPause(signal);
    if (options.includeMedia) await this.mediaCapture.capture(hole, [], pid, signal);
    this.checkPause(signal);
    if (!reuseContent && options.includeComments) {
      try {
        const result = await this.api.getAllComments(pid, {
          signal,
          onPage: (progress) => this.emit({ type: 'comments', pid, ...progress }),
        });
        comments = result.items;
        const expectedComments = Number(hole.reply);
        const belowDetailCount = detailComplete && Number.isSafeInteger(expectedComments) &&
          expectedComments > comments.length;
        contentComplete = detailComplete && result.complete && !belowDetailCount;
        if (!result.complete || belowDetailCount) {
          errors.push({
            code: ERROR_CODES.INVALID_RESPONSE,
            message:
              belowDetailCount
                ? `#${pid} 实际保存 ${comments.length} 条评论，少于详情记录的 ${expectedComments} 条`
                : result.reason === 'comment_count_mismatch'
                ? `#${pid} 评论实际数量与服务端总数不一致`
                : `#${pid} 评论达到安全页数上限`,
            pid,
            phase: 'comments',
            retryable: true,
          });
        }
      } catch (caught) {
        if (
          isAppError(caught, ERROR_CODES.UNAUTHORIZED) ||
          isAppError(caught, ERROR_CODES.RATE_LIMITED) ||
          isAppError(caught, ERROR_CODES.CANCELLED) ||
          isAppError(caught, ERROR_CODES.STORAGE_ERROR)
        ) {
          throw caught;
        }
        contentComplete = false;
        errors.push(toErrorRecord(caught, { pid, phase: 'comments' }));
      }
    }

    item = snapshot();
    await this.store.putItem(job.id, pid, item);
    if (options.includeMedia) await this.mediaCapture.capture(null, comments, pid, signal);
    item.mediaComplete = !options.includeMedia || this.mediaCapture.complete(hole, comments);
    item.fetchStatus = contentComplete && item.mediaComplete ? 'ok' : 'partial';
    await this.store.putItem(job.id, pid, item);
    this.existingItems.set(pid, item);

    if (options.referenceMode !== 'none') {
      referencesFromText(hole.text).forEach((reference) => references.add(reference));
      if (options.referenceMode === 'all') {
        comments.forEach((comment) =>
          referencesFromText(comment.text).forEach((reference) => references.add(reference)),
        );
      }
    }
    return errors;
  }

  checkPause(signal) {
    throwIfAborted(signal, 'export');
    if (this.pauseRequested) throw new AppError(ERROR_CODES.PAUSED, '任务已暂停');
  }

  async run(rawOptions = null, { jobId = null, signal: externalSignal } = {}) {
    this.pauseRequested = false;
    let job = jobId ? await this.store.getJob(jobId) : null;
    if (jobId && !job) {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '找不到要恢复的导出任务');
    }
    if (job && job.type !== 'export') {
      throw new AppError(ERROR_CODES.INVALID_INPUT, '任务类型不是导出任务');
    }
    // Old checkpoints describe text-only exports. Preserve their scope.
    const options = normalizedOptions(job ? { ...job.options, includeMedia: job.options?.includeMedia === true } : rawOptions);
    if (job && job.accountFingerprint !== this.accountFingerprint) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, '该断点属于另一个账号，不能恢复');
    }
    if (!job) {
      const createdAt = this.now().toISOString();
      job = {
        id: createRunId(this.now()),
        type: 'export',
        state: JOB_STATES.PLANNING,
        createdAt: Date.parse(createdAt),
        accountFingerprint: this.accountFingerprint,
        options,
        errors: [],
        total: 0,
        completed: 0,
      };
      await this.store.putJob(job);
    } else {
      job.options = options;
      job.errors = [];
    }
    this.jobId = job.id;
    this.controller = new AbortController();
    const onExternalAbort = () => this.controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const signal = this.controller.signal;
    if (externalSignal?.aborted) this.controller.abort(externalSignal.reason);
    this.api.scheduler?.resetRateLimitCount?.();

    try {
      await this.saveState(job, JOB_STATES.PLANNING);
      const existingItems = await this.store.getItems(job.id);
      this.existingItems = new Map(existingItems.map((item) => [item.pid, item]));
      const plan = await this.planHoles(options, signal);
      const basePids = new Set(plan.holes.map((hole) => String(hole.pid)));
      if (options.includeMedia) {
        this.mediaCapture = new MediaCapture({ api: this.api, store: this.store, jobId: job.id,
          limits: this.limits, onProgress: (event) => this.emit(event), checkPause: () => this.checkPause(signal) });
        await this.mediaCapture.initialize();
      }
      const completedPids = new Set(
        existingItems.filter((item) => item.fetchStatus === 'ok' && item.detailComplete === true)
          .map((item) => item.pid),
      );
      const errors = [...plan.errors];
      job.total = plan.holes.length;
      job.completed = completedPids.size;
      await this.saveState(job, JOB_STATES.RUNNING, {
        total: job.total,
        completed: job.completed,
      });

      const references = new Set();
      if (options.referenceMode !== 'none') {
        for (const item of existingItems) {
          if (item.detailComplete !== true) continue;
          referencesFromText(item.hole?.text).forEach((reference) => references.add(reference));
          if (options.referenceMode === 'all') {
            item.comments?.forEach((comment) =>
              referencesFromText(comment.text).forEach((reference) => references.add(reference)),
            );
          }
        }
      }
      for (const hole of plan.holes) {
        throwIfAborted(signal, 'export');
        if (this.pauseRequested) {
          await this.saveState(job, JOB_STATES.PAUSED, { errors });
          return { job, paused: true };
        }
        const pid = normalizePid(hole.pid);
        if (!completedPids.has(pid) || options.includeMedia) {
          const itemErrors = await this.processHole({
            job,
            hole,
            source: options.scope.type === 'pids' ? 'explicit' : 'followed',
            options,
            signal,
            references,
          });
          errors.push(...itemErrors);
          completedPids.add(pid);
          job.completed = completedPids.size;
          await this.store.putJob({ ...job, completed: job.completed, errors });
          this.emit({ ...job, type: 'progress', phase: 'followed', pid });
        }
      }

      for (const pid of basePids) references.delete(pid);
      if (references.size > LIMITS.maxReferencedPids) {
        errors.push({
          code: ERROR_CODES.INVALID_INPUT,
          message: `引用洞数量 ${references.size} 超过安全上限 ${LIMITS.maxReferencedPids}`,
          phase: 'references',
          retryable: false,
        });
      }
      const referencePids = [...references].slice(0, LIMITS.maxReferencedPids);
      if (
        referencePids.length > LIMITS.confirmReferencedPids &&
        !options.confirmedLargeReferences
      ) {
        const confirmed = await this.confirmReferences(referencePids.length);
        if (!confirmed) referencePids.length = 0;
      }
      job.total += referencePids.length;
      await this.store.putJob(job);

      for (const pid of referencePids) {
        throwIfAborted(signal, 'export_references');
        if (this.pauseRequested) {
          await this.saveState(job, JOB_STATES.PAUSED, { errors });
          return { job, paused: true };
        }
        if (completedPids.has(pid) && !options.includeMedia) continue;
        try {
          const hole = this.existingItems.get(pid)?.detailComplete
            ? this.existingItems.get(pid).hole : await this.api.getHole(pid, signal);
          const itemErrors = await this.processHole({
            job,
            hole,
            source: 'referenced',
            options,
            signal,
            references: new Set(),
          });
          errors.push(...itemErrors);
          completedPids.add(pid);
        } catch (error) {
          if (
            isAppError(error, ERROR_CODES.UNAUTHORIZED) ||
            isAppError(error, ERROR_CODES.RATE_LIMITED) ||
            isAppError(error, ERROR_CODES.CANCELLED) ||
            isAppError(error, ERROR_CODES.PAUSED) ||
            isAppError(error, ERROR_CODES.STORAGE_ERROR)
          ) {
            throw error;
          }
          errors.push(toErrorRecord(error, { pid, phase: 'referenced' }));
        }
        job.completed = completedPids.size;
        await this.store.putJob({ ...job, completed: job.completed, errors });
        this.emit({ ...job, type: 'progress', phase: 'referenced', pid });
      }

      const items = await this.store.getItems(job.id);
      const media = options.includeMedia ? await prepareExportMedia(this.store, job.id, items) : null;
      if (media) errors.push(...media.errors);
      const complete = plan.complete && errors.length === 0 && items.every((item) => item.fetchStatus === 'ok');
      let manifest = createManifest({
        runId: job.id,
        scope: options,
        complete,
        items,
        errors,
        expectedHoles: job.total,
        exportedAt: this.now().toISOString(),
      });
      const archive = createArchive({
        manifest,
        items,
        includeReadable: options.includeReadable,
        media,
      });
      manifest = archive.manifest;
      await this.saveState(job, manifest.complete ? JOB_STATES.COMPLETED : JOB_STATES.PARTIAL, {
        completed: items.length,
        errors: manifest.errors,
        manifest,
      });
      return { job, manifest, archive, paused: false };
    } catch (error) {
      if (isAppError(error, ERROR_CODES.PAUSED)) {
        await this.saveState(job, JOB_STATES.PAUSED);
        return { job, paused: true };
      }
      let state = JOB_STATES.FAILED;
      if (isAppError(error, ERROR_CODES.CANCELLED)) state = JOB_STATES.CANCELLED;
      else if ([ERROR_CODES.RATE_LIMITED, ERROR_CODES.STORAGE_ERROR, ERROR_CODES.UNAUTHORIZED].includes(error.code)) state = JOB_STATES.PAUSED;
      await this.saveState(job, state, {
        errors: [...(job.errors || []), toErrorRecord(error, { phase: 'job' })],
      });
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.controller = null;
    }
  }
}
