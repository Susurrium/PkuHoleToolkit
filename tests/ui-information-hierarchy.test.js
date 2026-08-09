import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const uiSource = await readFile(new URL('../apps/userscript/src/ui.js', import.meta.url), 'utf8');
const fixtureHtml = await readFile(new URL('./fixtures/smoke.html', import.meta.url), 'utf8');
const fixtureHarness = await readFile(
  new URL('./fixtures/smoke-harness.js', import.meta.url),
  'utf8',
);

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function openingTag(source, attribute, value = null) {
  const attributePattern = value === null
    ? `\\b${escapePattern(attribute)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'))?`
    : `\\b${escapePattern(attribute)}\\s*=\\s*(?:"${escapePattern(value)}"|'${escapePattern(value)}')`;
  const match = source.match(new RegExp(`<([a-z][a-z0-9-]*)\\b(?=[^>]*${attributePattern})[^>]*>`, 'i'));
  assert.ok(match, `missing element with ${attribute}${value === null ? '' : `=${value}`}`);
  return { name: match[1].toLowerCase(), source: match[0] };
}

function hasBooleanAttribute(tag, attribute) {
  return new RegExp(`(?:^|\\s)${escapePattern(attribute)}(?:\\s|=|>)`, 'i').test(tag);
}

test('the default surface exposes export first and keeps import inactive', () => {
  const exportTab = openingTag(uiSource, 'data-tab', 'export').source;
  const importTab = openingTag(uiSource, 'data-tab', 'import').source;
  const exportPanel = openingTag(uiSource, 'data-panel', 'export').source;
  const importPanel = openingTag(uiSource, 'data-panel', 'import').source;

  assert.match(exportTab, /aria-selected\s*=\s*["']true["']/i);
  assert.match(importTab, /aria-selected\s*=\s*["']false["']/i);
  assert.equal(hasBooleanAttribute(exportPanel, 'hidden'), false);
  assert.equal(hasBooleanAttribute(importPanel, 'hidden'), true);
});

test('optional and transient surfaces use progressive disclosure', () => {
  const studio = openingTag(uiSource, 'data-studio-section');
  const task = openingTag(uiSource, 'data-task-card').source;
  const recentExport = openingTag(uiSource, 'data-recent-export').source;
  const importPreview = openingTag(uiSource, 'data-import-preview').source;

  assert.equal(studio.name, 'details');
  assert.equal(hasBooleanAttribute(studio.source, 'open'), false);
  assert.equal(hasBooleanAttribute(task, 'hidden'), true);
  assert.equal(hasBooleanAttribute(recentExport, 'hidden'), true);
  assert.equal(hasBooleanAttribute(importPreview, 'hidden'), true);

  const studioStart = uiSource.indexOf(studio.source);
  const importPanelStart = uiSource.indexOf('data-panel="import"');
  const studioDestination = uiSource.indexOf('id="delivery-studio"');
  assert.ok(
    studioDestination > studioStart && studioDestination < importPanelStart,
    'Studio delivery belongs to the optional Studio section',
  );
});

test('local download is the safe default and import writing starts disabled', () => {
  assert.match(
    uiSource,
    /normalizeArchiveDestinations[\s\S]*?return\s*\{\s*download:\s*true,\s*studio:\s*false\s*\}/,
  );
  const executeImport = openingTag(uiSource, 'data-action', 'execute-import').source;
  assert.equal(hasBooleanAttribute(executeImport, 'disabled'), true);

  const previewIndex = uiSource.indexOf('data-action="preview-import"');
  const executeIndex = uiSource.indexOf('data-action="execute-import"');
  assert.ok(previewIndex >= 0 && executeIndex > previewIndex, 'preview must precede import execution');
});

test('task progress remains an accessible live region when it becomes visible', () => {
  const task = openingTag(uiSource, 'data-task-card').source;
  const liveStatus = openingTag(uiSource, 'role', 'status').source;
  assert.match(task, /aria-busy\s*=\s*["']false["']/i);
  assert.match(uiSource, /<progress\b[^>]*aria-label\s*=\s*["'][^"']+["'][^>]*>/i);
  assert.match(liveStatus, /aria-live\s*=\s*["']polite["']/i);
});

test('the browser fixture documents isolated UI states and blocks external writes', () => {
  assert.match(fixtureHtml, /smoke-harness\.js/);
  for (const scenario of ['default', 'paired', 'running', 'import-preview']) {
    assert.match(fixtureHtml, new RegExp(`data-fixture-scenario=["']${scenario}["']`));
  }
  assert.match(fixtureHarness, /globalThis\.fetch\s*=/);
  assert.match(fixtureHarness, /apps\/userscript\/src\/main\.js/);
  assert.match(fixtureHarness, /PKU-Hole%20export%20tool\.user\.js/);
  assert.match(fixtureHarness, /method\s*!==\s*['"]GET['"]/);
  assert.match(fixtureHarness, /globalThis\.GM_xmlhttpRequest\s*=/);
  assert.match(fixtureHarness, /globalThis\.confirm\s*=\s*\(\)\s*=>\s*false/);
  assert.match(fixtureHarness, /\.dataset\.fixtureReady\s*=\s*scenario/);
});
