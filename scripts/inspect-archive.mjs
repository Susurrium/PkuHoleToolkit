import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseArchiveBytes } from '../apps/userscript/src/archive.js';

const archivePath = process.argv[2];
const expectedArgument = process.argv.find((argument) => argument.startsWith('--expected='));
const expectedHoles = expectedArgument ? Number(expectedArgument.slice('--expected='.length)) : null;

if (!archivePath) {
  console.error('Usage: npm run inspect:archive -- <archive> [--expected=<count>]');
  process.exitCode = 2;
} else if (expectedHoles !== null && (!Number.isInteger(expectedHoles) || expectedHoles < 0)) {
  console.error('--expected must be a non-negative integer');
  process.exitCode = 2;
} else {
  const bytes = new Uint8Array(await readFile(resolve(archivePath)));
  const archive = parseArchiveBytes(bytes, archivePath);
  const items = archive.data.items;
  const manifestCounts = archive.manifest.counts || {};
  const commentCount = items.reduce((total, item) => total + item.comments.length, 0);
  const uniquePids = new Set(items.map((item) => String(item.pid)));
  const sensitivePaths = [];
  const sensitiveKeyPattern = /token|authorization|cookie|uuid/i;

  const scan = (value, path = '$', seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = `${path}.${key}`;
      if (sensitiveKeyPattern.test(key)) sensitivePaths.push(nestedPath);
      scan(nested, nestedPath, seen);
    }
  };

  scan(archive);

  const errors = [];
  if (uniquePids.size !== items.length) errors.push('archive contains duplicate PIDs');
  if (manifestCounts.exportedHoles !== items.length) {
    errors.push('manifest exportedHoles does not match data.items');
  }
  if (manifestCounts.comments !== undefined && manifestCounts.comments !== commentCount) {
    errors.push('manifest comments does not match exported comments');
  }
  if (expectedHoles !== null && items.length !== expectedHoles) {
    errors.push(`expected ${expectedHoles} holes but found ${items.length}`);
  }
  if (sensitivePaths.length) errors.push('archive contains sensitive-looking keys');

  console.log(
    JSON.stringify(
      {
        valid: errors.length === 0,
        format: archive.format,
        schemaVersion: archive.manifest.schemaVersion,
        toolVersion: archive.manifest.toolVersion,
        complete: archive.manifest.complete,
        expectedHoles: manifestCounts.expectedHoles ?? null,
        exportedHoles: items.length,
        comments: commentCount,
        failed: manifestCounts.failed ?? archive.manifest.errors?.length ?? 0,
        uniquePids: uniquePids.size,
        sensitiveKeyCount: sensitivePaths.length,
        errors,
      },
      null,
      2,
    ),
  );

  if (errors.length) process.exitCode = 1;
}
