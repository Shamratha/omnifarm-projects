import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = ['server.mjs'];
for (const directory of ['public', 'src', 'test', 'scripts']) {
  for (const name of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (/\.(mjs|js)$/.test(name)) paths.push(`${directory}/${name}`);
  }
}
for (const path of paths) {
  const result = spawnSync(process.execPath, ['--check', path], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checks passed for ${paths.length} JavaScript modules.`);
