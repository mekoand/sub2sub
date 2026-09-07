import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { codexExecutable, executableOnPath } from './config.mjs';

const exec = promisify(execFile);
const packageInfo = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const stable = /^\d+\.\d+\.\d+$/;

async function registration(client, host) {
  if (!['codex', 'claude'].includes(host)) return { status: 'unknown', host: null, version: null, root: null, reason: 'The managing host is unknown. Specify host=codex or host=claude; no installation directory is guessed.' };
  try {
    const executable = host === 'codex' ? await codexExecutable({}) : process.env.SUB2SUB_CLAUDE || await executableOnPath('claude');
    const run = async args => JSON.parse((await exec(executable, args, { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout);
    const markets = await run(['plugin', 'marketplace', 'list', '--json']);
    const plugins = await run(['plugin', 'list', '--json']);
    const market = (host === 'codex' ? markets.marketplaces : markets).find(m => m.name === 'sub2sub');
    const installed = (host === 'codex' ? plugins.installed : plugins).find(p => host === 'codex' ? p.pluginId === 'sub2sub@sub2sub' && p.installed : p.id === 'sub2sub@sub2sub' && p.scope === 'user');
    const root = host === 'codex' ? market?.root : market?.source === 'directory' ? market.path : undefined;
    if (!root || !path.isAbsolute(root) || !installed?.version) throw new Error('No registered sub2sub release installation was found. Use the documented installer to establish this host installation.');
    if (process.env.SUB2SUB_INSTALL_DIR && path.resolve(process.env.SUB2SUB_INSTALL_DIR) !== path.resolve(root)) throw new Error('The host registration differs from this session installation directory. Open a new session in the intended host before upgrading.');
    return { status: 'registered', host, root: path.resolve(root), version: installed.version, enabled: installed.enabled };
  } catch (error) { return { status: 'unknown', host, root: null, version: null, reason: `Cannot inspect ${host} registration: ${error.stderr || error.message}` }; }
}

function compare(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export async function updatePlugin(client, input = {}, signal) {
  if (!['check', 'install'].includes(input.action)) throw new Error('Choose update action: check or install. Install only after an explicit user upgrade request.');
  if (input.host && process.env.SUB2SUB_INSTALL_HOST && input.host !== process.env.SUB2SUB_INSTALL_HOST) throw new Error('The requested host differs from the current session host. Open a session in that host to upgrade it.');
  const installed = await registration(client, input.host || process.env.SUB2SUB_INSTALL_HOST);
  let node;
  try { const state = await client.sharing.machineStatus(); node = { status: state.status, version: state.version || null, activeTask: state.activeTask, ownerPid: state.ownerPid, reason: state.reason }; }
  catch (error) { node = { status: 'unknown', version: null, reason: error.message }; }
  let latest;
  try {
    const response = await fetch('https://api.github.com/repos/mekoand/sub2sub/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const release = await response.json();
    const version = release.tag_name?.replace(/^v/, '');
    if (release.draft !== false || release.prerelease !== false || !stable.test(version)) throw new Error('GitHub did not return a published stable release.');
    latest = { version, url: `https://github.com/mekoand/sub2sub/releases/tag/v${version}` };
  } catch (error) { throw new Error(`Update check failed: ${error.message}. Retry when GitHub is reachable; nothing was installed.`, { cause: error }); }
  const installedBase = installed.version?.replace(/\+(codex|claude)\.\d+$/, '');
  const comparison = stable.test(installedBase) ? compare(installedBase, latest.version) : null;
  const status = comparison === null ? 'unknown_installation' : comparison < 0 ? 'update_available' : comparison > 0 ? 'newer_installed' : 'current';
  const result = { status, sessionVersion: packageInfo.version, installed, node, latest, checkedAt: new Date().toISOString() };
  if (input.action === 'check' || status === 'current' || status === 'newer_installed') return result;
  if (status === 'unknown_installation') return { ...result, status: 'deferred', reason: installed.reason || 'This installation has a source or prerelease version. Use its original installation workflow; no downgrade was attempted.' };
  if (!stable.test(packageInfo.version) || compare(packageInfo.version, latest.version) > 0) return { ...result, status: 'deferred', reason: 'The current session is newer than the release or uses a source/prerelease version. No downgrade was attempted.' };
  if (!['sharing', 'stopped'].includes(node.status) || node.activeTask !== null) return { ...result, status: 'deferred', reason: `Node work is active or uncertain (${node.status}). Finish its work and check sharing_status before retrying.` };
  try {
    const shared = await client.sharing.tasks();
    const busy = shared.tasks.find(task => !['completed', 'failed', 'interrupted', 'released'].includes(task.status));
    if (busy) return { ...result, status: 'deferred', reason: `Provider task ${busy.taskId} is ${busy.status}; resolve its work before upgrading.` };
    const locks = await fs.readdir(path.join(client.stateRoot, 'tasks/.locks')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (locks.length) return { ...result, status: 'deferred', reason: 'A caller task operation is active or its lock has not been resolved. Wait for it to finish before upgrading.' };
    const files = await fs.readdir(path.join(client.stateRoot, 'tasks')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const task = JSON.parse(await fs.readFile(path.join(client.stateRoot, 'tasks', file), 'utf8'));
      if (!task.finished && task.deliveryPending !== false) return { ...result, status: 'deferred', reason: `Local caller task ${file.slice(0, -5)} has active or unsaved/unknown work. Check task_status and collect_result before upgrading.` };
    }
  } catch (error) { return { ...result, status: 'deferred', reason: `Cannot establish local work state: ${error.message}. Resolve this before upgrading.` }; }
  if (!['darwin', 'win32'].includes(process.platform)) return { ...result, status: 'deferred', reason: 'Published release installers support macOS and Windows. Use the source installation workflow on this platform.' };
  const script = fileURLToPath(new URL(process.platform === 'win32' ? '../install.ps1' : '../install.sh', import.meta.url));
  const command = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-File', script, '-Target', installed.host] : [script, installed.host];
  signal?.throwIfAborted();
  try {
    await exec(command, args, { env: { ...process.env, SUB2SUB_VERSION: latest.version, SUB2SUB_INSTALL_DIR: installed.root }, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) { throw new Error(`Release download/installation failed: ${(error.stderr || error.message).slice(-4000)} ${(error.stdout || '').slice(-1000)}. Existing sessions and saved data were not stopped or cleaned. Check host registration before retrying; an interrupted installer may have partially installed the release.`, { cause: error }); }
  const verified = await registration(client, installed.host);
  if (verified.status !== 'registered' || !verified.enabled || verified.version.replace(/\+(codex|claude)\.\d+$/, '') !== latest.version) throw new Error(`Installation verification failed: ${verified.reason || 'the host does not report the requested version as enabled'}. Check the host plugin list before retrying. The running session and node still use their existing code.`);
  return { ...result, status: 'installed', installed: verified, nextStep: 'Open a NEW conversation/session in this host to activate the installed code. Existing independent nodes keep running: when idle, use exit_sharing then start_sharing from the new session. For 0.5.3 sharing, finish/save work and end the old provider conversation before starting sharing in the new one; that old version has no independent-node exit command. Peer features still depend on existing capability checks; mixed versions are not universally compatible.' };
}
