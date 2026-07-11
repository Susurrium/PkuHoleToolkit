import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseArchiveBytes } from '../apps/userscript/src/archive.js';

const archivePath = process.argv[2];
const expectedArgument = process.argv.find((argument) => argument.startsWith('--expected='));
const expectedFollowedArgument = process.argv.find((argument) =>
  argument.startsWith('--expected-followed='),
);
const expectedHoles = expectedArgument ? Number(expectedArgument.slice('--expected='.length)) : null;
const expectedFollowed = expectedFollowedArgument
  ? Number(expectedFollowedArgument.slice('--expected-followed='.length))
  : null;

if (!archivePath) {
  console.error(
    'Usage: npm run inspect:archive -- <archive> [--expected=<count>] [--expected-followed=<count>]',
  );
  process.exitCode = 2;
} else if (
  [expectedHoles, expectedFollowed].some(
    (value) => value !== null && (!Number.isInteger(value) || value < 0),
  )
) {
  console.error('--expected and --expected-followed must be non-negative integers');
  process.exitCode = 2;
} else {
  const bytes = new Uint8Array(await readFile(resolve(archivePath)));
  const archive = parseArchiveBytes(bytes, archivePath);
  const items = archive.data.items;
  const manifestCounts = archive.manifest.counts || {};
  const commentCount = items.reduce((total, item) => total + item.comments.length, 0);
  const uniquePids = new Set(items.map((item) => String(item.pid)));
  const sourceCounts = items.reduce((counts, item) => {
    counts[item.source] = (counts[item.source] || 0) + 1;
    return counts;
  }, {});
  const sensitivePaths = [];
  const sensitiveKeyPattern = /token|authorization|cookie|uuid|accountFingerprint/i;

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
  if (expectedFollowed !== null && (sourceCounts.followed || 0) !== expectedFollowed) {
    errors.push(
      `expected ${expectedFollowed} followed holes but found ${sourceCounts.followed || 0}`,
    );
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
        sourceCounts,
        sensitiveKeyCount: sensitivePaths.length,
        errors,
      },
      null,
      2,
    ),
  );

  if (errors.length) process.exitCode = 1;
}
