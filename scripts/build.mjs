import { copyFile, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

const files = [
  'config.js',
  'README.md',
  'robots.txt',
  'site.webmanifest',
];

const dirs = [
  'assets',
];

async function assertExists(path) {
  await stat(join(root, path));
}

await Promise.all([...files, ...dirs].map(assertExists));
await mkdir(dist, { recursive: true });

for (const file of files) {
  await copyFile(join(root, file), join(dist, file));
}

await mkdir(join(dist, 'css'), { recursive: true });
await copyFile(join(root, 'css', 'legal.css'), join(dist, 'css', 'legal.css'));

for (const dir of dirs) {
  const from = join(root, dir);
  const to = join(dist, dir);
  await cp(from, to, { recursive: true });
}

await writeFile(join(dist, '.nojekyll'), '');

const count = (await readdir(dist, { recursive: true })).length;
console.log(`Finalized dist with ${count} entries.`);
