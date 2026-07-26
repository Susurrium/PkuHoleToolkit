import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  deliverArchiveToDestinations,
  ensureEntryBeforeAnchor,
  normalizeArchiveDestinations,
  readArchiveDestinations,
  writeArchiveDestinations,
} from '../apps/userscript/src/ui.js';

test('entry placement is idempotent and follows a replaced toolbar anchor', () => {
  const entry = { parentNode: null, nextSibling: null };
  let pendingMutationCallbacks = 0;
  const createAnchor = () => {
    const parent = {
      insertions: 0,
      insertBefore(node, reference) {
        this.insertions += 1;
        pendingMutationCallbacks += 1;
        node.parentNode = this;
        node.nextSibling = reference;
      },
    };
    return { anchor: { parentNode: parent }, parent };
  };

  const first = createAnchor();
  assert.equal(ensureEntryBeforeAnchor(entry, first.anchor), true);
  assert.equal(first.parent.insertions, 1);
  let observerCallbacks = 0;
  while (pendingMutationCallbacks > 0) {
    pendingMutationCallbacks -= 1;
    observerCallbacks += 1;
    assert.ok(observerCallbacks < 10, 'entry placement fed an observer loop');
    assert.equal(ensureEntryBeforeAnchor(entry, first.anchor), false);
  }
  assert.equal(observerCallbacks, 1);
  assert.equal(first.parent.insertions, 1);

  const replacement = createAnchor();
  assert.equal(ensureEntryBeforeAnchor(entry, replacement.anchor), true);
  assert.equal(replacement.parent.insertions, 1);
});

test('UI bootstrap does not overwrite host onload and uses an idempotent entry id', async () => {
  const ui = await readFile(new URL('../apps/userscript/src/ui.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../apps/userscript/src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(`${ui}\n${main}`, /window\.onload\s*=/);
  assert.match(ui, /pku-hole-toolkit-entry/);
  assert.match(ui, /MutationObserver/);
  assert.match(ui, /aria-live/);
});

test('archive delivery preferences default to local download and persist both destinations', () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };

  assert.deepEqual(readArchiveDestinations(storage), { download: true, studio: false });
  assert.deepEqual(writeArchiveDestinations(storage, { download: true, studio: true }), {
    download: true,
    studio: true,
  });
  assert.deepEqual(readArchiveDestinations(storage), { download: true, studio: true });
  assert.deepEqual(normalizeArchiveDestinations({ download: false, studio: true }), {
    download: false,
    studio: true,
  });
});

test('archive delivery preferences fail safely when browser storage is unavailable', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };

  assert.deepEqual(readArchiveDestinations(blocked), { download: true, studio: false });
  assert.doesNotThrow(() => writeArchiveDestinations(blocked, { download: false, studio: true }));
});

test('one generated archive can be downloaded and sent to Studio without being rebuilt', async () => {
  const archive = { filename: 'one.treehole.zip', bytes: new Uint8Array([1, 2, 3]) };
  const delivered = [];
  const result = await deliverArchiveToDestinations({
    archive,
    destinations: { download: true, studio: true },
    studioConnected: true,
    downloadArchive(value) {
      delivered.push(['download', value]);
    },
    async sendArchiveToStudio(value) {
      delivered.push(['studio', value]);
      return { preflight: { counts: { valid_items: 2 } } };
    },
  });

  assert.deepEqual(delivered, [
    ['download', archive],
    ['studio', archive],
  ]);
  assert.equal(result.download, 'started');
  assert.equal(result.studio, 'awaiting_confirmation');
  assert.equal(result.studioResult.preflight.counts.valid_items, 2);
});

test('a Studio delivery failure does not undo a completed local download', async () => {
  let downloaded = 0;
  const result = await deliverArchiveToDestinations({
    archive: { filename: 'safe.treehole.zip' },
    destinations: { download: true, studio: true },
    studioConnected: true,
    downloadArchive() {
      downloaded += 1;
    },
    async sendArchiveToStudio() {
      throw new Error('Studio unavailable');
    },
  });

  assert.equal(downloaded, 1);
  assert.equal(result.download, 'started');
  assert.equal(result.studio, 'failed');
  assert.match(result.studioError.message, /unavailable/);
});
