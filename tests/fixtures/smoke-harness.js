const ALLOWED_SCENARIOS = new Set(['default', 'paired', 'running', 'import-preview']);
const searchParameters = new URLSearchParams(location.search);
const requestedScenario = searchParameters.get('scenario') || 'default';
const scenario = ALLOWED_SCENARIOS.has(requestedScenario) ? requestedScenario : 'default';
const useGeneratedBundle = searchParameters.get('bundle') === '1';
const fixtureUUID = 'fixture-account-uuid';
const bridgeStateKey = 'pkuhole-studio-bridge-v2';
const requests = [];

const scenarios = {
  default: {
    description: '核心路径：面板默认只突出本地归档，Studio、任务状态和最近归档保持收起或隐藏。',
    checks: [
      '默认打开“备份到本机”，迁移关注页不显示。',
      '本地下载为默认目标；Studio 位于闭合的高级区域。',
      '空闲时不显示任务卡和最近归档结果。',
    ],
  },
  paired: {
    description: '高级路径：从 mock 私有存储恢复一个已关联 Studio；夹具会展开高级区域方便检查。',
    checks: [
      '核心导出控件与 Studio 状态相互独立。',
      '高级区域显示已关联状态，但没有自动发送归档。',
      '页面打开不会产生 Studio HTTP 请求。',
    ],
  },
  running: {
    description: '恢复路径：IndexedDB 中预置一个运行时中断的导出；打开面板后应作为单一可恢复任务出现。',
    checks: [
      '任务卡只在发现断点后出现。',
      '任务以暂停/可继续状态呈现，不自动重新执行。',
      '关闭再打开面板不会生成第二个恢复任务。',
    ],
  },
  'import-preview': {
    description: '迁移路径：自动载入一个含两个 PID 的旧版 JSON，并用 mock 关注列表完成只读预检。',
    checks: [
      '导入页按“选文件 → 预检 → 写入”表达层级。',
      '预检应显示 1 个将新增、1 个已关注。',
      '任何真实关注确认都会被夹具取消，POST 也会被 mock 拒绝。',
    ],
  },
};

function renderGuide() {
  document.querySelector(`[data-fixture-scenario="${scenario}"]`)?.setAttribute('aria-current', 'page');
  document.querySelector('#fixture-description').textContent = scenarios[scenario].description;
  const checks = document.querySelector('#fixture-checks');
  for (const text of scenarios[scenario].checks) {
    const item = document.createElement('li');
    item.textContent = text;
    checks.append(item);
  }
}

function recordRequest(kind, method, url) {
  requests.push({ kind, method, url });
  document.querySelector('#fixture-log').textContent = requests
    .map((request) => `${request.kind} ${request.method} ${request.url}`)
    .join('\n');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installMocks() {
  document.cookie = 'pku_token=fixture-token; SameSite=Lax';
  localStorage.setItem('pku-uuid', fixtureUUID);
  localStorage.removeItem('pkuhole-export-delivery-v1');

  const gmValues = new Map();
  if (scenario === 'paired') {
    gmValues.set(bridgeStateKey, {
      version: 2,
      status: 'paired',
      port: 8080,
      name: 'Fixture Studio',
      deviceId: 'fixture-device',
      instanceId: 'fixture-instance',
      pairedAt: new Date().toISOString(),
      privateKeyPKCS8: 'fixture-private-key',
      publicKeySPKI: 'fixture-public-key',
    });
  }

  globalThis.GM_getValue = async (key, fallback) => gmValues.get(key) ?? fallback;
  globalThis.GM_setValue = async (key, value) => gmValues.set(key, value);
  globalThis.GM_deleteValue = async (key) => gmValues.delete(key);
  globalThis.GM_xmlhttpRequest = (options) => {
    recordRequest('studio', options.method || 'GET', options.url);
    queueMicrotask(() => options.onerror?.({ status: 0, statusText: 'blocked by smoke fixture' }));
    return { abort() {} };
  };

  globalThis.confirm = () => false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    recordRequest('treehole', method, `${url.pathname}${url.search}`);
    if (method !== 'GET') {
      return jsonResponse({ code: 40900, message: 'write blocked by smoke fixture' }, 409);
    }
    if (url.pathname === '/api/bookmark') {
      return jsonResponse({ code: 20000, data: [{ id: 1, bookmark_name: 'Fixture 小分组' }] });
    }
    if (url.pathname === '/api/follow_v2') {
      return jsonResponse({
        code: 20000,
        data: {
          data: [{ pid: 123456, text: 'fixture followed hole', reply: 0, is_follow: true }],
          current_page: 1,
          last_page: 1,
          total: 1,
          next_page_url: null,
        },
      });
    }
    if (/^\/api\/pku\/\d+\/$/.test(url.pathname)) {
      const pid = Number(url.pathname.match(/\d+/)?.[0]);
      return jsonResponse({
        code: 20000,
        data: { pid, text: 'fixture explicit hole', reply: 0, is_follow: pid === 123456 },
      });
    }
    if (/^\/api\/pku_comment_v3\/\d+$/.test(url.pathname)) {
      return jsonResponse({
        code: 20000,
        data: { data: [], current_page: 1, last_page: 1, total: 0, next_page_url: null },
      });
    }
    return jsonResponse({ code: 40400, message: 'fixture route not found' }, 404);
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function resetFixtureDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('pku-hole-tool');
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = resolve;
  });
}

async function accountFingerprint() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fixtureUUID));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedRunningJob() {
  const open = indexedDB.open('pku-hole-tool', 1);
  open.onupgradeneeded = () => {
    const database = open.result;
    if (!database.objectStoreNames.contains('jobs')) {
      database.createObjectStore('jobs', { keyPath: 'id' });
    }
    if (!database.objectStoreNames.contains('items')) {
      const items = database.createObjectStore('items', { keyPath: 'key' });
      items.createIndex('jobId', 'jobId', { unique: false });
    }
  };
  const database = await requestResult(open);
  const transaction = database.transaction('jobs', 'readwrite');
  transaction.objectStore('jobs').put({
    id: 'fixture-running-export',
    type: 'export',
    state: 'running',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 30_000,
    accountFingerprint: await accountFingerprint(),
    options: {
      scope: { type: 'pids', pids: ['123456'] },
      includeComments: false,
      includeReadable: true,
      referenceMode: 'none',
    },
    errors: [],
    completed: 0,
    total: 1,
  });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

function waitForEntry() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const check = () => {
      const entry = document.querySelector('#pku-hole-toolkit-entry');
      if (entry) resolve(entry);
      else if (Date.now() >= deadline) reject(new Error('Toolkit entry did not mount'));
      else requestAnimationFrame(check);
    };
    check();
  });
}

function toolkitShadow() {
  return document.querySelector('#pku-hole-toolkit-host')?.shadowRoot || null;
}

async function waitForCondition(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`场景未就绪：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function markScenarioReady() {
  const result = document.querySelector('#fixture-result');
  result.dataset.fixtureReady = scenario;
  result.textContent = `场景已就绪：${scenario}`;
}

async function showScenario() {
  const entry = await waitForEntry();
  entry.click();
  const shadow = toolkitShadow();
  if (scenario === 'paired') {
    await waitForCondition(
      () => shadow.querySelector('[data-studio-options]')?.hidden === false,
      '已关联 Studio 状态',
    );
    const studio = shadow.querySelector('[data-studio-section]');
    if (studio) studio.open = true;
  }
  if (scenario === 'running') {
    await waitForCondition(
      () => shadow.querySelector('[data-task-card]')?.hidden === false,
      '可恢复任务卡',
    );
  }
  if (scenario === 'import-preview') {
    shadow.querySelector('[data-tab="import"]')?.click();
    const archive = {
      holes: [
        { pid: 123456, text: 'fixture existing follow' },
        { pid: 234567, text: 'fixture new follow' },
      ],
      comments: [[], []],
    };
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([JSON.stringify(archive)], 'fixture-import.json', { type: 'application/json' }),
    );
    const input = shadow.querySelector('#archive-files');
    input.files = transfer.files;
    shadow.querySelector('[data-action="preview-import"]')?.click();
    await waitForCondition(
      () => shadow.querySelector('[data-import-preview]')?.hidden === false,
      '导入预检摘要',
    );
  }
  if (scenario === 'default') {
    const defaultReady =
      shadow.querySelector('[data-panel="export"]')?.hidden === false &&
      shadow.querySelector('[data-panel="import"]')?.hidden === true &&
      shadow.querySelector('[data-task-card]')?.hidden === true &&
      shadow.querySelector('[data-recent-export]')?.hidden === true &&
      shadow.querySelector('[data-studio-section]')?.open === false &&
      shadow.querySelector('#delivery-download')?.checked === true;
    if (!defaultReady) throw new Error('默认独立使用界面的渐进披露状态不正确');
  }
  markScenarioReady();
}

async function loadToolkit() {
  if (location.protocol === 'file:') {
    throw new Error('请从仓库根目录启动本地 HTTP 服务后打开此夹具，file:// 无法提供测试凭据存储。');
  }
  installMocks();
  await resetFixtureDatabase();
  if (scenario === 'running') await seedRunningJob();
  const script = document.createElement('script');
  script.type = useGeneratedBundle ? 'text/javascript' : 'module';
  script.src = useGeneratedBundle
    ? '../../PKU-Hole%20export%20tool.user.js'
    : '../../apps/userscript/src/main.js';
  await new Promise((resolve, reject) => {
    script.onload = () => showScenario().then(resolve, reject);
    script.onerror = () => reject(new Error('无法加载 Toolkit 源码或生成脚本，请检查本地服务。'));
    document.body.append(script);
  });
}

function showFixtureError(error) {
  const description = document.querySelector('#fixture-description');
  description.textContent = error.message;
  description.style.color = '#b3261e';
  const result = document.querySelector('#fixture-result');
  result.dataset.fixtureError = 'true';
  result.textContent = '场景加载失败';
}

renderGuide();
globalThis.__toolkitSmoke = { scenario, requests, toolkitShadow, useGeneratedBundle };
try {
  await loadToolkit();
} catch (error) {
  showFixtureError(error);
}
