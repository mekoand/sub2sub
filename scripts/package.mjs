import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyTailcat } from '../lib/tailcat.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
const options = {};
for (let i = 3; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1];
  if (!['--windows-node', '--tailcat-dir'].includes(name) || !value || options[name]) throw new Error('Expected --windows-node <path> or --tailcat-dir <directory>.');
  options[name] = value;
}
const windowsNode = options['--windows-node'] || (process.platform === 'win32' ? process.execPath : undefined);
if (!target || !path.isAbsolute(target) || path.basename(target) !== 'sub2sub') throw new Error('Target must be an absolute new directory named sub2sub.');
const tailcatDirectory = options['--tailcat-dir'];
const tailcat = tailcatDirectory ? await verifyTailcat(tailcatDirectory, { manifest: 'manifest.json' }) : undefined;
if (windowsNode && (!path.win32.isAbsolute(windowsNode) || !/\.exe$/i.test(windowsNode))) throw new Error('--windows-node must be the absolute Windows Node.js executable path.');
await fs.mkdir(target, { recursive: false, mode: 0o700 });
for (const name of ['.codex-plugin', '.mcp.json', 'package.json', 'package-lock.json', 'node_modules', 'README.md', 'README.zh-CN.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'config.example.json', 'bin', 'lib', 'web', 'skills', 'install.sh', 'install.ps1']) {
  await fs.cp(path.join(root, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false,
    filter: source => !(path.dirname(source) === path.join(root, 'bin') && ['sub2sub-tailcat', 'sub2sub-tailcat.exe', 'tailcat.json'].includes(path.basename(source))) && !(path.dirname(source) === path.join(root, 'node_modules', '@anthropic-ai') && path.basename(source).startsWith('claude-agent-sdk-'))
  });
}
if (tailcat) {
  await fs.copyFile(path.join(tailcatDirectory, tailcat.file), path.join(target, 'bin', tailcat.file));
  await fs.chmod(path.join(target, 'bin', tailcat.file), 0o755);
  await fs.copyFile(path.join(tailcatDirectory, 'manifest.json'), path.join(target, 'bin/tailcat.json'));
  await fs.cp(path.join(tailcatDirectory, 'licenses'), path.join(target, 'licenses/tailcat'), { recursive: true });
}
if (windowsNode) {
  const manifest = JSON.parse(await fs.readFile(path.join(target, '.mcp.json'), 'utf8'));
  Object.assign(manifest.mcpServers.sub2sub, { command: windowsNode, args: ['./bin/mcp.mjs'] });
  manifest.mcpServers.sub2sub.env_vars.push('USERPROFILE', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP');
  await fs.writeFile(path.join(target, '.mcp.json'), JSON.stringify(manifest, null, 2) + '\n');
}
await fs.mkdir(path.join(target, 'scripts'));
for (const name of ['setup-check.mjs', 'install.mjs']) await fs.copyFile(path.join(root, 'scripts', name), path.join(target, 'scripts', name));
await fs.mkdir(path.join(target, 'docs'));
for (const name of ['install.md', 'install.en.md', 'usage.md', 'usage.en.md', 'architecture.md', 'troubleshooting.md', 'troubleshooting.en.md', 'validation.md', 'development.md']) {
  await fs.copyFile(path.join(root, 'docs', name), path.join(target, 'docs', name));
}
await fs.cp(path.join(root, 'docs/assets'), path.join(target, 'docs/assets'), { recursive: true, errorOnExist: true, force: false });
process.stdout.write(JSON.stringify({ pluginDirectory: target, checkArguments: windowsNode ? [windowsNode, './scripts/setup-check.mjs'] : ['/bin/sh', path.join(target, 'bin/launch.sh'), '--check'], note: 'Package prepared. No Codex configuration, marketplace, credentials or task data were modified or included.' }) + '\n');
