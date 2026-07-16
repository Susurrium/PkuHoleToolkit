import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createArchive, createManifest } from '../apps/userscript/src/archive.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.resolve(projectRoot, '..', 'PkuHoleArchiveSpec', 'fixtures', 'v2', 'archives', 'valid', 'toolkit-base.treehole.zip');
const output = path.resolve(process.env.PKUHOLE_ARCHIVE_FIXTURE_OUTPUT || defaultOutput);
const items = [{
  pid: '123456',
  source: 'followed',
  fetchStatus: 'ok',
  hole: { pid: 123456, text: 'Toolkit contract fixture', timestamp: 1784131200, type: 'text' },
  comments: [{ cid: 1001, pid: 123456, text: 'portable comment', timestamp: 1784131260 }],
}];
const manifest = createManifest({
  runId: 'toolkit-golden-v2',
  scope: { type: 'pids', pids: ['123456'] },
  complete: true,
  items,
  expectedHoles: 1,
  exportedAt: '2026-07-16T00:00:00Z',
});
const archive = createArchive({ manifest, items, includeReadable: true });

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, archive.bytes);
console.log(`Wrote Toolkit Archive Contract fixture to ${output}`);
