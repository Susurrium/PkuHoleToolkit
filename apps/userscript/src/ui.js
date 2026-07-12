import { ExportJob } from './export-job.js';
import { ImportJob, buildImportAuditText } from './import-job.js';
import { AppError, ERROR_CODES, toErrorRecord } from './errors.js';
import { sendArchiveToStudio } from './studio-bridge.js';

const ENTRY_ID = 'pku-hole-toolkit-entry';
const HOST_ID = 'pku-hole-toolkit-host';

export function ensureEntryBeforeAnchor(entry, anchor) {
  if (!entry || !anchor?.parentNode) return false;
  if (entry.parentNode === anchor.parentNode && entry.nextSibling === anchor) return false;
  anchor.parentNode.insertBefore(entry, anchor);
  return true;
}

const PANEL_STYLES = `
  :host { all: initial; color-scheme: light dark; }
  * { box-sizing: border-box; }
  .overlay { position: fixed; inset: 0; z-index: 2147483646; display: none; place-items: center; padding: 20px; background: rgba(0,0,0,.5); font-family: system-ui, -apple-system, sans-serif; color: #202124; }
  .overlay.open { display: grid; }
  .panel { width: min(720px, 100%); max-height: min(820px, calc(100vh - 40px)); overflow: auto; border-radius: 14px; background: #fff; box-shadow: 0 24px 80px rgba(0,0,0,.32); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid #e6e8eb; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 12px; font-size: 16px; }
  .close { border: 0; background: transparent; font-size: 26px; line-height: 1; cursor: pointer; color: inherit; }
  .tabs { display: flex; gap: 6px; padding: 12px 20px 0; }
  .tabs button { flex: 1; }
  main { padding: 18px 20px 22px; }
  section[hidden], .conditional[hidden] { display: none; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  .field { display: grid; gap: 6px; }
  .field.full { grid-column: 1 / -1; }
  label, legend { font-size: 14px; font-weight: 600; }
  input, select, textarea, button { font: inherit; }
  input, select, textarea { width: 100%; border: 1px solid #b8bec7; border-radius: 8px; padding: 9px 10px; background: #fff; color: #202124; }
  textarea { min-height: 80px; resize: vertical; }
  .checks { display: flex; flex-wrap: wrap; gap: 12px 20px; margin: 14px 0; }
  .checks label { display: flex; align-items: center; gap: 7px; font-weight: 500; }
  .checks input { width: auto; }
  button { border: 1px solid #aeb4bd; border-radius: 8px; padding: 9px 14px; background: #f7f8fa; color: #202124; cursor: pointer; }
  button.primary { border-color: #1a73e8; background: #1a73e8; color: #fff; }
  button.danger { border-color: #c5221f; color: #c5221f; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid rgba(26,115,232,.35); outline-offset: 2px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .status-card { margin-top: 18px; padding: 14px; border-radius: 10px; background: #f2f6fc; border: 1px solid #dce6f5; }
  .status-line { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
  progress { width: 100%; height: 12px; margin: 10px 0; }
  .message { min-height: 1.5em; margin: 8px 0 0; white-space: pre-wrap; font-size: 14px; }
  .message.error { color: #b3261e; }
  .preview { margin-top: 14px; padding: 12px; border: 1px solid #d7dbe1; border-radius: 8px; white-space: pre-wrap; font-size: 14px; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } .field.full { grid-column: auto; } }
  @media (prefers-color-scheme: dark) {
    .overlay { color: #e8eaed; }
    .panel { background: #202124; }
    header { border-color: #3c4043; }
    input, select, textarea { background: #292a2d; border-color: #5f6368; color: #e8eaed; }
    button { background: #303134; border-color: #5f6368; color: #e8eaed; }
    button.primary { background: #8ab4f8; border-color: #8ab4f8; color: #202124; }
    .status-card { background: #263248; border-color: #3b4e6d; }
    .preview { border-color: #5f6368; }
  }
`;

function panelTemplate() {
  return `
    <style>${PANEL_STYLES}</style>
    <div class="overlay" aria-hidden="true">
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="toolkit-title">
        <header><h2 id="toolkit-title">北大树洞归档与迁移</h2><button class="close" type="button" aria-label="关闭">×</button></header>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" data-tab="export" aria-selected="true">导出归档</button>
          <button type="button" role="tab" data-tab="import" aria-selected="false">导入关注</button>
        </div>
        <main>
          <section data-panel="export">
            <h3>导出设置</h3>
            <div class="grid">
              <div class="field"><label for="scope">范围</label><select id="scope"><option value="all">全部关注</option><option value="group">收藏分组</option><option value="pids">指定 PID</option><option value="date">日期范围</option></select></div>
              <div class="field conditional" data-for-scope="group" hidden><label for="bookmark">收藏分组</label><select id="bookmark"><option value="">正在加载分组…</option></select></div>
              <div class="field full conditional" data-for-scope="pids" hidden><label for="export-pids">PID（空格、逗号或换行分隔）</label><textarea id="export-pids" placeholder="123456 234567"></textarea></div>
              <div class="field conditional" data-for-scope="date" hidden><label for="start-date">开始日期</label><input id="start-date" type="date"></div>
              <div class="field conditional" data-for-scope="date" hidden><label for="end-date">结束日期</label><input id="end-date" type="date"></div>
              <div class="field"><label for="reference-mode">引用洞</label><select id="reference-mode"><option value="none">不抓取</option><option value="body">仅正文引用</option><option value="all">正文和评论引用</option></select></div>
            </div>
            <div class="checks"><label><input id="include-comments" type="checkbox" checked>包含评论</label><label><input id="include-readable" type="checkbox" checked>包含 readable.txt</label></div>
            <div class="actions"><button class="primary" type="button" data-action="export">开始导出</button></div>
            <div class="status-card">
              <h3>发送到 PkuHoleStudio</h3>
              <p class="message">先完成上方导出，再粘贴 Studio“归档导入”页生成的一次性配对码。这里只发送归档，不发送登录信息。</p>
              <div class="field"><label for="studio-pairing-code">一次性配对码</label><input id="studio-pairing-code" inputmode="text" autocomplete="off" placeholder="8080:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
              <div class="actions"><button type="button" data-action="send-studio" disabled>发送刚导出的归档</button></div>
            </div>
          </section>
          <section data-panel="import" hidden>
            <h3>导入关注</h3>
            <div class="field"><label for="archive-files">选择旧版 JSON 或 v2 ZIP</label><input id="archive-files" type="file" multiple accept=".json,.zip,.treehole.zip,application/json,application/zip"></div>
            <div class="actions"><button type="button" data-action="preview-import">解析并预检</button><button class="primary" type="button" data-action="execute-import" disabled>确认导入</button></div>
            <div class="preview" data-import-preview hidden></div>
          </section>
          <div class="status-card" aria-busy="false">
            <div class="status-line"><strong data-state>空闲</strong><span data-count>0 / 0</span></div>
            <progress value="0" max="1" aria-label="任务进度"></progress>
            <div class="actions"><button type="button" data-action="pause" disabled>暂停</button><button type="button" data-action="resume" disabled>继续</button><button class="danger" type="button" data-action="cancel" disabled>取消</button><button type="button" data-action="retry" disabled>仅重试失败项</button></div>
            <p class="message" role="status" aria-live="polite"></p>
          </div>
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
  let bookmarksLoaded = false;
  const mountedAt = Date.now();

  if (!entry) {
    entry = documentObject.createElement('button');
    entry.id = ENTRY_ID;
    entry.type = 'button';
    entry.textContent = '归档/迁移';
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
  const statusCard = $('.status-card');
  const statusLabel = $('[data-state]');
  const countLabel = $('[data-count]');
  const progress = $('progress');
  const message = $('.message');
  const pauseButton = $('[data-action="pause"]');
  const resumeButton = $('[data-action="resume"]');
  const cancelButton = $('[data-action="cancel"]');
  const retryButton = $('[data-action="retry"]');
  const importExecuteButton = $('[data-action="execute-import"]');

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

  function setRunning(running) {
    statusCard.setAttribute('aria-busy', String(running));
    pauseButton.disabled = !running;
    cancelButton.disabled = !running;
    resumeButton.disabled = running || !activeJobId;
    retryButton.disabled = running || !activeJobId;
    $('[data-action="export"]').disabled = running;
    $('[data-action="send-studio"]').disabled = running || !lastArchive;
    $('[data-action="preview-import"]').disabled = running;
    importExecuteButton.disabled =
      running ||
      !importPreview ||
      importPreview.remoteComplete !== true ||
      importPreview.newPids?.length === 0;
  }

  function handleProgress(event) {
    const total = Number(event.total || 0);
    const completed = Number(event.completed || event.count || 0);
    progress.max = Math.max(1, total);
    progress.value = Math.min(completed, progress.max);
    countLabel.textContent = `${completed} / ${total || '?'}`;
    if (event.state) statusLabel.textContent = event.state;
    if (event.pid) setMessage(`正在处理 #${event.pid}（${event.phase || ''}）`);
    else if (event.phase === 'archive_files') {
      setMessage(`正在解析归档文件：${completed} / ${total || '?'}…`);
    } else if (event.phase === 'remote_followed') {
      setMessage(`正在读取当前关注：${completed} / ${total || '?'}…`);
    }
  }

  async function ensureBookmarks() {
    if (bookmarksLoaded) return;
    const select = $('#bookmark');
    try {
      const bookmarks = await api.listBookmarks();
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
    } catch (error) {
      select.replaceChildren();
      const option = documentObject.createElement('option');
      option.value = '';
      option.textContent = '分组加载失败';
      select.append(option);
      setMessage(error.message, true);
    }
  }

  async function discoverResumableJob() {
    try {
      const credentials = await credentialsProvider();
      const jobs = (await store.listJobs())
        .filter(
          (job) =>
            job.accountFingerprint === credentials.accountFingerprint &&
            ['running', 'paused', 'partial'].includes(job.state),
        )
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
      const job = jobs[0];
      if (!job) return;
      activeJobId = job.id;
      activeKind = job.type;
      if (job.type === 'export') lastExportOptions = job.options;
      if (job.type === 'import') importPreview = job.preview;
      if (job.state === 'running') {
        job.state = 'paused';
        await store.putJob(job);
      }
      statusLabel.textContent = 'paused';
      countLabel.textContent = `${job.completed || 0} / ${job.total || '?'}`;
      setMessage(`发现可恢复的${job.type === 'export' ? '导出' : '导入'}任务。`);
      resumeButton.disabled = false;
      retryButton.disabled = false;
      importExecuteButton.disabled = !importPreview;
      if (importPreview?.remoteComplete !== true || importPreview?.newPids?.length === 0) {
        importExecuteButton.disabled = true;
      }
    } catch (error) {
      if (error.code !== ERROR_CODES.UNAUTHORIZED) console.warn('[PKU Hole Toolkit]', error);
    }
  }

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

  async function runExport(options, jobId = null) {
    setRunning(true);
    setMessage('正在规划导出范围…');
    statusLabel.textContent = 'planning';
    try {
      const credentials = await credentialsProvider();
      activeKind = 'export';
      activeJob = new ExportJob({
        api,
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
        confirmReferences: async (count) =>
          windowObject.confirm(`检测到 ${count} 个引用洞，是否继续抓取？`),
      });
      const result = await activeJob.run(options, { jobId });
      activeJobId = result.job.id;
      if (result.paused) {
        statusLabel.textContent = 'paused';
        setMessage('任务已暂停，可稍后继续。');
        return;
      }
      lastArchive = result.archive;
      downloadBlob(documentObject, result.archive.blob, result.archive.filename);
      statusLabel.textContent = result.job.state;
      countLabel.textContent = `${result.manifest.counts.exportedHoles} / ${result.manifest.counts.expectedHoles ?? '?'}`;
      setMessage(
        result.manifest.complete
          ? '导出完成。断点保留 7 天，可重新下载。'
          : `部分导出：${result.manifest.errors.length} 项失败，请查看 manifest 或重试。`,
        !result.manifest.complete,
      );
    } catch (error) {
      activeJobId = activeJobId || activeJob?.jobId || null;
      setMessage(error.message || '导出失败', true);
      statusLabel.textContent = error.code === ERROR_CODES.RATE_LIMITED ? 'paused' : 'failed';
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function previewImport() {
    const files = [...$('#archive-files').files];
    if (!files.length) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先选择归档文件');
    setRunning(true);
    statusLabel.textContent = 'previewing';
    countLabel.textContent = '0 / ?';
    progress.removeAttribute('value');
    setMessage('正在解析归档并读取当前关注列表；关注较多时可能需要几十秒…');
    try {
      const credentials = await credentialsProvider();
      activeKind = 'import';
      activeJob = new ImportJob({
        api,
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
      });
      importPreview = await activeJob.preview(files);
      const previewElement = $('[data-import-preview]');
      previewElement.hidden = false;
      previewElement.textContent = [
        `文件：${importPreview.archives.length}`,
        `唯一 PID：${importPreview.allPids.length}`,
        `将新增：${importPreview.newPids.length}`,
        `已关注：${importPreview.alreadyFollowed.length}`,
        `仅归档引用（不导入）：${importPreview.excludedReferenced}`,
        `重复：${importPreview.duplicateCount}`,
        `无效文件/记录：${importPreview.invalidFiles.length}`,
      ].join('\n');
      statusLabel.textContent = 'previewed';
      progress.max = 1;
      progress.value = 1;
      countLabel.textContent = `${importPreview.allPids.length} PID`;
      setMessage(
        importPreview.remoteComplete !== true
          ? '预检未完成：当前关注列表读取不完整，已禁止导入，请稍后重试。'
          : importPreview.newPids.length
          ? '预检完成。请核对数量后确认导入。'
          : '预检完成：所有 PID 均已关注，无需执行导入。',
        importPreview.remoteComplete !== true,
      );
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function executeImport(jobId = null) {
    if (!importPreview) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先执行预检');
    if (
      !windowObject.confirm(
        `将对当前账号新增关注 ${importPreview.newPids.length} 个洞。确认继续？`,
      )
    ) {
      return;
    }
    setRunning(true);
    try {
      const credentials = await credentialsProvider();
      activeKind = 'import';
      activeJob = new ImportJob({
        api,
        store,
        accountFingerprint: credentials.accountFingerprint,
        onProgress: handleProgress,
      });
      const result = await activeJob.execute(importPreview, { jobId });
      activeJobId = result.job.id;
      statusLabel.textContent = result.job.state;
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
          ? '导入已暂停。'
          : `导入结束：成功 ${result.audit.followed}，失败 ${result.audit.failed}，未知 ${result.audit.unknown}。`,
        !result.paused && (result.audit.failed > 0 || result.audit.unknown > 0),
      );
    } catch (error) {
      activeJobId = activeJobId || activeJob?.jobId || null;
      setMessage(error.message || '导入失败', true);
      statusLabel.textContent = error.code === ERROR_CODES.RATE_LIMITED ? 'paused' : 'failed';
    } finally {
      activeJob = null;
      setRunning(false);
    }
  }

  async function sendToStudio() {
    if (!lastArchive) throw new AppError(ERROR_CODES.INVALID_INPUT, '请先完成一次归档导出');
    const code = $('#studio-pairing-code').value.trim();
    if (!code) throw new AppError(ERROR_CODES.INVALID_INPUT, '请粘贴 Studio 生成的一次性配对码');
    setRunning(true);
    statusLabel.textContent = 'sending';
    setMessage('正在把归档发送到本机 Studio…');
    try {
      const result = await sendArchiveToStudio(code, lastArchive);
      statusLabel.textContent = 'awaiting_confirmation';
      setMessage(`发送成功：${result.preflight?.counts?.valid_items ?? '?'} 个有效帖子。请回到 Studio 确认导入。`);
      $('#studio-pairing-code').value = '';
    } catch (error) {
      statusLabel.textContent = 'failed';
      setMessage(error.message || '发送到 Studio 失败', true);
    } finally {
      setRunning(false);
    }
  }

  function openPanel() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    $('.close').focus();
    discoverResumableJob();
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
  });
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
  $('[data-action="send-studio"]').addEventListener('click', () =>
    sendToStudio().catch((error) => {
      statusLabel.textContent = 'failed';
      setMessage(error.message || '发送到 Studio 失败', true);
    }),
  );
  $('[data-action="preview-import"]').addEventListener('click', () =>
    previewImport().catch((error) => {
      statusLabel.textContent = error.code === ERROR_CODES.CANCELLED ? 'cancelled' : 'failed';
      setMessage(error.message, true);
    }),
  );
  importExecuteButton.addEventListener('click', () => executeImport());
  pauseButton.addEventListener('click', () => {
    activeJob?.requestPause();
    setMessage('将在当前洞处理完成后暂停…');
  });
  cancelButton.addEventListener('click', () => activeJob?.cancel());
  resumeButton.addEventListener('click', () => {
    if (activeKind === 'export') runExport(lastExportOptions, activeJobId);
    else if (activeKind === 'import') executeImport(activeJobId);
  });
  retryButton.addEventListener('click', () => {
    if (activeKind === 'export') runExport(lastExportOptions, activeJobId);
    else if (activeKind === 'import') executeImport(activeJobId);
  });

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
      observer.disconnect();
      entry.remove();
      host.remove();
    },
    reportError(error) {
      const record = toErrorRecord(error);
      openPanel();
      setMessage(record.message, true);
    },
  };
}
