import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['apps', 'packages', 'scripts', 'tests'];
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (['.js', '.mjs'].includes(extname(path))) files.push(path);
  }
}

for (const root of roots) {
  try {
    await collect(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${file}\n${result.stderr}`);
  const content = await readFile(file, 'utf8');
  if (/\beval\s*\(/.test(content) || /new\s+Function\s*\(/.test(content)) {
    failures.push(`${file}\nDynamic code execution is not allowed.`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Checked ${files.length} JavaScript files.`);
