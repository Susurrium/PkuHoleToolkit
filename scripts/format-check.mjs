import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['apps', 'packages', 'scripts', 'tests'];
const failures = [];

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (['.js', '.mjs', '.json', '.md'].includes(extname(path))) {
      const content = await readFile(path, 'utf8');
      if (/\r/.test(content)) failures.push(`${path}: must use LF line endings`);
      if (/[ \t]+$/m.test(content)) failures.push(`${path}: has trailing whitespace`);
      if (!content.endsWith('\n')) failures.push(`${path}: must end with a newline`);
    }
  }
}

for (const root of roots) {
  try {
    await check(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Formatting invariants satisfied.');
