import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
const windowsNode = process.argv[3] === '--windows-node' ? process.argv[4] : process.platform === 'win32' ? process.execPath : undefined;
if (!target || !path.isAbsolute(target) || path.basename(target) !== 'sub2sub' || (process.argv[3] !== undefined && (process.argv[3] !== '--windows-node' || !windowsNode || process.argv.length !== 5))) throw new Error('Usage: node scripts/package.mjs /absolute/new/directory/sub2sub [--windows-node C:\\path\\node.exe]');
if (windowsNode && (!path.win32.isAbsolute(windowsNode) || !/\.exe$/i.test(windowsNode))) throw new Error('--windows-node must be the absolute Windows Node.js executable path.');
await fs.mkdir(target, { recursive: false, mode: 0o700 });
for (const name of ['.codex-plugin', '.mcp.json', 'package.json', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'config.example.json', 'bin', 'lib', 'skills']) {
  await fs.cp(path.join(root, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
}
if (windowsNode) {
  const manifest = JSON.parse(await fs.readFile(path.join(target, '.mcp.json'), 'utf8'));
  Object.assign(manifest.mcpServers.sub2sub, { command: windowsNode, args: ['./bin/mcp.mjs'] });
  manifest.mcpServers.sub2sub.env_vars.push('USERPROFILE', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP');
  await fs.writeFile(path.join(target, '.mcp.json'), JSON.stringify(manifest, null, 2) + '\n');
}
await fs.mkdir(path.join(target, 'scripts'));
await fs.copyFile(path.join(root, 'scripts/setup-check.mjs'), path.join(target, 'scripts/setup-check.mjs'));
await fs.mkdir(path.join(target, 'docs'));
for (const name of ['install.md', 'install.en.md', 'usage.md', 'usage.en.md', 'architecture.md', 'troubleshooting.md', 'troubleshooting.en.md', 'validation.md']) {
  await fs.copyFile(path.join(root, 'docs', name), path.join(target, 'docs', name));
}
await fs.cp(path.join(root, 'docs/assets'), path.join(target, 'docs/assets'), { recursive: true, errorOnExist: true, force: false });
process.stdout.write(JSON.stringify({ pluginDirectory: target, checkArguments: windowsNode ? [windowsNode, './scripts/setup-check.mjs'] : ['/bin/sh', path.join(target, 'bin/launch.sh'), '--check'], note: 'Package prepared. No Codex configuration, marketplace, credentials or task data were modified or included.' }) + '\n');
