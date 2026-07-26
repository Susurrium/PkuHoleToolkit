import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_SPEC_VERSION,
  createManifest,
  parseArchiveBytes,
} from '../apps/userscript/src/archive.js';
import { createZip } from '../apps/userscript/src/zip.js';

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/archive-schema/fixtures/v2',
);
const producerArchiveRoot = path.join(fixtureRoot, 'archives', 'valid');

async function fixtures(expectation) {
  const directory = path.join(fixtureRoot, expectation);
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(async (name) => ({ name, value: JSON.parse(await readFile(path.join(directory, name), 'utf8')) })),
  );
}

function fixtureArchive(fixture) {
  return createZip({
    'manifest.json': `${JSON.stringify(fixture.manifest)}\n`,
    'data.json': `${JSON.stringify(fixture.data)}\n`,
  });
}

test('Toolkit accepts every vendored valid Archive Contract fixture', async () => {
  for (const fixture of await fixtures('valid')) {
    assert.doesNotThrow(() => parseArchiveBytes(fixtureArchive(fixture.value)), fixture.name);
  }
});

test('Toolkit rejects every vendored invalid Archive Contract fixture', async () => {
  for (const fixture of await fixtures('invalid')) {
    assert.throws(() => parseArchiveBytes(fixtureArchive(fixture.value)), undefined, fixture.name);
  }
});

test('Toolkit reads real Toolkit and Studio producer archives', async () => {
  const names = (await readdir(producerArchiveRoot)).filter((name) => name.endsWith('.treehole.zip')).sort();
  assert.deepEqual(names, ['studio-media.treehole.zip', 'toolkit-base.treehole.zip']);
  for (const name of names) {
    const parsed = parseArchiveBytes(new Uint8Array(await readFile(path.join(producerArchiveRoot, name))), name);
    const expectedProducer = name.startsWith('studio-') ? 'PkuHoleStudio' : 'PkuHoleToolkit';
    assert.equal(parsed.manifest.producer.name, expectedProducer, name);
    assert.equal(parsed.data.items.length, 1, name);
  }
});

test('Toolkit writes v2.1 producer metadata and a direct portable scope', () => {
  const manifest = createManifest({
    runId: 'contract-writer',
    scope: {
      scope: { type: 'pids', pids: ['123456'] },
      includeComments: true,
      includeReadable: false,
      referenceMode: 'body',
    },
    complete: true,
    items: [],
    exportedAt: '2026-07-16T00:00:00Z',
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.specVersion, ARCHIVE_SPEC_VERSION);
  assert.deepEqual(manifest.producer, { name: 'PkuHoleToolkit', version: '1.4.0' });
  assert.deepEqual(manifest.scope, { type: 'pids', pids: ['123456'] });
  assert.equal(manifest.exportOptions.referenceMode, 'body');
});

test('Toolkit rejects an unknown required extension', () => {
  const manifest = createManifest({
    runId: 'required-extension',
    scope: { type: 'all' },
    complete: true,
    items: [],
    exportedAt: '2026-07-16T00:00:00Z',
  });
  manifest.requiredExtensions = ['example.future.feature'];
  assert.throws(() =>
    parseArchiveBytes(
      createZip({
        'manifest.json': JSON.stringify(manifest),
        'data.json': JSON.stringify({ items: [] }),
      }),
    ),
  );
});

test('Toolkit reads Studio-shaped archives with optional media without runtime coupling', () => {
  const hash = 'a'.repeat(64);
  const manifest = createManifest({
    runId: 'studio-media-contract',
    scope: { type: 'all' },
    complete: true,
    items: [],
    exportedAt: '2026-07-16T00:00:00Z',
  });
  manifest.producer = { name: 'PkuHoleStudio', version: 'development' };
  manifest.extensions = {
    'io.github.susurrium.pkuhole.media': { version: 1, required: false },
    'io.github.susurrium.pkuhole.studio-sources': { version: 1, required: false },
  };
  manifest.counts = { ...manifest.counts, expectedHoles: 1, exportedHoles: 1, media: 1 };
  const data = {
    items: [{
      pid: '123456',
      source: 'explicit',
      fetchStatus: 'ok',
      hole: { pid: 123456, type: 'image' },
      comments: [],
      studioSources: [{ source: 'followed', sourceRef: 'studio-follow', contextOnly: false }],
    }],
  };
  const parsed = parseArchiveBytes(createZip({
    'manifest.json': JSON.stringify(manifest),
    'data.json': JSON.stringify(data),
    'media/index.json': JSON.stringify([{ ownerType: 'post', ownerId: 123456, hash, path: `media/${hash}.jpg`, status: 'available' }]),
    [`media/${hash}.jpg`]: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  }));
  assert.equal(parsed.manifest.producer.name, 'PkuHoleStudio');
  assert.equal(parsed.data.items[0].studioSources[0].sourceRef, 'studio-follow');
});
