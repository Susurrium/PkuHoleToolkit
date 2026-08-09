import { ExportJob } from './export-job.js';
import { ImportJob, buildImportAuditText } from './import-job.js';
import { AppError, ERROR_CODES, toErrorRecord } from './errors.js';
import {
  createStudioBridgeStorage,
  forgetStudioDevice,
  requestStudioDevicePairing,
  restoreLatestExportArchive,
  sendArchiveToStudio,
  sendArchiveToTrustedStudio,
  waitForStudioDevicePairing,
} from './studio-bridge.js';

const ENTRY_ID = 'pku-hole-toolkit-entry';
const HOST_ID = 'pku-hole-toolkit-host';
const DELIVERY_PREFERENCE_KEY = 'pkuhole-export-delivery-v1';

export function normalizeArchiveDestinations(value) {
  if (!value || typeof value !== 'object') return { download: true, studio: false };
  return {
    download: value.download === true,
    studio: value.studio === true,
  };
}

export function readArchiveDestinations(storage) {
  try {
    const encoded = storage?.getItem?.(DELIVERY_PREFERENCE_KEY);
    return encoded ? normalizeArchiveDestinations(JSON.parse(encoded)) : normalizeArchiveDestinations();
  } catch {
    return normalizeArchiveDestinations();
  }
}

export function writeArchiveDestinations(storage, value) {
  const destinations = normalizeArchiveDestinations(value);
  try {
    storage?.setItem?.(DELIVERY_PREFERENCE_KEY, JSON.stringify(destinations));
  } catch {
    // Exporting must remain available when browser storage is blocked or full.
  }
  return destinations;
}

export async function deliverArchiveToDestinations({
  archive,
  destinations,
  studioConnected = false,
  downloadArchive = () => {},
  sendArchiveToStudio = async () => null,
}) {
  const selected = normalizeArchiveDestinations(destinations);
  const delivery = {
    download: selected.download ? 'ready' : 'not_selected',
    studio: selected.studio ? 'ready' : 'not_selected',
    studioResult: null,
    downloadError: null,
    studioError: null,
  };
  if (selected.download) {
    try {
      await downloadArchive(archive);
      delivery.download = 'started';
    } catch (error) {
      delivery.download = 'failed';
      delivery.downloadError = error;
    }
  }
  if (!selected.studio) return delivery;
  if (!studioConnected) {
    delivery.studio = 'not_connected';
    delivery.studioError = new AppError(
      ERROR_CODES.UNAUTHORIZED,
      '归档已经生成，但 Studio 尚未关联；可以先下载，或关联后发送最近归档',
    );
    return delivery;
  }
  try {
    delivery.studioResult = await sendArchiveToStudio(archive);
    delivery.studio = 'awaiting_confirmation';
  } catch (error) {
    delivery.studio = 'failed';
    delivery.studioError = error;
  }
  return delivery;
}

export function ensureEntryBeforeAnchor(entry, anchor) {
  if (!entry || !anchor?.parentNode) return false;
  if (entry.parentNode === anchor.parentNode && entry.nextSibling === anchor) return false;
  anchor.parentNode.insertBefore(entry, anchor);
  return true;
}

export function selectLatestResumableJob(jobs, accountFingerprint) {
  return [...(jobs || [])]
    .filter(
      (job) =>
        job.accountFingerprint === accountFingerprint &&
        ['planning', 'running', 'paused', 'partial'].includes(job.state),
    )
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0] || null;
}

export function createResumableJobDiscovery({ isBusy, discover }) {
  let inFlight = null;
  return function discoverOnce() {
    if (isBusy()) return Promise.resolve(null);
    if (!inFlight) {
      const pending = Promise.resolve()
        .then(() => (isBusy() ? null : discover()))
        .finally(() => {
          if (inFlight === pending) inFlight = null;
        });
      inFlight = pending;
    }
    return inFlight;
  };
}

export function reconcileAccountScopedState(state, accountFingerprint) {
  const accountChanged = Boolean(
    state.accountFingerprint &&
    accountFingerprint &&
    state.accountFingerprint !== accountFingerprint,
  );
  return {
    ...state,
    accountFingerprint,
    accountChanged,
    ...(accountChanged
      ? {
          lastArchive: null,
          lastExportOptions: null,
          activeJobId: null,
          activeKind: null,
          importPreview: null,
        }
      : {}),
  };
}

export function apiForAccount(api, accountFingerprint) {
  return typeof api?.forAccount === 'function' ? api.forAccount(accountFingerprint) : api;
}

export async function abortAndWaitForPairingWatch(watch) {
  if (!watch) return;
  watch.controller.abort();
  await watch.promise;
}

export function taskStatusText(state, kind = 'export') {
  const labels = {
    planning: '正在读取备份范围',
    running: kind === 'import' ? '正在新增关注' : '正在生成备份',
    previewing: '正在检查备份',
    previewed: '检查完成',
    paused: '任务已暂停',
    partial: '部分完成',
    completed: kind === 'import' ? '迁移完成' : '备份完成',
    failed: '任务未完成',
    cancelled: '任务已取消',
  };
  return labels[state] || '正在处理';
}

export function exportSummaryText(options = {}) {
  const scopeLabels = {
    all: '全部关注',
    group: '收藏分组',
    pids: '指定帖子',
    date: '按帖子发布日期',
  };
  const parts = [scopeLabels[options.scope?.type] || '全部关注'];
  parts.push(options.includeComments === false ? '不含评论' : '包含评论');
  if (options.referenceMode === 'body') parts.push('补全正文引用');
  else if (options.referenceMode === 'all') parts.push('补全正文和评论引用');
  else parts.push('不补全引用');
  if (options.includeReadable !== false) parts.push('附带阅读版');
  return parts.join(' · ');
}

const PANEL_STYLES = `
  :host { all: initial; color-scheme: light dark; }
  * { box-sizing: border-box; }
  .overlay { position: fixed; inset: 0; z-index: 2147483646; display: none; place-items: center; padding: 20px; background: rgba(15,23,42,.56); font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; }
  .overlay.open { display: grid; }
  .panel { width: min(680px, 100%); max-height: min(840px, calc(100vh - 40px)); overflow: auto; border: 1px solid rgba(148,163,184,.28); border-radius: 18px; background: #fff; box-shadow: 0 28px 90px rgba(15,23,42,.34); }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px 24px 18px; }
  h2 { margin: 0; font-size: 21px; letter-spacing: -.01em; }
  h3 { margin: 0 0 10px; font-size: 16px; }
  p { line-height: 1.6; }
  .subtitle { margin: 6px 0 0; color: #596579; font-size: 13px; }
  .close { min-width: 36px; border: 0; background: transparent; font-size: 26px; line-height: 1; cursor: pointer; color: inherit; }
  .tabs { display: flex; gap: 6px; margin: 0 24px; padding: 4px; border-radius: 11px; background: #f1f5f9; }
  .tabs button { flex: 1; border-color: transparent; background: transparent; color: #526176; font-weight: 650; }
  .tabs button[aria-selected="true"] { border-color: #cbdcf8; background: #fff; color: #1458b3; box-shadow: 0 1px 4px rgba(15,23,42,.1); }
  main { padding: 20px 24px 26px; }
  section[hidden], .conditional[hidden], [hidden] { display: none !important; }
  .intro { margin: 0 0 18px; padding: 12px 14px; border: 1px solid #dbeafe; border-radius: 10px; background: #f5f9ff; color: #41536b; font-size: 13px; }
  .section-title { margin: 20px 0 10px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  .field { display: grid; gap: 6px; }
  .field.full { grid-column: 1 / -1; }
  label, legend { font-size: 14px; font-weight: 600; }
  input, select, textarea, button { font: inherit; }
  input, select, textarea { width: 100%; border: 1px solid #b7c0ce; border-radius: 9px; padding: 10px 11px; background: #fff; color: #172033; }
  textarea { min-height: 80px; resize: vertical; }
  .checks { display: flex; flex-wrap: wrap; gap: 12px 20px; margin: 14px 0; }
  .checks label { display: flex; align-items: center; gap: 7px; font-weight: 500; }
  .checks input { width: auto; }
  fieldset { min-width: 0; margin: 14px 0 0; padding: 14px; border: 1px solid #d7dbe1; border-radius: 10px; }
  fieldset legend { padding: 0 6px; }
  .hint { margin: 8px 0 0; font-size: 12px; line-height: 1.6; color: #68707c; }
  button { border: 1px solid #aeb8c6; border-radius: 9px; padding: 9px 14px; background: #f8fafc; color: #172033; cursor: pointer; }
  button:hover:not(:disabled) { border-color: #7b8aa0; background: #f1f5f9; }
  button.primary { min-height: 42px; border-color: #1768d5; background: #1768d5; color: #fff; font-weight: 700; }
  button.primary:hover:not(:disabled) { border-color: #0f56b5; background: #0f56b5; }
  button.danger { border-color: #c5221f; color: #c5221f; }
  button.quiet { border-color: transparent; background: transparent; color: #53647b; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 3px solid rgba(26,115,232,.35); outline-offset: 2px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .primary-actions .primary { flex: 1; }
  .summary-line { margin: 12px 0 0; color: #526176; font-size: 13px; }
  details.disclosure { margin-top: 14px; border: 1px solid #d9e0e9; border-radius: 10px; background: #fbfcfe; }
  details.disclosure > summary { cursor: pointer; list-style-position: inside; padding: 12px 14px; font-size: 14px; font-weight: 650; }
  details.disclosure[open] > summary { border-bottom: 1px solid #e2e7ee; }
  .disclosure-body { padding: 2px 14px 14px; }
  .status-card { margin: 0 0 18px; padding: 14px; border-radius: 11px; background: #f4f8fe; border: 1px solid #d7e4f5; }
  .status-card.warning { background: #fff9eb; border-color: #f3d58b; }
  .status-line { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
  progress { width: 100%; height: 12px; margin: 10px 0; }
  .message { margin: 8px 0 0; white-space: pre-wrap; font-size: 14px; }
  .message.error { color: #b3261e; }
  .result-card { margin-top: 18px; padding: 16px; border: 1px solid #cce7d7; border-radius: 11px; background: #f3fbf6; }
  .result-card h3 { color: #17663b; }
  .result-card .message { color: #405247; }
  .filename { overflow-wrap: anywhere; color: #68707c; font-size: 12px; }
  .preview { margin-top: 16px; padding: 16px; border: 1px solid #d7dbe1; border-radius: 10px; font-size: 14px; }
  .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 12px 0; }
  .metric { padding: 12px; border-radius: 9px; background: #f4f7fb; }
  .metric strong { display: block; margin-bottom: 4px; color: #155bb7; font-size: 24px; }
  .metric span { color: #5d6979; font-size: 12px; }
  .studio-section { margin-top: 22px !important; }
  .studio-summary { display: inline-flex; align-items: center; justify-content: space-between; width: calc(100% - 22px); gap: 10px; }
  .badge { flex: 0 0 auto; padding: 2px 8px; border-radius: 999px; background: #e8edf3; color: #5d6979; font-size: 11px; font-weight: 650; white-space: nowrap; }
  .badge.connected { background: #dff5e8; color: #17663b; }
  .studio-options { margin: 12px 0 0; padding: 11px 12px; border-radius: 9px; background: #eef7ff; }
  .studio-options label { display: flex; align-items: center; gap: 8px; font-weight: 500; }
  .studio-options input { width: auto; }
  .nested { margin-top: 14px; }
  .nested summary { cursor: pointer; color: #53647b; font-size: 13px; }
  .step-label { margin: 18px 0 8px; color: #526176; font-size: 12px; font-weight: 750; letter-spacing: .04em; text-transform: uppercase; }
  @media (max-width: 600px) {
    .overlay { align-items: stretch; padding: 0; }
    .panel { width: 100%; max-height: 100vh; border: 0; border-radius: 0; }
    header { padding: 18px 16px 14px; }
    .tabs { margin-inline: 16px; }
    main { padding: 18px 16px 22px; }
    .grid, .metrics { grid-template-columns: 1fr; }
    .field.full { grid-column: auto; }
    .actions { flex-direction: column; }
    .actions button { width: 100%; }
  }
  @media (prefers-color-scheme: dark) {
    .overlay { color: #e8eaed; }
    .panel { background: #1f2329; border-color: #3d4652; }
    .subtitle, .summary-line, .filename, .step-label { color: #b6c0ce; }
    .tabs { background: #292f38; }
    .tabs button[aria-selected="true"] { border-color: #46566b; background: #394352; color: #b9d6ff; }
    .intro { border-color: #3c526e; background: #26384d; color: #d5e4f7; }
    input, select, textarea { background: #292a2d; border-color: #5f6368; color: #e8eaed; }
    button { background: #303134; border-color: #5f6368; color: #e8eaed; }
    button.primary { background: #8ab4f8; border-color: #8ab4f8; color: #202124; }
    .status-card { background: #26364a; border-color: #40536d; }
    .status-card.warning { background: #463b24; border-color: #735f2e; }
    .result-card { background: #22382d; border-color: #39654c; }
    .result-card h3 { color: #91d5aa; }
    .result-card .message { color: #d2dfd6; }
    .preview, fieldset, details.disclosure { border-color: #505966; }
    details.disclosure { background: #252a31; }
    details.disclosure[open] > summary { border-color: #424a55; }
    .metric { background: #2b323c; }
    .metric strong { color: #9bc5ff; }
    .metric span { color: #bdc7d4; }
    .studio-options { background: #26384d; }
    .badge { background: #3b4450; color: #c3ccd8; }
    .badge.connected { background: #284b36; color: #9bd5ad; }
    .hint { color: #bdc1c6; }
  }
`;

function panelTemplate() {
  return `
    <style>${PANEL_STYLES}</style>
    <div class="overlay" aria-hidden="true">
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="toolkit-title" aria-describedby="toolkit-subtitle">
        <header>
          <div><h2 id="toolkit-title">北大树洞备份工具</h2><p class="subtitle" id="toolkit-subtitle">独立保存关注内容，也可从备份迁移关注</p></div>
          <button class="close" type="button" aria-label="关闭">×</button>
        </header>
        <div class="tabs" role="tablist">
          <button id="tab-export" type="button" role="tab" data-tab="export" aria-controls="panel-export" aria-selected="true">备份到本机</button>
          <button id="tab-import" type="button" role="tab" data-tab="import" aria-controls="panel-import" aria-selected="false">迁移关注</button>
        </div>
        <main>
          <div class="status-card warning" data-task-card aria-busy="false" hidden>
            <div class="status-line"><strong data-state>准备任务</strong><span data-count></span></div>
            <progress value="0" max="1" aria-label="任务进度"></progress>
            <p class="message" role="status" aria-live="polite"></p>
            <div class="actions" data-task-actions>
              <button type="button" data-action="pause" hidden>暂停</button>
              <button type="button" data-action="resume" hidden>继续上次任务</button>
              <button class="danger" type="button" data-action="cancel" hidden>取消任务</button>
              <button type="button" data-action="retry" hidden>重试未完成项</button>
            </div>
          </div>
          <section id="panel-export" role="tabpanel" aria-labelledby="tab-export" data-panel="export">
            <p class="intro">无需安装其他应用。备份只读取树洞数据，不会修改关注、帖子或评论；文件会保存到浏览器下载位置。</p>
            <h3>备份哪些内容</h3>
            <div class="grid">
              <div class="field full"><label for="scope">备份范围</label><select id="scope"><option value="all">全部关注</option><option value="group">某个收藏分组</option><option value="pids">指定帖子 PID</option><option value="date">按帖子发布日期</option></select></div>
              <div class="field conditional" data-for-scope="group" hidden><label for="bookmark">收藏分组</label><select id="bookmark"><option value="">正在加载分组…</option></select></div>
              <div class="field full conditional" data-for-scope="pids" hidden><label for="export-pids">帖子 PID</label><textarea id="export-pids" placeholder="例如：123456 234567"></textarea><p class="hint">可用空格、逗号或换行分隔。</p></div>
              <div class="field conditional" data-for-scope="date" hidden><label for="start-date">最早发布日期（可不填）</label><input id="start-date" type="date"></div>
              <div class="field conditional" data-for-scope="date" hidden><label for="end-date">最晚发布日期（可不填）</label><input id="end-date" type="date"></div>
            </div>
            <p class="summary-line" data-export-summary>全部关注 · 包含评论 · 附带阅读版</p>
            <details class="disclosure" data-export-options>
              <summary>更多备份选项</summary>
              <div class="disclosure-body">
                <div class="checks"><label><input id="include-comments" type="checkbox" checked>包含评论</label><label><input id="include-readable" type="checkbox" checked>附带可直接阅读的文本</label></div>
                <div class="field"><label for="reference-mode">补全一层引用内容</label><select id="reference-mode"><option value="none">不补全引用</option><option value="body">补全正文中的引用</option><option value="all">补全正文和评论中的引用</option></select></div>
                <p class="hint">补全引用可能加入所选范围之外的帖子，并增加请求数量。</p>
              </div>
            </details>
            <input id="delivery-download" type="checkbox" checked hidden aria-hidden="true">
            <div class="actions primary-actions"><button class="primary" type="button" data-action="export">生成并下载备份</button></div>
            <p class="hint">每次都会生成一份新的完整快照；生成后仍可重新下载。</p>

            <div class="result-card" data-recent-export hidden>
              <h3>最近备份</h3>
              <p class="message" data-recent-export-summary>备份已经生成并保存到本机。</p>
              <p class="filename" data-recent-export-filename></p>
              <div class="actions">
                <button class="primary" type="button" data-action="download-last-export">重新下载</button>
                <button type="button" data-action="repeat-export">按相同设置再次备份</button>
                <button type="button" data-action="send-studio" hidden>发送到 Studio</button>
              </div>
            </div>

            <details class="disclosure studio-section" data-studio-section>
              <summary><span class="studio-summary"><span>可选：连接 PkuHoleStudio</span><span class="badge" data-studio-badge>未关联</span></span></summary>
              <div class="disclosure-body">
                <p class="hint">Toolkit 可独立完成备份和迁移。只有想把备份直接发送到本机 Studio 时才需要关联。</p>
                <p class="message" data-studio-connection>尚未关联 PkuHoleStudio。</p>
                <p class="message" data-studio-message role="status" aria-live="polite"></p>
                <div class="studio-options" data-studio-options hidden><label><input id="delivery-studio" type="checkbox">备份完成后同时发送到 Studio</label></div>
                <div class="actions"><button type="button" data-action="pair-studio">连接 PkuHoleStudio</button><button type="button" data-action="refresh-studio" hidden>检查连接</button><button class="quiet" type="button" data-action="forget-studio" hidden>忘记关联</button></div>
                <details class="nested">
                  <summary>连接设置</summary>
                  <div class="field"><label for="studio-port">本机 Studio 端口</label><input id="studio-port" inputmode="numeric" value="8080"></div>
                </details>
                <details class="nested">
                  <summary>兼容旧版：使用一次性接收码</summary>
                  <p class="hint">请先完成备份，再到 Studio 生成 15 分钟有效的一次性接收码。</p>
                  <div class="field"><label for="studio-pairing-code">一次性接收码</label><input id="studio-pairing-code" inputmode="text" autocomplete="off" placeholder="8080:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
                  <div class="actions"><button type="button" data-action="send-studio-legacy" disabled>使用接收码发送最近备份</button></div>
                </details>
              </div>
              </details>
          </section>
          <section id="panel-import" role="tabpanel" aria-labelledby="tab-import" data-panel="import" hidden>
            <p class="intro">迁移只会向当前登录账号新增尚未关注的帖子；不会取消已有关注，也不会发布备份中的正文或评论。</p>
            <p class="step-label">第 1 步 · 选择备份</p>
            <div class="field"><label for="archive-files">Toolkit 备份文件</label><input id="archive-files" type="file" multiple accept=".json,.zip,.treehole.zip,application/json,application/zip"><p class="hint">支持 .treehole.zip、普通 ZIP 和旧版 JSON；多个文件会自动合并去重。</p></div>
            <p class="step-label">第 2 步 · 检查内容</p>
            <div class="actions primary-actions"><button class="primary" type="button" data-action="preview-import">检查备份</button></div>
            <p class="hint">检查只会读取当前关注列表，不会修改账号。</p>
            <div class="preview" data-import-preview hidden>
              <h3>检查结果</h3>
              <div class="metrics">
                <div class="metric"><strong data-preview-new>0</strong><span>将新增</span></div>
                <div class="metric"><strong data-preview-followed>0</strong><span>已关注并跳过</span></div>
                <div class="metric"><strong data-preview-referenced>0</strong><span>仅作引用，不迁移</span></div>
                <div class="metric"><strong data-preview-invalid>0</strong><span>存在问题</span></div>
              </div>
              <p class="message" data-import-decision></p>
              <details class="nested"><summary>查看技术详情</summary><p class="message" data-import-details></p></details>
              <p class="step-label">第 3 步 · 确认写入</p>
              <div class="actions primary-actions"><button class="primary" type="button" data-action="execute-import" disabled>等待检查结果</button></div>
            </div>
          </section>
        </main>
      </div>
    </div>`;
}

function downloadBlob(documentObject, blob, filename) {
  const link = documentObject.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.hidden = true;
  documentObject.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 30_000);
}

function parsePidInput(value) {
  return String(value || '')
    .split(/[\s,，;；]+/)
    .map((pid) => pid.trim().replace(/^#/, ''))
    .filter(Boolean);
}

export function mountToolkit({
  api,
  store,
  credentialsProvider,
  documentObject = globalThis.document,
  windowObject = globalThis.window,
}) {
  if (!documentObject?.body) return null;
  let entry = documentObject.getElementById(ENTRY_ID);
  let host = documentObject.getElementById(HOST_ID);
  let activeJob = null;
  let activeKind = null;
  let activeJobId = null;
  let lastExportOptions = null;
  let importPreview = null;
  let lastArchive = null;
  let lastArchiveManifest = null;
  let studioBridgeState = null;
  let pairingWatch = null;
  let isRunning = false;
  let isStudioBusy = false;
  let taskState = 'idle';
  let bookmarksLoaded = false;
  let loadedAccountFingerprint = null;
  const mountedAt = Date.now();
  const studioBridgeStorage = createStudioBridgeStorage();
  let preferenceStorage = null;
  try {
    preferenceStorage = windowObject.localStorage;
  } catch {
    // Some hardened browser profiles deny access to origin storage.
  }
  const savedDestinations = readArchiveDestinations(preferenceStorage);

  if (!entry) {
    entry = documentObject.createElement('button');
    entry.id = ENTRY_ID;
    entry.type = 'button';
    entry.textContent = '树洞备份';
    entry.style.minWidth = '78px';
    entry.style.marginInline = '4px';
  }
  if (!host) {
    host = documentObject.createElement('div');
    host.id = HOST_ID;
    documentObject.body.append(host);
  }
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  if (!shadow.querySelector('.overlay')) shadow.innerHTML = panelTemplate();

  const $ = (selector) => shadow.querySelector(selector);
  const overlay = $('.overlay');
  const statusLabel = $('[data-state]');
  const statusCard = $('[data-task-card]');
  const countLabel = $('[data-count]');
  const progress = $('progress');
  const message = statusCard.querySelector('.message');
  const pauseButton = $('[data-action="pause"]');
  const resumeButton = $('[data-action="resume"]');
  const cancelButton = $('[data-action="cancel"]');
  const retryButton = $('[data-action="retry"]');
  const importExecuteButton = $('[data-action="execute-import"]');
  const studioConnectionMessage = $('[data-studio-connection]');
  const studioMessage = $('[data-studio-message]');
  const studioSection = $('[data-studio-section]');
  const studioBadge = $('[data-studio-badge]');
  const studioOptions = $('[data-studio-options]');
  const studioPairButton = $('[data-action="pair-studio"]');
  const studioRefreshButton = $('[data-action="refresh-studio"]');
  const studioForgetButton = $('[data-action="forget-studio"]');
  const studioSendButton = $('[data-action="send-studio"]');
  const studioLegacySendButton = $('[data-action="send-studio-legacy"]');
  const lastExportDownloadButton = $('[data-action="download-last-export"]');
  const repeatExportButton = $('[data-action="repeat-export"]');
  const recentExport = $('[data-recent-export]');
  const deliveryDownload = $('#delivery-download');
  const deliveryStudio = $('#delivery-studio');
  deliveryDownload.checked = true;
  deliveryStudio.checked = savedDestinations.studio;

  function placeEntry() {
    const anchor = documentObject.querySelector('div.search-btn');
    if (anchor) {
      ensureEntryBeforeAnchor(entry, anchor);
      Object.assign(entry.style, { position: '', right: '', bottom: '', zIndex: '' });
    } else if (!entry.isConnected && Date.now() - mountedAt >= 10_000) {
      documentObject.body.append(entry);
      Object.assign(entry.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: '2147483645',
      });
    }
  }

  function setMessage(text, isError = false) {
    message.textContent = text || '';
    message.classList.toggle('error', isError);
  }

  function setStudioMessage(text, isError = false) {
    studioMessage.textContent = text || '';
    studioMessage.classList.toggle('error', isError);
  }

  function renderControls() {
    const busy = isRunning || isStudioBusy;
    const resumable = !busy && Boolean(activeJobId) && taskState === 'paused';
    const retryable = !busy && Boolean(activeJobId) && ['partial', 'failed'].includes(taskState);
    const controllable = isRunning && Boolean(activeJob) && ['planning', 'running'].includes(taskState);
    const discardable = !busy && Boolean(activeJobId) && taskState === 'paused';
    const showTask =
      isRunning ||
      ['paused', 'partial', 'failed', 'cancelled'].includes(taskState) ||
      (activeKind === 'import' && taskState === 'completed');

    statusCard.hidden = !showTask;
    statusCard.setAttribute('aria-busy', String(isRunning));
    pauseButton.hidden = !controllable;
    pauseButton.disabled = !controllable;
    cancelButton.hidden = !(controllable || discardable);
    cancelButton.disabled = !(controllable || discardable);
    cancelButton.textContent = discardable ? '放弃断点' : '取消任务';
    resumeButton.hidden = !resumable;
    resumeButton.disabled = !resumable;
    retryButton.hidden = !retryable;
    retryButton.disabled = !retryable;
    $('[data-action="export"]').disabled = busy;
    $('[data-action="preview-import"]').disabled = busy;
    studioSendButton.disabled = busy || !lastArchive || studioBridgeState?.status !== 'paired';
    studioLegacySendButton.disabled = busy || !lastArchive;
    lastExportDownloadButton.disabled = busy || !lastArchive;
    repeatExportButton.disabled = busy || !lastExportOptions;
    studioPairButton.disabled = busy || studioBridgeState?.status === 'paired' || studioBridgeState?.status === 'pending';
    studioRefreshButton.disabled = busy || !studioBridgeState;
    studioForgetButton.disabled = busy || !studioBridgeState;
    deliveryDownload.disabled = busy;
    deliveryStudio.disabled = busy || studioBridgeState?.status !== 'paired';
    importExecuteButton.disabled =
      busy ||
      !importPreview ||
      importPreview.remoteComplete !== true ||
      importPreview.newPids?.length === 0;
  }

  function setTaskStatus(state) {
    taskState = state || 'idle';
    statusLabel.dataset.taskState = taskState;
    statusLabel.textContent = taskStatusText(taskState, activeKind || 'export');
    statusCard.classList.toggle('warning', ['paused', 'partial'].includes(taskState));
    renderControls();
  }

  function setRunning(running) {
    isRunning = running;
    renderControls();
  }

  function setStudioBusy(busy) {
    isStudioBusy = busy;
    renderControls();
  }

  function renderRecentExport(manifest = lastArchiveManifest, note = '') {
    recentExport.hidden = !lastArchive;
    if (!lastArchive) {
      $('[data-recent-export-filename]').textContent = '';
      renderControls();
      return;
    }
    const counts = manifest?.counts;
    $('[data-recent-export-summary]').textContent = note || (counts
      ? `${manifest.complete ? '备份完成' : '部分备份'}：${counts.exportedHoles} 个帖子、${counts.comments} 条评论。`
      : '最近生成的备份可以直接重新下载，不需要再次抓取。');
    $('[data-recent-export-filename]').textContent = lastArchive.filename || '';
    studioSendButton.hidden = studioBridgeState?.status !== 'paired';
    renderControls();
  }

  function renderImportPreview(preview) {
    const previewElement = $('[data-import-preview]');
    previewElement.hidden = !preview;
    if (!preview) {
      importExecuteButton.textContent = '等待检查结果';
      renderControls();
      return;
    }
    $('[data-preview-new]').textContent = String(preview.newPids.length);
    $('[data-preview-followed]').textContent = String(preview.alreadyFollowed.length);
    $('[data-preview-referenced]').textContent = String(preview.excludedReferenced);
    $('[data-preview-invalid]').textContent = String(preview.invalidFiles.length);
    $('[data-import-details]').textContent = [
      `读取文件：${preview.archives.length}`,
      `有效 PID：${preview.allPids.length}`,
      `重复记录：${preview.duplicateCount}`,
    ].join(' · ');
    const decision = $('[data-import-decision]');
    if (preview.invalidFiles.length > 0 && preview.allPids.length === 0) {
      decision.textContent = '没有从所选文件中读取到有效帖子，请展开技术详情检查文件。';
      decision.classList.add('error');
      importExecuteButton.textContent = '没有可迁移的关注';
    } else if (preview.remoteComplete !== true) {
      decision.textContent = '当前关注列表没有读取完整。为避免误判，本次禁止继续，请稍后重新检查。';
      decision.classList.add('error');
      importExecuteButton.textContent = '当前无法迁移';
    } else if (preview.newPids.length === 0) {
      decision.textContent = '当前账号已经关注备份中的全部帖子，无需执行迁移。';
      decision.classList.remove('error');
      importExecuteButton.textContent = '无需新增关注';
    } else {
      decision.textContent = `确认后只会向当前账号新增 ${preview.newPids.length} 个关注。`;
      decision.classList.remove('error');
      importExecuteButton.textContent = `向当前账号新增 ${preview.newPids.length} 个关注`;
    }
    renderControls();
  }

  function updateExportSummary() {
    const options = exportOptions();
    const summary = exportSummaryText(options);
    let scopeDetail = '';
    if (options.scope.type === 'group') {
      const selected = $('#bookmark').selectedOptions?.[0]?.textContent;
      if (selected && options.scope.bookmarkId) scopeDetail = `“${selected}”`;
    } else if (options.scope.type === 'pids') {
      scopeDetail = options.scope.pids.length ? `${options.scope.pids.length} 个 PID` : '尚未填写 PID';
    } else if (options.scope.type === 'date') {
      scopeDetail = [options.scope.startDate || '不限起始', options.scope.endDate || '不限结束'].join(' 至 ');
    }
    $('[data-export-summary]').textContent = scopeDetail ? `${summary} · ${scopeDetail}` : summary;
  }

  function useAccountFingerprint(accountFingerprint) {
    const next = reconcileAccountScopedState(
      {
        accountFingerprint: loadedAccountFingerprint,
        lastArchive,
        lastExportOptions,
        activeJobId,
        activeKind,
        importPreview,
      },
      accountFingerprint,
    );
    loadedAccountFingerprint = next.accountFingerprint;
    if (!next.accountChanged) return false;
    lastArchive = next.lastArchive;
    lastArchiveManifest = null;
    lastExportOptions = next.lastExportOptions;
    activeJobId = next.activeJobId;
    activeKind = next.activeKind;
    importPreview = next.importPreview;
    bookmarksLoaded = false;
    $('#bookmark').replaceChildren();
    renderImportPreview(null);
    renderRecentExport();
    if (!isRunning) {
      setMessage('登录账号已经变化，请在当前账号重新选择备份范围或重新检查迁移文件。');
      setTaskStatus('idle');
    } else renderControls();
    return true;
  }

  async function credentialsForCurrentAccount() {
    const credentials = await credentialsProvider();
    return {
      credentials,
      accountChanged: useAccountFingerprint(credentials.accountFingerprint),
    };
  }

  function renderStudioBridgeState() {
    const state = studioBridgeState;
    if (state?.status === 'paired') {
      studioConnectionMessage.textContent = `已连接 ${state.name || '本机 Studio'}。可以发送最近备份，或在备份完成后自动发送。`;
      $('#studio-port').value = String(state.port || 8080);
      studioBadge.textContent = '已连接';
      studioBadge.classList.add('connected');
      studioOptions.hidden = false;
      studioPairButton.hidden = true;
      studioRefreshButton.hidden = false;
      studioForgetButton.hidden = false;
    } else if (state?.status === 'pending') {
      studioConnectionMessage.textContent = `等待 Studio 确认。请在 Studio“Toolkit 传输”页核对：${state.verificationCode || '------'}`;
      $('#studio-port').value = String(state.port || 8080);
      studioBadge.textContent = '等待确认';
      studioBadge.classList.remove('connected');
      studioOptions.hidden = true;
      studioPairButton.hidden = true;
      studioRefreshButton.hidden = false;
      studioForgetButton.hidden = false;
      studioSection.open = true;
    } else {
      studioConnectionMessage.textContent = '尚未连接。只有需要把备份直接发送到本机 Studio 时才需要设置。';
      studioBadge.textContent = '未连接';
      studioBadge.classList.remove('connected');
      studioOptions.hidden = true;
      deliveryStudio.checked = false;
      writeArchiveDestinations(preferenceStorage, { download: true, studio: false });
      studioPairButton.hidden = false;
      studioPairButton.textContent = '连接 PkuHoleStudio';
      studioRefreshButton.hidden = true;
      studioForgetButton.hidden = true;
    }
    renderRecentExport();
    renderControls();
  }

  function handleProgress(event) {
    const total = Number(event.total || 0);
    const completed = Number(event.completed || event.count || 0);
    progress.max = Math.max(1, total);
    progress.value = Math.min(completed, progress.max);
    countLabel.textContent = `${completed} / ${total || '?'}`;
    if (event.state) setTaskStatus(event.state);
    else if (!['planning', 'previewing'].includes(taskState)) setTaskStatus('running');
    if (event.pid) setMessage(`正在处理帖子 #${event.pid}`);
    else if (event.phase === 'archive_files') {
      setMessage(`正在读取备份文件：${completed} / ${total || '?'}…`);
    } else if (event.phase === 'remote_followed') {
      setMessage(`正在读取当前关注列表：${completed} / ${total || '?'}…`);
    }
  }

  async function ensureBookmarks() {
    const select = $('#bookmark');
    try {
      const { credentials } = await credentialsForCurrentAccount();
      if (bookmarksLoaded) return;
      const bookmarks = await apiForAccount(api, credentials.accountFingerprint).listBookmarks();
      select.replaceChildren(
        ...bookmarks.map((bookmark) => {
          const option = documentObject.createElement('option');
          option.value = bookmark.id;
          option.textContent = bookmark.name;
          return option;
        }),
      );
      if (!bookmarks.length) {
        const option = documentObject.createElement('option');
        option.value = '';
        option.textContent = '暂无收藏分组';
        select.append(option);
      }
      bookmarksLoaded = true;
      updateExportSummary();
    } catch (error) {
      select.replaceChildren();
      const option = documentObject.createElement('option');
      option.value = '';
      option.textContent = '分组加载失败';
      select.append(option);
      setMessage(error.message, true);
      if (!isRunning) setTaskStatus('failed');
    }
  }

  const discoverResumableJob = createResumableJobDiscovery({
    isBusy: () => Boolean(activeJob || isRunning),
    async discover() {
      try {
        const { credentials } = await credentialsForCurrentAccount();
        if (activeJob || isRunning) return null;
        const [restored, jobs] = await Promise.all([
          restoreLatestExportArchive(store, credentials.accountFingerprint),
          store.listJobs(),
        ]);
        if (activeJob || isRunning) return null;
        if (restored) {
          lastArchive = restored.archive;
          lastArchiveManifest = restored.job.manifest || null;
          lastExportOptions = restored.job.options;
          renderRecentExport(lastArchiveManifest, '已恢复最近完成的备份，可以直接重新下载。');
        }
        let job = selectLatestResumableJob(jobs, credentials.accountFingerprint);
        if (!job) {
          setTaskStatus('idle');
          setRunning(false);
          return null;
        }
        if (['planning', 'running'].includes(job.state)) {
          job = { ...job, state: 'paused' };
          await store.putJob(job);
          if (activeJob || isRunning) return null;
        }
        activeJobId = job.id;
        activeKind = job.type;
        if (job.type === 'export') lastExportOptions = job.options;
        if (job.type === 'import') {
          importPreview = job.preview;
          renderImportPreview(importPreview);
        }
        countLabel.textContent = `${job.completed || 0} / ${job.total || '?'}`;
        setMessage(`发现未完成的${job.type === 'export' ? '备份' : '关注迁移'}，断点仍然保留。`);
        setTaskStatus(job.state);
        setRunning(false);
        return job;
      } catch (error) {
        if (error.code !== ERROR_CODES.UNAUTHORIZED) console.warn('[PKU Hole Toolkit]', error);
        return null;
      }
    },
  });

  function exportOptions() {
    const type = $('#scope').value;
    const scope = { type };
    if (type === 'group') scope.bookmarkId = $('#bookmark').value;
    if (type === 'pids') scope.pids = parsePidInput($('#export-pids').value);
    if (type === 'date') {
      scope.startDate = $('#start-date').value || null;
      scope.endDate = $('#end-date').value || null;
    }
    return {
      scope,
      includeComments: $('#include-comments').checked,
      includeReadable: $('#include-readable').checked,
      referenceMode: $('#reference-mode').value,
    };
  }

  function archiveDestinations() {
    return writeArchiveDestinations(preferenceStorage, {
      download: true,
      studio: deliveryStudio.checked && studioBridgeState?.status === 'paired',
    });
  }

  async function deliverExportArchive(archive, destinations) {
    const delivery = await deliverArchiveToDestinations({
      archive,
      destinations,
      studioConnected: studioBridgeState?.status === 'paired',
      downloadArchive: (value) => downloadBlob(documentObject, value.blob, value.filename),
      sendArchiveToStudio: (value) => sendArchiveToTrustedStudio(value, {
        state: studioBridgeState,
        storage: studioBridgeStorage,
      }),
    });
    const studioError = delivery.studioError;
    if (
      delivery.studio === 'failed' &&
      studioError &&
      (studioError.status === 404 || studioError.code === ERROR_CODES.UNAUTHORIZED)
    ) {
      await studioBridgeStorage.delete();
      studioBridgeState = null;
      renderStudioBridgeState();
    }
    return delivery;
  }

  async function runExport(options, jobId = null) {
    const destinations = archiveDestinations();
    if (!jobId) {
      activeJobId = null;
      activeKind = null;
    }
    activeKind = 'export';
    setTaskStatus('planning');
    setRunning(true);
    setMessage('正在读取所选范围，随后会逐个保存帖子和评论…');
    try {
      const { credentials, accountChanged } = await credentialsForCurrentAccount();
      if (accountChanged && jobId) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, '账号已切换，不能恢复旧账号的导出任务');
      }
      if (accountChanged && options?.scope?.type === 'group') {
        await ensureBookmarks();
        throw new AppError(ERROR_CODES.INVALID_INPUT, '账号已切换，请重新选择收藏分组');
      }
      activeKind = 'export';
      lastExportOptions = options;
      activeJob = new ExportJob({
        api: apiForAccount(api, credentials.accountFingerprint),
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
        confirmReferences: async (count) =>
          windowObject.confirm(`检测到 ${count} 个引用洞，是否继续抓取？`),
      });
      const result = await activeJob.run(options, { jobId });
      activeJobId = result.job.id;
      if (result.paused) {
        setTaskStatus('paused');
        setMessage('任务已经安全暂停，断点会保留 7 天。');
        return;
      }
      lastArchive = result.archive;
      lastArchiveManifest = result.manifest;
      const delivery = await deliverExportArchive(result.archive, destinations);
      setTaskStatus(result.job.state);
      countLabel.textContent = `${result.manifest.counts.exportedHoles} / ${result.manifest.counts.expectedHoles ?? '?'}`;
      const archiveMessage = result.manifest.complete
        ? delivery.download === 'started'
          ? '备份完成，浏览器下载已经开始。'
          : '备份已经生成，但浏览器没有启动下载；可以点击“重新下载”。'
        : `已生成部分备份，${result.manifest.errors.length} 项未完成；可以先下载，也可以重试。`;
      renderRecentExport(result.manifest, archiveMessage);
      setMessage(archiveMessage, !result.manifest.complete || delivery.download === 'failed');
      if (delivery.studio === 'awaiting_confirmation') {
        setStudioMessage(
          `已发送并通过预检（${delivery.studioResult?.preflight?.counts?.valid_items ?? '?'} 个有效帖子），请回到 Studio 确认导入。`,
        );
      } else if (delivery.studio === 'failed') {
        setStudioMessage(`本地备份不受影响；发送失败：${delivery.studioError?.message || '未知错误'}`, true);
        studioSection.open = true;
      }
    } catch (error) {
      activeJobId = activeJobId || activeJob?.jobId || null;
      const cancelled = error.code === ERROR_CODES.CANCELLED;
      setMessage(cancelled ? '备份已取消。' : error.message || '备份失败', !cancelled);
      setTaskStatus(
        cancelled ? 'cancelled' : error.code === ERROR_CODES.RATE_LIMITED ? 'paused' : 'failed',
      );
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function previewImport() {
    const files = [...$('#archive-files').files];
    if (!files.length) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先选择 Toolkit 备份文件');
    activeJobId = null;
    activeKind = 'import';
    importPreview = null;
    renderImportPreview(null);
    setTaskStatus('previewing');
    setRunning(true);
    countLabel.textContent = '0 / ?';
    progress.removeAttribute('value');
    setMessage('正在读取备份并检查当前关注列表；此步骤不会修改账号。');
    try {
      const { credentials } = await credentialsForCurrentAccount();
      activeJob = new ImportJob({
        api: apiForAccount(api, credentials.accountFingerprint),
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
      });
      importPreview = await activeJob.preview(files);
      renderImportPreview(importPreview);
      setTaskStatus('previewed');
      progress.max = 1;
      progress.value = 1;
      countLabel.textContent = `${importPreview.allPids.length} PID`;
      setMessage(
        importPreview.remoteComplete !== true
          ? '检查未完成：当前关注列表读取不完整，已禁止迁移，请稍后重试。'
          : importPreview.newPids.length
          ? '检查完成，请核对数量后确认新增关注。'
          : '检查完成：所有帖子均已关注，无需迁移。',
        importPreview.remoteComplete !== true,
      );
    } catch (error) {
      setTaskStatus(error.code === ERROR_CODES.CANCELLED ? 'cancelled' : 'failed');
      throw error;
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function executeImport(jobId = null) {
    activeKind = 'import';
    setTaskStatus('running');
    setRunning(true);
    setMessage('正在准备向当前账号新增关注…');
    try {
      const { credentials, accountChanged } = await credentialsForCurrentAccount();
      if (accountChanged) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, '账号已切换，请在当前账号重新预检');
      }
      if (!importPreview) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先执行预检');
      if (
        !windowObject.confirm(
          `即将向当前账号新增 ${importPreview.newPids.length} 个关注，不会取消或修改已有关注。是否继续？`,
        )
      ) {
        setTaskStatus('previewed');
        return;
      }
      if (!jobId) activeJobId = null;
      activeKind = 'import';
      activeJob = new ImportJob({
        api: apiForAccount(api, credentials.accountFingerprint),
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
      });
      const result = await activeJob.execute(importPreview, { jobId });
      activeJobId = result.job.id;
      setTaskStatus(result.job.state);
      if (!result.paused) {
        const text = buildImportAuditText(result.audit);
        downloadBlob(
          documentObject,
          new Blob([text], { type: 'text/plain;charset=utf-8' }),
          `${result.job.id}-audit.txt`,
        );
      }
      setMessage(
        result.paused
          ? '关注迁移已暂停，稍后可以继续。'
          : `迁移完成：新增 ${result.audit.followed}，失败 ${result.audit.failed}，结果未知 ${result.audit.unknown}。审计报告已下载。`,
        !result.paused && (result.audit.failed > 0 || result.audit.unknown > 0),
      );
    } catch (error) {
      activeJobId = activeJobId || activeJob?.jobId || null;
      const cancelled = error.code === ERROR_CODES.CANCELLED;
      setMessage(cancelled ? '关注迁移已取消。' : error.message || '关注迁移失败', !cancelled);
      setTaskStatus(
        cancelled ? 'cancelled' : error.code === ERROR_CODES.RATE_LIMITED ? 'paused' : 'failed',
      );
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function refreshStudioConnection() {
    if (pairingWatch && studioBridgeState?.status === 'pending') {
      renderStudioBridgeState();
      return studioBridgeState;
    }
    try {
      studioBridgeState = await studioBridgeStorage.get();
    } catch (error) {
      if (error.status === 404 || error.code === ERROR_CODES.UNAUTHORIZED) studioBridgeState = null;
      else throw error;
    } finally {
      renderStudioBridgeState();
    }
    return studioBridgeState;
  }

  async function cancelStudioPairingWatch() {
    const watch = pairingWatch;
    if (!watch) return;
    pairingWatch = null;
    await abortAndWaitForPairingWatch(watch);
  }

  function watchStudioPairing(state) {
    if (pairingWatch || state?.status !== 'pending') return;
    const Controller = windowObject.AbortController || globalThis.AbortController;
    const watch = {
      controller: new Controller(),
      requestToken: state.requestToken,
      promise: null,
    };
    pairingWatch = watch;
    watch.promise = waitForStudioDevicePairing({
      state,
      storage: studioBridgeStorage,
      signal: watch.controller.signal,
      onUpdate(next) {
        if (
          pairingWatch !== watch ||
          watch.controller.signal.aborted ||
          (next?.status === 'pending' && next.requestToken !== watch.requestToken)
        ) {
          return;
        }
        studioBridgeState = next;
        renderStudioBridgeState();
      },
    })
      .then((paired) => {
        if (pairingWatch !== watch || watch.controller.signal.aborted) return;
        studioBridgeState = paired;
        renderStudioBridgeState();
        setStudioMessage('连接成功。今后可以直接发送备份，不需要重复输入接收码。');
      })
      .catch((error) => {
        if (
          pairingWatch !== watch ||
          watch.controller.signal.aborted ||
          error.code === ERROR_CODES.CANCELLED
        ) {
          return;
        }
        studioBridgeState = null;
        renderStudioBridgeState();
        setStudioMessage(error.message || 'PkuHoleStudio 连接失败', true);
      })
      .finally(() => {
        if (pairingWatch === watch) pairingWatch = null;
      });
  }

  async function pairStudio() {
    const port = $('#studio-port').value.trim();
    setStudioBusy(true);
    studioSection.open = true;
    setStudioMessage('正在向本机 PkuHoleStudio 发起连接请求…');
    try {
      await cancelStudioPairingWatch();
      const previous = await studioBridgeStorage.get();
      if (previous?.status === 'paired') {
        studioBridgeState = previous;
        renderStudioBridgeState();
        setStudioMessage('PkuHoleStudio 已经连接，无需重新发起。');
        return;
      }
      if (previous?.status === 'pending') await studioBridgeStorage.delete();
      studioBridgeState = null;
      renderStudioBridgeState();
      studioBridgeState = await requestStudioDevicePairing({ port, storage: studioBridgeStorage });
      renderStudioBridgeState();
      const studioURL = `http://127.0.0.1:${studioBridgeState.port}/imports?view=bridge`;
      windowObject.open?.(studioURL, '_blank', 'noopener');
      setStudioMessage(`请求已发出，请在 Studio 核对验证码 ${studioBridgeState.verificationCode} 并确认。`);
      watchStudioPairing(studioBridgeState);
    } catch (error) {
      setStudioMessage(error.message || '无法连接 PkuHoleStudio', true);
    } finally {
      setStudioBusy(false);
    }
  }

  async function sendToTrustedStudio() {
    setStudioBusy(true);
    studioSection.open = true;
    setStudioMessage('正在签名并发送最近备份…');
    try {
      await credentialsForCurrentAccount();
      if (!lastArchive) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出');
      if (studioBridgeState?.status !== 'paired') throw new AppError(ERROR_CODES.UNAUTHORIZED, '请先关联本机 Studio');
      const result = await sendArchiveToTrustedStudio(lastArchive, { state: studioBridgeState, storage: studioBridgeStorage });
      setStudioMessage(`发送成功：${result.preflight?.counts?.valid_items ?? '?'} 个有效帖子，请回到 Studio 确认导入。`);
    } catch (error) {
      if (
        error.status === 404 ||
        (error.code === ERROR_CODES.UNAUTHORIZED && error.operation !== 'credentials')
      ) {
        await studioBridgeStorage.delete();
        studioBridgeState = null;
        renderStudioBridgeState();
      }
      setStudioMessage(`本地备份不受影响；发送失败：${error.message || '未知错误'}`, true);
    } finally {
      setStudioBusy(false);
    }
  }

  async function forgetStudioConnection() {
    setStudioBusy(true);
    try {
      await cancelStudioPairingWatch();
      const previous = (await studioBridgeStorage.get()) || studioBridgeState;
      studioBridgeState = null;
      renderStudioBridgeState();
      const result = await forgetStudioDevice({ state: previous, storage: studioBridgeStorage });
      setStudioMessage(result.revoked ? '已从 Toolkit 和 Studio 撤销设备关联。' : '已删除本地连接请求。');
    } catch (error) {
      studioBridgeState = null;
      renderStudioBridgeState();
      setStudioMessage(`本地关联已删除；Studio 当前不可达，稍后可在 Studio 设备列表清理。${error.message ? `（${error.message}）` : ''}`);
    } finally {
      setStudioBusy(false);
    }
  }

  async function sendToStudioWithCode() {
    setStudioBusy(true);
    studioSection.open = true;
    setStudioMessage('正在使用一次性接收码发送最近备份…');
    try {
      await credentialsForCurrentAccount();
      if (!lastArchive) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出');
      const code = $('#studio-pairing-code').value.trim();
      if (!code) throw new AppError(ERROR_CODES.INVALID_INPUT, '请粘贴 Studio 生成的一次性接收码');
      const result = await sendArchiveToStudio(code, lastArchive);
      setStudioMessage(`发送成功：${result.preflight?.counts?.valid_items ?? '?'} 个有效帖子，请回到 Studio 确认导入。`);
      $('#studio-pairing-code').value = '';
    } catch (error) {
      setStudioMessage(error.message || '发送到 Studio 失败', true);
    } finally {
      setStudioBusy(false);
    }
  }

  async function downloadLastExport() {
    await credentialsForCurrentAccount();
    if (!lastArchive) throw new AppError(ERROR_CODES.INVALID_INPUT, '没有可重新下载的完成归档');
    downloadBlob(documentObject, lastArchive.blob, lastArchive.filename);
    renderRecentExport(lastArchiveManifest, `已重新下载 ${lastArchive.filename}`);
  }

  async function discardResumableTask() {
    if (!activeJobId || taskState !== 'paused') return;
    if (!windowObject.confirm('放弃后将删除这次任务的断点，无法再继续。是否放弃？')) return;
    await store.deleteJob(activeJobId);
    activeJobId = null;
    if (activeKind === 'import') {
      importPreview = null;
      renderImportPreview(null);
    }
    activeKind = null;
    setMessage('');
    setTaskStatus('idle');
  }

  function openPanel() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    $('[data-action="export"]').focus();
    discoverResumableJob();
    refreshStudioConnection()
      .then((state) => watchStudioPairing(state))
      .catch((error) => setStudioMessage(error.message || '读取 Studio 连接状态失败', true));
  }

  function closePanel() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    entry.focus();
  }

  entry.addEventListener('click', openPanel);
  $('.close').addEventListener('click', closePanel);
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });
  $('#scope').addEventListener('change', (event) => {
    shadow.querySelectorAll('[data-for-scope]').forEach((element) => {
      element.hidden = element.dataset.forScope !== event.target.value;
    });
    if (event.target.value === 'group') ensureBookmarks();
    updateExportSummary();
  });
  for (const selector of ['#include-comments', '#include-readable', '#reference-mode']) {
    $(selector).addEventListener('change', updateExportSummary);
  }
  for (const selector of ['#bookmark', '#start-date', '#end-date']) {
    $(selector).addEventListener('change', updateExportSummary);
  }
  $('#export-pids').addEventListener('input', updateExportSummary);
  shadow.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      shadow.querySelectorAll('[data-tab]').forEach((other) =>
        other.setAttribute('aria-selected', String(other === tab)),
      );
      shadow.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      });
    });
  });
  $('[data-action="export"]').addEventListener('click', () => {
    lastExportOptions = exportOptions();
    runExport(lastExportOptions);
  });
  deliveryStudio.addEventListener('change', archiveDestinations);
  $('[data-action="send-studio"]').addEventListener('click', () =>
    sendToTrustedStudio().catch((error) => {
      setStudioMessage(error.message || '发送到 Studio 失败', true);
    }),
  );
  $('[data-action="send-studio-legacy"]').addEventListener('click', () =>
    sendToStudioWithCode().catch((error) => {
      setStudioMessage(error.message || '发送到 Studio 失败', true);
    }),
  );
  studioPairButton.addEventListener('click', () => pairStudio());
  studioForgetButton.addEventListener('click', () => forgetStudioConnection());
  studioRefreshButton.addEventListener('click', () =>
    refreshStudioConnection()
      .then((state) => {
        watchStudioPairing(state);
        if (state?.status === 'paired') setStudioMessage('连接有效，可以发送最近备份。');
      })
      .catch((error) => setStudioMessage(error.message || '检查 Studio 连接失败', true)),
  );
  lastExportDownloadButton.addEventListener('click', () =>
    downloadLastExport().catch((error) => {
      setTaskStatus('failed');
      setMessage(error.message, true);
    }),
  );
  repeatExportButton.addEventListener('click', () => {
    if (!lastExportOptions) return;
    runExport(lastExportOptions);
  });
  $('#archive-files').addEventListener('change', () => {
    importPreview = null;
    renderImportPreview(null);
    if (!isRunning) setTaskStatus('idle');
  });
  $('[data-action="preview-import"]').addEventListener('click', () =>
    previewImport().catch((error) => {
      setTaskStatus(error.code === ERROR_CODES.CANCELLED ? 'cancelled' : 'failed');
      setMessage(error.message, true);
    }),
  );
  importExecuteButton.addEventListener('click', () =>
    executeImport().catch((error) => {
      setTaskStatus(error.code === ERROR_CODES.CANCELLED ? 'cancelled' : 'failed');
      setMessage(error.message, true);
    }),
  );
  pauseButton.addEventListener('click', () => {
    activeJob?.requestPause();
    setMessage('将在当前帖子处理完成后安全暂停…');
  });
  cancelButton.addEventListener('click', () => {
    if (activeJob) activeJob.cancel();
    else {
      discardResumableTask().catch((error) => {
        setTaskStatus('failed');
        setMessage(error.message || '无法删除任务断点', true);
      });
    }
  });
  resumeButton.addEventListener('click', () => {
    if (activeKind === 'export') runExport(lastExportOptions, activeJobId);
    else if (activeKind === 'import') executeImport(activeJobId);
  });
  retryButton.addEventListener('click', () => {
    if (activeKind === 'export') runExport(lastExportOptions, activeJobId);
    else if (activeKind === 'import') executeImport(activeJobId);
  });

  updateExportSummary();
  renderImportPreview(null);
  renderRecentExport();
  renderControls();
  placeEntry();
  const fallbackTimer = setTimeout(placeEntry, 10_000);
  const Observer = windowObject.MutationObserver || globalThis.MutationObserver;
  let placementScheduled = false;
  const schedulePlacement = () => {
    if (placementScheduled) return;
    placementScheduled = true;
    const run = () => {
      placementScheduled = false;
      placeEntry();
    };
    if (typeof windowObject.requestAnimationFrame === 'function') {
      windowObject.requestAnimationFrame(run);
    } else {
      windowObject.setTimeout(run, 0);
    }
  };
  const observer = new Observer(schedulePlacement);
  observer.observe(documentObject.body, { childList: true, subtree: true });

  return {
    entry,
    host,
    open: openPanel,
    close: closePanel,
    destroy() {
      clearTimeout(fallbackTimer);
      void cancelStudioPairingWatch();
      observer.disconnect();
      entry.remove();
      host.remove();
    },
    reportError(error) {
      const record = toErrorRecord(error);
      openPanel();
      setTaskStatus('failed');
      setMessage(record.message, true);
    },
  };
}
