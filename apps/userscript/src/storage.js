import { JOB_DB_NAME, JOB_DB_VERSION, JOB_RETENTION_MS } from './config.js';
import { AppError, ERROR_CODES } from './errors.js';

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
      };
      request.onsuccess = () => resolve(request.result);
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
    const database = await this.open();
    const transaction = database.transaction('items', 'readwrite');
    transaction.objectStore('items').put({
      key: `${jobId}:${pid}`,
      jobId,
      pid: String(pid),
      item: cloneValue(item),
    });
    await transactionPromise(transaction);
  }

  async getItems(jobId) {
    const database = await this.open();
    const transaction = database.transaction('items', 'readonly');
    const index = transaction.objectStore('items').index('jobId');
    const records = await requestPromise(index.getAll(IDBKeyRange.only(jobId)));
    return records.map((record) => record.item);
  }

  async deleteJob(jobId) {
    const database = await this.open();
    const transaction = database.transaction(['jobs', 'items'], 'readwrite');
    transaction.objectStore('jobs').delete(jobId);
    const index = transaction.objectStore('items').index('jobId');
    const request = index.openKeyCursor(IDBKeyRange.only(jobId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore('items').delete(cursor.primaryKey);
      cursor.continue();
    };
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

  async deleteJob(jobId) {
    this.jobs.delete(jobId);
    for (const key of this.items.keys()) {
      if (key.startsWith(`${jobId}:`)) this.items.delete(key);
    }
  }

  async cleanup() {
    const cutoff = this.now() - JOB_RETENTION_MS;
    for (const job of await this.listJobs()) {
      if ((job.updatedAt || job.createdAt || 0) < cutoff) await this.deleteJob(job.id);
    }
  }
}
