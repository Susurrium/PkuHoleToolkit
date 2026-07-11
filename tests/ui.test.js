import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { ensureEntryBeforeAnchor } from '../apps/userscript/src/ui.js';

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
