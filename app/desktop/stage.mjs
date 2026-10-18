// Copies the web app (index.html, assets) next to main.cjs into ./stage so Electron can package it.
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const stage = join(here, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'app'), { recursive: true });
cpSync(join(root, 'index.html'), join(stage, 'app', 'index.html'));
cpSync(join(root, 'assets'), join(stage, 'app', 'assets'), {
  recursive: true,
  filter: (src) => !/preview[^/]*\.png$|\.blend$|\.DS_Store$/.test(src),
});
for (const name of ['사용안내.md']) if (existsSync(join(root, name))) cpSync(join(root, name), join(stage, 'app', name));
cpSync(join(here, 'main.cjs'), join(stage, 'main.cjs'));
cpSync(join(here, 'icon.png'), join(stage, 'icon.png'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'twin-reservoir-lab',
  productName: 'TWIN Reservoir Lab',
  version: '1.6.1',
  private: true,
  main: 'main.cjs',
}, null, 2));
console.log('staged', stage);
