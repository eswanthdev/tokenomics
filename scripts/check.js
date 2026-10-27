import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const dir of ['src', 'public', 'test', 'scripts'])
  for (const name of await readdir(new URL(`../${dir}/`, import.meta.url)))
    if (name.endsWith('.js')) {
      const result = spawnSync(
        process.execPath,
        ['--check', fileURLToPath(new URL(`../${dir}/${name}`, import.meta.url))],
        { stdio: 'inherit' },
      );
      if (result.status) process.exit(result.status);
    }
console.log('Syntax checks passed for every source, UI, test and script file.');
