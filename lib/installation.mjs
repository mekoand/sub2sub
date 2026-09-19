import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codexExecutable, executableOnPath } from './config.mjs';
import { readJson } from './files.mjs';
import { processLock } from './lock.mjs';

const exec = promisify(execFile);
const stable = /^\d+\.\d+\.\d+$/;
const within = (directory, file) => file === directory || file.startsWith(directory + path.sep);
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;

async function registeredVersions(root) {
  const keep = new Set();
  let found = false;
  for (const [host, file] of [['codex', '.agents/plugins/marketplace.json'], ['claude', '.claude-plugin/marketplace.json']]) {
    let market;
    try { market = await readJson(path.join(root, file)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (market.name !== 'sub2sub') throw new Error(`Another marketplace owns ${file}.`);
    found = true;
    for (const plugin of market.plugins || []) {
      const source = typeof plugin.source === 'string' ? plugin.source : plugin.source?.path;
      const match = source?.match(/^\.\/versions\/(\d+\.\d+\.\d+)\//);
      if (!match) throw new Error(`Cannot identify the program referenced by ${file}.`);
      keep.add(match[1]);
    }
    // A cached app registration can still reference a previous marketplace version.
    const executable = host === 'codex' ? await codexExecutable({}) : process.env.SUB2SUB_CLAUDE || await executableOnPath('claude');
    const { stdout } = await exec(executable, ['plugin', 'list', '--json'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    const response = JSON.parse(stdout), plugins = host === 'codex' ? response.installed : response;
    if (!Array.isArray(plugins)) throw new Error(`Cannot read ${host} plugin registrations.`);
    for (const plugin of plugins) {
      if (!(host === 'codex' ? plugin.installed && (plugin.name === 'sub2sub' || plugin.pluginId?.startsWith('sub2sub@')) : plugin.id?.startsWith('sub2sub@'))) continue;
      const version = plugin.version?.replace(/\+(codex|claude)\.\d+$/, '');
      if (!stable.test(version)) throw new Error(`Cannot identify a ${host} sub2sub installation version.`);
      keep.add(version);
    }
  }
  if (!found) throw new Error('No managed sub2sub marketplace was found.');
  return keep;
}

async function processes() {
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|sub2sub-tailcat)(\\.exe)?$' } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(rows) ? rows : [rows]).map(row => {
      if (!row.CommandLine) throw new Error(`Cannot inspect node process ${row.ProcessId}.`);
      return { pid: row.ProcessId, command: row.CommandLine };
    });
  }
  const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim().split('\n').map(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) throw new Error('Cannot inspect running program references.');
    return { pid: Number(match[1]), command: match[2] };
  });
}

async function cleanup(root, currentVersion, protectedPaths) {
  const result = { removed: [], kept: [], failed: [] };
  const versions = path.join(root, 'versions');
  let entries;
  try {
    if (!(await fs.lstat(versions)).isDirectory()) throw new Error('The managed versions path is not a directory.');
    entries = await fs.readdir(versions, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  const protectedRealPaths = await Promise.all([process.execPath, ...protectedPaths].filter(Boolean).map(async file => {
    try { return normalized(await fs.realpath(file)); }
    catch (error) { if (error.code === 'ENOENT') return normalized(path.resolve(file)); throw error; }
  }));
  for (const entry of entries) {
    if (!entry.isDirectory() || !stable.test(entry.name)) continue;
    const directory = path.join(versions, entry.name);
    try {
      const release = await readJson(path.join(directory, 'release.json'));
      if (release.version !== entry.name || release.platform !== process.platform || release.arch !== process.arch) throw new Error('Unrecognized release directory; retained.');
      const realDirectory = normalized(await fs.realpath(directory));
      if (entry.name === currentVersion || protectedRealPaths.some(file => within(realDirectory, file))) {
        result.kept.push({ version: entry.name, reason: 'Current program or configured data path.' }); continue;
      }
      // Recheck references for each deletion while holding the installer lock.
      if ((await registeredVersions(root)).has(entry.name)) {
        result.kept.push({ version: entry.name, reason: 'An app or marketplace still references this version.' }); continue;
      }
      const owner = (await processes()).find(row => [normalized(directory), realDirectory].some(location => normalized(row.command).includes(location)));
      if (owner) { result.kept.push({ version: entry.name, reason: `Still referenced by process ${owner.pid}; quit the old session before retrying.` }); continue; }
      await fs.rm(directory, { recursive: true });
      result.removed.push(entry.name);
    } catch (error) { result.failed.push({ version: entry.name, reason: error.message }); }
  }
  return result;
}

export async function cleanupPrograms(root, currentVersion, protectedPaths = []) {
  if (!root) return undefined;
  let unlock;
  try {
    if (!(await fs.lstat(path.join(root, 'versions'))).isDirectory()) throw new Error('No managed versions directory.');
    unlock = await processLock(path.join(root, 'install'));
    return await cleanup(path.resolve(root), currentVersion, protectedPaths);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return { removed: [], kept: [], failed: [{ reason: error.message }] };
  } finally { await unlock?.(); }
}

async function switchNode(sharing, root, version) {
  let before;
  try {
    before = await sharing.machineStatus();
    if (before.status === 'stopped' && !before.ownerPid) return { status: 'not_running' };
    if (!['sharing', 'stopped'].includes(before.status) || before.activeTask !== null) return { status: 'deferred', reason: 'Node work is active or uncertain. Finish work and retry the upgrade.' };
    const directory = path.join(root, 'versions', version);
    const executable = path.join(directory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    const entry = path.join(directory, 'plugins/sub2sub/bin/share.mjs');
    const runtimeMatches = async node => {
      try { return node.runtimePath && normalized(await fs.realpath(node.runtimePath)) === normalized(await fs.realpath(executable)); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    if (before.version === version && await runtimeMatches(before)) return { status: 'current', node: before };
    if (before.upgradeSafeExit !== true) return { status: 'deferred', reason: 'This older node cannot confirm all in-flight uploads before exit. Finish work, exit_sharing, restart the managing app, then start_sharing. No node was stopped.' };
    if ((await readJson(path.join(directory, 'release.json'))).version !== version) throw new Error('Installed release version does not match.');
    await fs.access(executable); await fs.access(entry);
    const runtime = await sharing.runtime();
    if (runtime?.pid !== before.ownerPid) throw new Error('Node ownership changed; retry after checking sharing_status.');
    await sharing.manage('exit');
    await sharing.launch({ address: before.host, port: before.port, networkOnly: before.networkOnly, paused: before.status === 'stopped' }, { executable, entry });
    const after = await sharing.machineStatus();
    if (after.version !== version || !await runtimeMatches(after) || after.status !== before.status) throw new Error('New node version or acceptance state could not be verified. Check sharing_status before retrying.');
    return { status: 'switched', node: after };
  } catch (error) { return { status: 'failed', reason: `${error.message} Check sharing_status; the node may have stopped or a replacement may already be running. Retry only after checking its state.`, previousVersion: before?.version }; }
}

export async function maintainInstallation(sharing, root, version) {
  let unlock, node;
  try {
    unlock = await processLock(path.join(root, 'install'));
    node = await switchNode(sharing, root, version);
    const cleanupResult = await cleanup(root, version, [sharing.store.file, path.dirname(sharing.root)]);
    return { node, cleanup: cleanupResult };
  } catch (error) { return { node: node || { status: 'deferred', reason: error.message }, cleanup: { removed: [], kept: [], failed: [{ reason: error.message }] } }; }
  finally { await unlock?.(); }
}
