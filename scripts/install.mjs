import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Config, codexExecutable } from '../lib/config.mjs';
import { processLock } from '../lib/lock.mjs';

const exec = promisify(execFile);
const marketplaceName = 'sub2sub';
const pluginId = 'sub2sub@sub2sub';
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function findCodex(config) {
  try { return await codexExecutable(config); }
  catch (error) {
    if (process.platform !== 'win32' || config.provider?.codexPath || process.env.SUB2SUB_CODEX) throw error;
  }
  // npm launchers are not native executables. Search only known installation roots.
  const roots = [
    path.join(os.homedir(), '.local', 'bin'),
    ...[process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), ...(process.env.PATH || '').split(path.delimiter)]
      .filter(Boolean).map(directory => path.join(directory.replace(/^"(.*)"$/, '$1'), 'node_modules', '@openai'))
  ];
  const candidates = [];
  async function search(directory, depth = 0) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === 'codex.exe') candidates.push(file);
      else if (entry.isDirectory() && depth < 7) await search(file, depth + 1);
    }
  }
  for (const directory of new Set(roots)) await search(directory);
  if (!candidates.length) {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', "Get-AppxPackage | Where-Object { $_.Name -in @('OpenAI.Codex','OpenAI.ChatGPT') } | ForEach-Object { $_.InstallLocation }"], { windowsHide: true, timeout: 30000 });
    for (const directory of stdout.trim().split(/\r?\n/).filter(Boolean)) await search(directory);
  }
  const failures = [];
  for (const candidate of candidates) {
    try { await exec(candidate, ['--version'], { windowsHide: true, timeout: 10000 }); return candidate; }
    catch (error) { failures.push(`${candidate}: ${error.message}`); }
  }
  throw new Error(`Codex was not found or could not start. Install/open Codex first, or set SUB2SUB_CODEX to the native codex.exe. ${failures.join('\n')}`);
}

export async function install(payload, root, log = console.log) {
  payload = path.resolve(payload); root = path.resolve(root);
  const release = await json(path.join(payload, 'release.json'));
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || release.platform !== process.platform || release.arch !== process.arch) throw new Error('This release does not match this operating system and architecture.');
  const configFile = process.env.SUB2SUB_CONFIG || path.join(os.homedir(), '.config/sub2sub/config.json');
  const config = await new Config(configFile).read();
  const codex = await findCodex(config);
  const run = async args => {
    try { return (await exec(codex, args, { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch (error) { throw new Error(`Codex ${args.join(' ')} failed: ${error.stderr || error.message}`, { cause: error }); }
  };
  await run(['plugin', 'add', '--help']);
  await fs.mkdir(root, { recursive: true });
  const unlock = await processLock(path.join(root, 'install'));
  try {
    const marketplaceFile = path.join(root, '.agents/plugins/marketplace.json');
    const previous = await readOptional(marketplaceFile);
    if (previous !== undefined && JSON.parse(previous).name !== marketplaceName) throw new Error(`Another marketplace owns ${root}. Choose a different SUB2SUB_INSTALL_DIR.`);
    const marketplaces = JSON.parse(await run(['plugin', 'marketplace', 'list', '--json'])).marketplaces;
    const registered = marketplaces.find(m => m.name === marketplaceName);
    if (registered && path.resolve(registered.root) !== root) throw new Error(`The sub2sub marketplace is already registered at ${registered.root}. Set SUB2SUB_INSTALL_DIR to that directory.`);
    const before = JSON.parse(await run(['plugin', 'list', '--json'])).installed;
    const duplicates = before.filter(p => p.name === 'sub2sub' && p.pluginId !== pluginId && p.installed);
    const destination = path.join(root, 'versions', release.version);
    const node = path.join(destination, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    const plugin = path.join(destination, 'plugins/sub2sub');
    const exists = await readOptional(path.join(destination, 'release.json'));
    if (exists === undefined) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const staging = await fs.mkdtemp(path.join(root, '.prepare-'));
      try {
        await fs.cp(payload, staging, { recursive: true });
        await fs.rename(staging, destination);
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    } else if (JSON.parse(exists).version !== release.version) throw new Error(`Unexpected contents in ${destination}.`);
    const manifestFile = path.join(plugin, '.mcp.json');
    const manifest = await json(manifestFile);
    Object.assign(manifest.mcpServers.sub2sub, { command: node, args: ['./bin/mcp.mjs'], env: { SUB2SUB_CODEX: codex } });
    manifest.mcpServers.sub2sub.env_vars = [...new Set([...manifest.mcpServers.sub2sub.env_vars, 'USERPROFILE', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP'])];
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    // Refresh Codex's cached startup paths even when reinstalling the same release.
    const pluginManifestFile = path.join(plugin, '.codex-plugin/plugin.json');
    const pluginManifest = await json(pluginManifestFile);
    pluginManifest.version = `${release.version}+codex.${Date.now()}`;
    await fs.writeFile(pluginManifestFile, JSON.stringify(pluginManifest, null, 2) + '\n');
    const { stdout: check } = await exec(node, [path.join(plugin, 'scripts/setup-check.mjs')], {
      env: { ...process.env, SUB2SUB_CODEX: codex }, windowsHide: true, timeout: 30000
    });
    JSON.parse(check);
    log(`Installing sub2sub ${release.version} for ${process.platform}/${process.arch}...`);
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true });
    const marketplace = {
      name: marketplaceName, interface: { displayName: 'sub2sub' },
      plugins: [{ name: 'sub2sub', source: { source: 'local', path: `./versions/${release.version}/plugins/sub2sub` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
    };
    await fs.writeFile(marketplaceFile, JSON.stringify(marketplace, null, 2) + '\n');
    try {
      if (!registered) await run(['plugin', 'marketplace', 'add', root]);
      await run(['plugin', 'add', pluginId]);
      const installed = JSON.parse(await run(['plugin', 'list', '--json'])).installed.find(p => p.pluginId === pluginId);
      if (!installed?.installed || !installed.enabled || installed.version !== pluginManifest.version) throw new Error('Codex did not report the requested plugin version as installed and enabled.');
    } catch (error) {
      if (previous === undefined) await fs.rm(marketplaceFile, { force: true });
      else await fs.writeFile(marketplaceFile, previous);
      throw error;
    }
    // Finish migration only after the replacement is confirmed usable.
    for (const old of duplicates) { log(`Replacing ${old.pluginId}...`); await run(['plugin', 'remove', old.pluginId]); }
    log(`Installed sub2sub ${release.version}. Open a NEW Codex conversation or restart the CLI session.\nProgram files: ${destination}\nPairings and saved results stay in their existing locations.`);
    return { version: release.version, root, node, codex, pluginId };
  } finally { await unlock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node install.mjs <extracted-release> <installation-directory>');
    await install(process.argv[2], process.argv[3]);
  } catch (error) { console.error(`sub2sub install: ${error.message}`); process.exitCode = 1; }
}
