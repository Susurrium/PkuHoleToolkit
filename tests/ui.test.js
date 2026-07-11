import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('UI bootstrap does not overwrite host onload and uses an idempotent entry id', async () => {
  const ui = await readFile(new URL('../apps/userscript/src/ui.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../apps/userscript/src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(`${ui}\n${main}`, /window\.onload\s*=/);
  assert.match(ui, /pku-hole-toolkit-entry/);
  assert.match(ui, /MutationObserver/);
  assert.match(ui, /aria-live/);
});
