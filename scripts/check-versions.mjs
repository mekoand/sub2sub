import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFile(path.join(root, name), 'utf8');
const version = JSON.parse(await read('package.json')).version;
const mismatches = [];
const expect = (label, actual) => {
  if (actual !== version) mismatches.push(`${label}: found ${actual ?? '(missing)'}, expected ${version}`);
};

if (!/^\d+\.\d+\.\d+$/.test(version)) mismatches.push(`package.json version is not x.y.z: ${version}`);

expect('.codex-plugin/plugin.json version', JSON.parse(await read('.codex-plugin/plugin.json')).version);

const installSh = await read('install.sh');
expect('install.sh default SUB2SUB_VERSION', installSh.match(/version=\$\{SUB2SUB_VERSION:-([^}]+)\}/)?.[1]);

const installPs1 = await read('install.ps1');
expect('install.ps1 default version', installPs1.match(/else \{ '([^']+)' \}/)?.[1]);

for (const name of ['README.md', 'README.en.md', 'README.zh-CN.md']) {
  const badges = [...(await read(name)).matchAll(/badge\/version-([0-9.]+)-/g)].map(match => match[1]);
  if (badges.length !== 1) mismatches.push(`${name}: expected one version badge, found ${badges.length}`);
  else expect(`${name} version badge`, badges[0]);
}

if (mismatches.length) {
  process.stderr.write(`Version check failed. package.json is ${version}.\n`);
  for (const line of mismatches) process.stderr.write(`- ${line}\n`);
  process.stderr.write('Align package.json, .codex-plugin/plugin.json, install.sh, install.ps1, and the README version badges.\n');
  process.exit(1);
}
