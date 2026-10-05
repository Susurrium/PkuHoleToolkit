import { JOB_DB_NAME, JOB_DB_VERSION, JOB_RETENTION_MS } from './config.js';
import { AppError, ERROR_CODES } from './errors.js';
import { mediaTargetKey } from './media.js';

function cloneValue(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
  });
}

export class JobStore {
  constructor({ indexedDBObject = globalThis.indexedDB, now = Date.now } = {}) {
    if (!indexedDBObject) throw new AppError(ERROR_CODES.STORAGE_ERROR, '浏览器不支持 IndexedDB');
    this.indexedDBObject = indexedDBObject;
    this.now = now;
    this.databasePromise = null;
  }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDBObject.open(JOB_DB_NAME, JOB_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('jobs')) {
          database.createObjectStore('jobs', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('items')) {
          const store = database.createObjectStore('items', { keyPath: 'key' });
          store.createIndex('jobId', 'jobId', { unique: false });
        }
        for (const name of ['media', 'mediaFiles']) {
          if (!database.objectStoreNames.contains(name)) {
            const store = database.createObjectStore(name, { keyPath: 'key' });
            store.createIndex('jobId', 'jobId', { unique: false });
          }
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.databasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
    return this.databasePromise;
  }

  async putJob(job) {
    try {
      const database = await this.open();
      const transaction = database.transaction('jobs', 'readwrite');
      transaction.objectStore('jobs').put(cloneValue({ ...job, updatedAt: this.now() }));
      await transactionPromise(transaction);
      return job;
    } catch (error) {
      throw new AppError(ERROR_CODES.STORAGE_ERROR, '无法保存任务进度', { cause: error });
    }
  }

  async getJob(id) {
    const database = await this.open();
    const transaction = database.transaction('jobs', 'readonly');
    return requestPromise(transaction.objectStore('jobs').get(id));
  }

  async listJobs() {
    const database = await this.open();
    const transaction = database.transaction('jobs', 'readonly');
    return requestPromise(transaction.objectStore('jobs').getAll());
  }

  async putItem(jobId, pid, item) {
    try {
      const database = await this.open();
      const transaction = database.transaction('items', 'readwrite');
      transaction.objectStore('items').put({
        key: `${jobId}:${pid}`,
        jobId,
        pid: String(pid),
        item: cloneValue(item),
      });
      await transactionPromise(transaction);
    } catch (error) {
      throw new AppError(ERROR_CODES.STORAGE_ERROR, '无法保存正文或评论进度，浏览器存储可能已满', { cause: error });
    }
  }

  async getItems(jobId) {
    const database = await this.open();
    const transaction = database.transaction('items', 'readonly');
    const index = transaction.objectStore('items').index('jobId');
    const records = await requestPromise(index.getAll(IDBKeyRange.only(jobId)));
    return records.map((record) => record.item);
  }

  async putMedia(jobId, record, bytes = null) {
    try {
      const database = await this.open();
      const transaction = database.transaction(['media', 'mediaFiles'], 'readwrite');
      transaction.objectStore('media').put({ key: `${jobId}:${mediaTargetKey(record)}`, jobId, record: cloneValue(record) });
      if (bytes) transaction.objectStore('mediaFiles').put({ key: `${jobId}:${record.sha256}`, jobId, bytes });
      await transactionPromise(transaction);
    } catch (error) {
      throw new AppError(ERROR_CODES.STORAGE_ERROR, '无法保存图片，浏览器存储可能已满；已保存的断点仍可恢复', { cause: error });
    }
  }

  async getMedia(jobId) {
    const database = await this.open();
    const transaction = database.transaction('media', 'readonly');
    const records = await requestPromise(transaction.objectStore('media').index('jobId').getAll(IDBKeyRange.only(jobId)));
    return records.map((record) => record.record);
  }

  async getMediaFile(jobId, sha256) {
    const database = await this.open();
    const transaction = database.transaction('mediaFiles', 'readonly');
    const record = await requestPromise(transaction.objectStore('mediaFiles').get(`${jobId}:${sha256}`));
    return record?.bytes || null;
  }

  async deleteJob(jobId) {
    const database = await this.open();
    const transaction = database.transaction(['jobs', 'items', 'media', 'mediaFiles'], 'readwrite');
    transaction.objectStore('jobs').delete(jobId);
    for (const name of ['items', 'media', 'mediaFiles']) {
      const request = transaction.objectStore(name).index('jobId').openKeyCursor(IDBKeyRange.only(jobId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        transaction.objectStore(name).delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    await transactionPromise(transaction);
  }

  async cleanup() {
    const jobs = await this.listJobs();
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const job of jobs) {
      if ((job.updatedAt || job.createdAt || 0) < cutoff) await this.deleteJob(job.id);
    }
  }
}

export class MemoryJobStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.jobs = new Map();
    this.items = new Map();
    this.media = new Map();
    this.mediaFiles = new Map();
  }

  async putJob(job) {
    this.jobs.set(job.id, cloneValue({ ...job, updatedAt: this.now() }));
    return job;
  }

  async getJob(id) {
    return cloneValue(this.jobs.get(id));
  }

  async listJobs() {
    return [...this.jobs.values()].map(cloneValue);
  }

  async putItem(jobId, pid, item) {
    this.items.set(`${jobId}:${pid}`, cloneValue(item));
  }

  async getItems(jobId) {
    return [...this.items.entries()]
      .filter(([key]) => key.startsWith(`${jobId}:`))
      .map(([, item]) => cloneValue(item));
  }

  async putMedia(jobId, record, bytes = null) {
    this.media.set(`${jobId}:${mediaTargetKey(record)}`, { jobId, record: cloneValue(record) });
    if (bytes) this.mediaFiles.set(`${jobId}:${record.sha256}`, { jobId, bytes: bytes.slice() });
  }

  async getMedia(jobId) {
    return [...this.media.values()].filter((value) => value.jobId === jobId).map((value) => cloneValue(value.record));
  }

  async getMediaFile(jobId, sha256) {
    return this.mediaFiles.get(`${jobId}:${sha256}`)?.bytes.slice() || null;
  }

  async deleteJob(jobId) {
    this.jobs.delete(jobId);
    for (const key of this.items.keys()) {
      if (key.startsWith(`${jobId}:`)) this.items.delete(key);
    }
    for (const records of [this.media, this.mediaFiles]) {
      for (const [key, value] of records) if (value.jobId === jobId) records.delete(key);
    }
  }

  async cleanup() {
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const job of await this.listJobs()) {
      if ((job.updatedAt || job.createdAt || 0) < cutoff) await this.deleteJob(job.id);
    }
  }
}
