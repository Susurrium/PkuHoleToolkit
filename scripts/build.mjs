import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

const metadata = `// ==UserScript==
// @name         PKU-Hole export tool
// @name:zh-CN   北大树洞归档与关注迁移工具
// @author       WindMan, Susurrium
// @namespace    https://github.com/Susurrium/PkuHoleToolkit
// @version      ${packageJson.version}
// @license      MIT
// @description  安全、可恢复地导入/导出北大树洞关注列表
// @match        https://treehole.pku.edu.cn/web/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-end
// @homepageURL  https://github.com/Susurrium/PkuHoleToolkit
// @supportURL   https://github.com/Susurrium/PkuHoleToolkit/issues
// ==/UserScript==

// GENERATED FILE. Edit apps/userscript/src instead of this bundle.
`;

const modules = [
  'config.js',
  'errors.js',
  'credentials.js',
  'scheduler.js',
  'api.js',
  'zip.js',
  'archive.js',
  'studio-bridge.js',
  'storage.js',
  'export-job.js',
  'import-job.js',
  'ui.js',
  'main.js',
];

const sourceRoot = new URL('../apps/userscript/src/', import.meta.url);
const chunks = [];

for (const moduleName of modules) {
  let source = await readFile(new URL(moduleName, sourceRoot), 'utf8');
  source = source
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function|class|const|let|var)/gm, '');
  chunks.push(`\n// ---- ${moduleName} ----\n${source.trim()}\n`);
}

const bundle = `${metadata}\n(() => {\n  'use strict';\n${chunks.join('\n')}\n})();\n`;
await writeFile(
  fileURLToPath(new URL('../PKU-Hole export tool.user.js', import.meta.url)),
  bundle,
  'utf8',
);
