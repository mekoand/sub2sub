import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { snapshot, materialize, readJson, writeJson, validateFiles, safePath, MAX_BYTES } from './files.mjs';
import { taskId } from './provider.mjs';
import { Config, executionSettings, executionHarness, harnessSettings, allowedModels, TASK_FILE_SCOPE } from './config.mjs';
import { Sharing, pairPeer, lanRequest } from './lan.mjs';
import { requireModel } from './models.mjs';
import { transferLimits, effectiveLimits, fileLimits, SUPPORT_BYTES, SUPPORT_FILES, WIRE_BYTES } from './limits.mjs';
import { buildWorkCopy, restoreCopy, checkWorkCopy } from './sync.mjs';
import { processLock } from './lock.mjs';

const provider = fileURLToPath(new URL('./provider.mjs', import.meta.url));
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;

export function connect(peer, request, onProgress = () => {}, signal) {
  if (peer.transport === 'lan') return lanRequest(peer, '/rpc', request, onProgress, signal);
  let command, args;
  if (!path.isAbsolute(peer.taskRoot)) throw new Error('taskRoot must be absolute.');
  if (peer.transport === 'local') {
    command = process.execPath;
    args = [provider, peer.taskRoot, peer.codexPath || 'codex'];
  } else if (peer.transport === 'ssh') {
    if (typeof peer.host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(peer.host)) throw new Error('Use a configured SSH host alias (no spaces or options).');
    if (typeof peer.runtimePath !== 'string' || !path.posix.isAbsolute(peer.runtimePath)) throw new Error('runtimePath must be the absolute sub2sub directory on the peer.');
    command = 'ssh';
    args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', peer.host,
      [peer.nodePath || 'node', `${peer.runtimePath}/lib/provider.mjs`, peer.taskRoot, peer.codexPath || 'codex'].map(quote).join(' ')];
  } else throw new Error('Peer transport must be lan, ssh or local.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let result, failure, stderr = '', bytes = 0, killTimer;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => { failure = new Error('Peer timed out after 31 minutes. Check task status before retrying.'); abort(); }, 31 * 60 * 1000);
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { failure = error; });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > WIRE_BYTES) { failure = new Error('Peer response exceeds the supported transport size.'); abort(); }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if ('error' in message) failure = new Error(`Peer: ${message.error}`);
        else if ('result' in message) result = message.result;
        else if ('progress' in message) onProgress(message.progress);
        else throw new Error('Unexpected response from peer.');
      } catch (error) { failure = error; abort(); }
    });
    child.on('close', code => {
      clearTimeout(timeout); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      lines.close();
      if (failure) reject(failure);
      else if (signal?.aborted) reject(new Error('Connection cancelled. Check the task status before resuming.'));
      else if (code !== 0 || result === undefined) reject(new Error(`Peer connection failed (${code}). ${stderr}`));
      else resolve(result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export class Client {
  constructor(config, stateRoot, store) {
    this.config = config; this.stateRoot = stateRoot; this.store = store;
    if (store) this.sharing = new Sharing(store, stateRoot, { independent: true });
  }
  static async load() {
    const configPath = process.env.SUB2SUB_CONFIG || path.join(os.homedir(), '.config/sub2sub/config.json');
    const store = new Config(configPath);
    const config = await store.read();
    return new Client(config, config.stateRoot || path.join(os.homedir(), '.local/state/sub2sub'), store);
  }
  peer(name) {
    if (!Object.hasOwn(this.config.peers || {}, name)) throw new Error(`Unknown peer: ${name}`);
    return this.config.peers[name];
  }
  taskPeer(task) {
    if (!task.peerId) return this.peer(task.peer);
    const peer = Object.values(this.config.peers || {}).find(p => (p.pairId || p.id) === task.peerId);
    if (!peer) throw new Error('This task connection was deleted. View saved local results with list_tasks. Pairing the same device again creates a new connection and does not restore continuation of this old task.');
    return peer;
  }
  async capabilities(peer, onProgress, signal) {
    try { return await connect(peer, { action: 'models' }, onProgress, signal); }
    catch (error) { throw new Error(`Cannot confirm provider capabilities: ${error.message}. Check availability and update both endpoints to sub2sub 0.4 before sending task files.`, { cause: error }); }
  }
  async initialize() {
    if (!path.isAbsolute(this.stateRoot)) throw new Error('stateRoot must be an absolute path.');
    for (const folder of ['snapshots', 'tasks', 'results']) await fs.mkdir(path.join(this.stateRoot, folder), { recursive: true, mode: 0o700 });
    this.stateRoot = await fs.realpath(this.stateRoot);
  }
  async call(name, input, onProgress, signal) {
    if (name === 'stop_sharing') return this.sharing.manage('stop');
    if (name === 'exit_sharing') return this.sharing.manage('exit');
    if (name === 'start_sharing' || name === 'create_pairing') {
      const state = await this.sharing.manage(name === 'start_sharing' ? 'start' : 'pair', input);
      const provider = (await this.store.read()).provider;
      const harness = executionHarness(provider);
      return { ...state, harness, ...executionSettings(harnessSettings(provider, harness), harness) };
    }
    if (this.sharing) await this.sharing.sweep();
    if (this.store) this.config = await this.store.read();
    if (name === 'resource_usage') {
      if (!input.peer) return this.sharing.manage('usage', {}, signal);
      const peer = this.peer(input.peer);
      const current = await connect(peer, { action: 'check' }, onProgress, signal);
      if (!current.usage) return { harness: current.harness || 'codex', status: 'unsupported', checkedAt: new Date().toISOString(), reason: 'This peer does not support quota queries. Update its sub2sub installation.' };
      return connect(peer, { action: 'usage' }, onProgress, signal);
    }
    if (name === 'list_models') {
      if (input.peer) return connect(this.peer(input.peer), { action: 'models' }, onProgress, signal);
      return this.sharing.manage('models', {}, signal);
    }
    if (name === 'caller_settings') {
      const harness = executionHarness({ harness: input.harness });
      if (Object.keys(input).some(key => key !== 'harness')) await this.store.update(config => {
        config.caller ||= {}; config.caller.harnesses ||= {};
        config.caller.harnesses[harness] = executionSettings({ ...harnessSettings(config.caller, harness), ...input }, harness);
        Object.assign(config.caller, transferLimits({ ...config.caller, ...input }));
      });
      const saved = (await this.store.read()).caller;
      return { role: 'caller', harness, execution: executionSettings(harnessSettings(saved, harness), harness), advanced: transferLimits(saved), supported: { bytes: SUPPORT_BYTES, files: SUPPORT_FILES }, note: 'Defaults are shared by nodes using this execution tool. Null means no default has been chosen: list the node models and ask the user to select a model and effort before sending files. Existing tasks keep their own choices.' };
    }
    if (name === 'provider_settings') return this.sharing.manage('configure', input, signal);
    if (name === 'setup_status') return { configPath: this.store.file, stateRoot: this.stateRoot, nodeVersion: process.version, sharing: await this.sharing.machineStatus(), addresses: Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address), nextStep: 'Provider: create_pairing directly, with address if needed. Caller: pair_peer with the private invitation after agreeing to the task-file scope.' };
    if (name === 'sharing_status') {
      const current = await this.sharing.machineStatus(), harness = current.harness || executionHarness(this.config.provider);
      return { ...current, harness, allowedModels: allowedModels(harnessSettings(this.config.provider, harness)) };
    }
    if (name === 'configure_model') {
      if (Object.keys(input).length) await this.store.update(config => {
        const selected = executionSettings({ ...harnessSettings(config.provider, 'codex'), ...input });
        config.provider = { ...config.provider, ...selected, allowedModels: [selected.model] };
        config.provider.harnesses ||= {};
        config.provider.harnesses.codex = { ...config.provider.harnesses.codex, ...selected, allowedModels: [selected.model] };
      });
      return { ...executionSettings((await this.store.read()).provider), note: 'Legacy provider setting restricts sharing to this model. It no longer replaces caller choices. Use caller_settings and provider_settings.' };
    }
    if (name === 'pair_peer') return pairPeer(this.store, input, signal);
    if (name === 'authorize_peer') {
      const transferAuthorization = { scope: input.allowTaskFiles ? 'task-files' : 'none', updatedAt: new Date().toISOString() };
      await this.store.update(config => {
        if (!Object.hasOwn(config.peers || {}, input.peer)) throw new Error(`Unknown peer: ${input.peer}`);
        config.peers[input.peer].transferAuthorization = transferAuthorization;
      });
      return { peer: input.peer, transferAuthorization, transferScope: TASK_FILE_SCOPE };
    }
    if (name === 'list_pairings') return this.sharing.pairings();
    if (name === 'revoke_pairing') return this.sharing.manage('revoke', input, signal);
    if (name === 'cleanup_shared_tasks') return this.sharing.manage('cleanupPair', input, signal);
    if (name === 'cleanup_shared_task') return this.sharing.manage('cleanupTask', input, signal);
    if (name === 'list_shared_tasks') return this.sharing.tasks(input.details);
    if (name === 'cancel_shared_task') return this.sharing.cancel(input);
    if (name === 'list_peers') {
      const peers = await Promise.all(Object.entries(this.config.peers || {}).map(async ([name, peer]) => {
        const summary = { name, transport: peer.transport, transferAuthorization: peer.transferAuthorization || { scope: 'none' } };
        if (input.check === false) return { ...summary, status: 'unchecked' };
        try { const current = await connect(peer, { action: 'check' }, onProgress, signal); return { ...summary, status: current.status || 'available', harness: current.harness || 'codex', limits: current.limits, checkedAt: new Date().toISOString() }; }
        catch (error) { return { ...summary, status: 'unreachable', reason: error.message, checkedAt: new Date().toISOString() }; }
      }));
      const guidance = {
        available: 'Choose an available peer for your task.',
        busy: 'Busy peers are executing a task; wait for completion before delegating another.',
        stopped: 'Start sharing on stopped peers before delegating. Existing results remain accessible.',
        unreachable: 'Check the network and whether sub2sub is running on unreachable peers.',
        unchecked: 'Availability has not been checked; request a live status check when needed.'
      };
      return { peers, setupNeeded: peers.length === 0, nextStep: peers.length === 0 ? 'Share your Codex: ask to generate an invitation. Use another device: paste its invitation to connect.' : [...new Set(peers.map(peer => guidance[peer.status]))].join(' '), transferScope: TASK_FILE_SCOPE };
    }
    if (name === 'check_peer') return connect(this.peer(input.peer), { action: 'check' }, onProgress, signal);
    await this.initialize();
    if (name === 'edit_peer' || name === 'delete_peer') return this.editConnection(name, input, onProgress, signal);
    if (name === 'list_tasks') {
      const files = await fs.readdir(path.join(this.stateRoot, 'tasks'));
      const tasks = [];
      for (const file of files.filter(file => file.endsWith('.json'))) {
        const saved = await readJson(path.join(this.stateRoot, 'tasks', file));
        const connection = saved.peerId ? Object.entries(this.config.peers || {}).find(([, peer]) => (peer.pairId || peer.id) === saved.peerId)?.[0] : saved.peer;
        tasks.push({ taskId: taskId(file.slice(0, -5)), harness: saved.harness || 'codex', peer: connection || saved.peer, connectionPresent: Boolean(connection && this.config.peers?.[connection]), createdAt: saved.createdAt, endedAt: saved.endedAt, finished: Boolean(saved.finished), cleanupStatus: saved.cleanupStatus, resultDirectory: saved.resultDirectory, responseFile: saved.resultDirectory ? path.join(saved.resultDirectory, 'response.md') : undefined, workCopyDirectory: saved.workCopyRoot ? path.join(saved.workCopyRoot, 'files') : undefined, savedRevision: saved.savedRevision, savedAt: saved.savedAt, deliveryPending: saved.deliveryPending });
      }
      tasks.sort((a, b) => (b.endedAt || b.createdAt || '').localeCompare(a.endedAt || a.createdAt || ''));
      return { tasks, note: 'Local records only. To show saved results, read the requested output files under workCopyDirectory, the saved answer at responseFile, and resultDirectory/changes.json for skipped outputs and execution errors. Present the output and saved answer as Markdown links with complete absolute local targets; for spaces use [Output](</full/local/path>). No provider connection is needed. deliveryPending=true means the latest requested execution has not been confirmed saved locally; listed files are from the previous save. Missing times or deliveryPending mean unknown freshness. Use task_status only when current provider state is requested.' };
    }
    if (name === 'prepare_work_copy') {
      const peer = input.peer ? this.peer(input.peer) : undefined;
      const copy = await snapshot(input.workspace, input.paths, fileLimits(this.config.caller, 'input'));
      const id = randomUUID();
      await writeJson(path.join(this.stateRoot, 'snapshots', `${id}.json`), copy);
      return { snapshotId: id, fileCount: copy.files.length, bytes: copy.bytes, files: copy.files.map(f => f.path), excluded: copy.skipped, ...(peer ? { destination: { peer: input.peer, transport: peer.transport, host: peer.host }, transferAuthorization: peer.transferAuthorization || { scope: 'none' }, transferScope: TASK_FILE_SCOPE } : {}), note: 'Local frozen copy only; no files have been sent.' };
    }
    if (name === 'start_task') {
      const peer = this.peer(input.peer);
      if (peer.transport === 'lan' && peer.transferAuthorization?.scope !== 'task-files') throw new Error('Task-file transfer is not authorized for this peer. Explain the scope once, obtain user consent, then use authorize_peer. No files were sent.');
      const copy = await readJson(path.join(this.stateRoot, 'snapshots', `${taskId(input.snapshotId)}.json`));
      const capabilities = await this.capabilities(peer, onProgress, signal);
      const harness = executionHarness(capabilities);
      const settings = executionSettings({ ...harnessSettings(this.config.caller, harness), ...input }, harness);
      requireModel(settings, capabilities);
      const limits = effectiveLimits(this.config.caller, capabilities.limits);
      validateFiles(copy.files, fileLimits(limits, 'input'));
      const id = randomUUID();
      const taskPath = path.join(this.stateRoot, 'tasks', `${id}.json`);
      const saved = { peer: input.peer, peerId: peer.pairId || peer.id, snapshotId: input.snapshotId, harness, ...settings, limits, createdAt: new Date().toISOString(), deliveryPending: true };
      let release;
      const register = async config => {
        const current = config.peers?.[input.peer];
        if (!current || JSON.stringify(current) !== JSON.stringify(peer)) throw new Error('Connection or transfer consent changed before task registration. Query it and try again. No files were sent.');
        release = await processLock(path.join(this.stateRoot, 'tasks', '.locks', id));
        await writeJson(taskPath, saved);
      };
      try {
        if (this.store) await this.store.update(register); else await register(this.config);
        onProgress?.(`Created task ${id}. Sending ${copy.files.length} files (${copy.bytes} bytes).`);
        const result = await connect(peer, { action: 'run', protocol: 2, taskId: id, snapshot: { files: copy.files }, prompt: input.prompt, ...settings, ...(capabilities.harness ? { harness } : {}), limits }, onProgress, signal);
        await writeJson(taskPath, { ...saved, endedAt: result.endedAt, retentionDays: result.retentionDays, expiresAt: result.expiresAt });
        if (result.stopReason === 'time_limit') return await this.saveTimeLimitResult(result, onProgress, signal);
        return { ...result, deliveryPending: true };
      }
      catch (error) { throw new Error(`Task ${id}: ${error.message}`, { cause: error }); }
      finally { await release?.(); }
    }
    if (['task_status', 'cancel_task'].includes(name)) return this.taskCall(name, input, onProgress, signal);
    const release = await processLock(path.join(this.stateRoot, 'tasks', '.locks', taskId(input.taskId)));
    try { return await this.taskCall(name, input, onProgress, signal); }
    finally { await release(); }
  }
  async saveTimeLimitResult(result, onProgress, signal) {
    try {
      const saved = await this.taskCall('collect_result', { taskId: result.taskId }, onProgress, signal);
      return { ...result, ...saved, note: 'The time limit stopped this turn. Available stage results are saved locally; work may be incomplete. Report the saved files and remaining work, then wait for the user to choose whether to continue this same task. Do not start another turn automatically.' };
    } catch (error) {
      throw new Error(`Task ${result.taskId} reached its time limit, but saving stage results failed: ${error.message}. Retry collect_result on this task; do not rerun the work to retry saving.`, { cause: error });
    }
  }
  async taskCall(name, input, onProgress, signal) {
    if (this.store) this.config = await this.store.read();
    const id = taskId(input.taskId);
    const taskPath = path.join(this.stateRoot, 'tasks', `${id}.json`);
    const task = await readJson(taskPath);
    if (name === 'finish_task' && !['keep', 'workcopy', 'records', 'all'].includes(input.cleanup)) throw new Error('Choose cleanup explicitly: keep, workcopy, records or all.');
    if (name === 'finish_task' && input.cleanup === 'keep') return { taskId: id, status: 'retained', cleanupStatus: task.cleanupStatus, resultDirectory: task.resultDirectory, retentionDays: task.retentionDays, expiresAt: task.expiresAt, note: 'No data deleted or restored; the retention policy is unchanged. Keeping does not extend the deadline. expiresAt is the last known deadline; older records or interrupted connections may need task_status to confirm it. Idle cleanup runs when sub2sub is active, only after local save confirmation, resolved necessary outputs and no active or uncertain execution.' };
    if (task.finished && name !== 'finish_task') {
      if (name === 'task_status') {
        if (input.details) return { ...await connect(this.taskPeer(task), { action: 'status', taskId: id, details: true }, onProgress, signal), localCleanupRecord: task.cleanupStatus, resultDirectory: task.resultDirectory };
        return { taskId: id, status: task.cleanupStatus || 'finished', resultDirectory: task.resultDirectory, note: 'Local cleanup record only. Use details=true to check remote files now.' };
      }
      throw new Error('Task was finished and its work copy removed. Start a new task to do more work.');
    }
    const peer = this.taskPeer(task);
    if (task.pendingSave && ['collect_result', 'continue_task', 'finish_task'].includes(name)) {
      await checkWorkCopy(this.stateRoot, id, task.workCopyRoot, task.workCopyPaths);
      await connect(peer, { action: 'ack', taskId: id, ...task.pendingSave }, onProgress, signal);
      delete task.pendingSave; await writeJson(taskPath, task);
    }
    if (name === 'continue_task' && peer.transport === 'lan' && peer.transferAuthorization?.scope !== 'task-files') throw new Error('Follow-up instructions are not authorized for this peer. Use authorize_peer only after user consent.');
    if (name === 'finish_task') {
      if (!task.finished) {
        if (!task.resultDirectory) throw new Error('Collect the result locally before finishing.');
        if (task.workCopyRoot) await checkWorkCopy(this.stateRoot, id, task.workCopyRoot, task.workCopyPaths);
        const collected = await readJson(path.join(task.resultDirectory, 'changes.json'));
        const discard = input.discardPaths === undefined ? [] : input.discardPaths;
        if (!Array.isArray(discard) || discard.length > 2000) throw new Error('discardPaths must be an array of skipped paths that are no longer needed.');
        for (const skipped of discard) safePath(skipped);
        const unresolved = collected.skipped.filter(skipped => !discard.includes(skipped));
        if (unresolved.length) throw new Error(`Resolve skipped paths before cleanup: ${unresolved.join(', ')}. Recover needed outputs and collect again, or list only unneeded paths in discardPaths.`);
      }
      const finished = await connect(peer, { action: 'finish', ...(task.harness === 'claude' ? { harness: 'claude' } : {}), taskId: id, revision: task.resultRevision, discardPaths: input.discardPaths, cleanup: input.cleanup }, onProgress, signal);
      task.finished = input.cleanup !== 'workcopy';
      task.cleanupStatus = finished.status;
      await writeJson(taskPath, task);
      const references = await Promise.all((await fs.readdir(path.join(this.stateRoot, 'tasks'))).filter(f => f.endsWith('.json')).map(f => readJson(path.join(this.stateRoot, 'tasks', f))));
      if (!references.some(t => !t.finished && t.cleanupStatus !== 'released' && t.snapshotId === task.snapshotId)) await fs.rm(path.join(this.stateRoot, 'snapshots', `${taskId(task.snapshotId)}.json`), { force: true });
      return { ...finished, resultDirectory: task.resultDirectory, note: 'Selected remote cleanup completed. Local source, downloaded results and the local task index remain.' };
    }
    const actions = { continue_task: 'run', task_status: 'status', cancel_task: 'cancel', collect_result: 'result' };
    if (!actions[name]) throw new Error(`Unknown tool: ${name}`);
    let settings, restoration, executionTool;
    if (name === 'continue_task') {
      // Old local indexes lack execution settings; read the task, not current defaults.
      const remote = await connect(peer, { action: 'status', taskId: id }, onProgress, signal);
      const previous = task.model ? task : remote;
      const harness = executionHarness(previous);
      settings = executionSettings({ ...previous, ...input }, harness);
      const capabilities = await this.capabilities(peer, onProgress, signal);
      if (executionHarness(capabilities) !== harness) throw new Error(`This task uses ${harness}. Ask the provider to switch back before continuing it.`);
      executionTool = capabilities.harness ? { harness } : undefined;
      requireModel(settings, capabilities);
      if (['released', 'restoring'].includes(remote.status)) {
        const limits = effectiveLimits(this.config.caller, capabilities.limits);
        const copy = await restoreCopy(this.stateRoot, id, task.workCopyRoot, task.workCopyPaths, fileLimits(limits, 'input'));
        restoration = { action: 'restore', revision: task.savedRevision, snapshot: { files: copy.files }, limits };
        delete task.cleanupStatus;
      }
      Object.assign(task, settings, { deliveryPending: true }); await writeJson(taskPath, task);
    }
    const result = await connect(peer, { action: actions[name], protocol: 2, taskId: id, prompt: input.prompt, details: input.details, ...settings, ...executionTool, ...restoration }, onProgress, signal);
    if (name === 'continue_task' || name === 'collect_result') {
      Object.assign(task, { endedAt: result.endedAt, retentionDays: result.retentionDays, expiresAt: result.expiresAt });
      if (name === 'continue_task') await writeJson(taskPath, task);
    }
    if (name === 'continue_task' && result.stopReason === 'time_limit') return this.saveTimeLimitResult(result, onProgress, signal);
    if (name !== 'collect_result') return { ...result, ...(task.workCopyRoot ? { workCopyDirectory: path.join(task.workCopyRoot, 'files'), savedAt: task.savedAt } : {}), ...(name === 'continue_task' ? { deliveryPending: true, note: 'This execution still needs collect_result before delivery. Any local workCopyDirectory is from the previous save.' } : {}) };
    const resultLimits = fileLimits(task.limits, 'result');
    validateFiles(result.changes.files, { result: true, ...resultLimits });
    if (!Array.isArray(result.changes.removed) || result.changes.removed.length > SUPPORT_FILES || typeof result.response !== 'string') throw new Error('Invalid result from peer.');
    if (!Array.isArray(result.changes.skipped) || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('Invalid skipped paths or task error from peer.');
    for (const removed of result.changes.removed) safePath(removed);
    for (const skipped of result.changes.skipped) safePath(skipped);
    if (result.syncId) {
      taskId(result.syncId);
      if (!Number.isSafeInteger(result.revision) || result.baseRevision !== (task.savedRevision || 0)) throw new Error('Result does not match the locally saved task revision. No save was confirmed.');
    }
    const original = task.workCopyRoot && result.syncId ? undefined : (await readJson(path.join(this.stateRoot, 'snapshots', `${taskId(task.snapshotId)}.json`))).files;
    const workPaths = new Set(result.syncId && task.workCopyPaths ? task.workCopyPaths : original.map(f => f.path));
    for (const name of result.changes.removed) workPaths.delete(name);
    for (const file of result.changes.files) workPaths.add(file.path);
    const expectedPaths = [...workPaths].sort();
    const workCopyRoot = await buildWorkCopy(this.stateRoot, id, result.syncId ? task.workCopyRoot : undefined, original, result.changes, expectedPaths);
    const directory = await fs.mkdtemp(path.join(this.stateRoot, 'results', `${id}-`));
    await materialize(path.join(directory, 'files'), result.changes.files, { result: true, ...resultLimits });
    await writeJson(path.join(directory, 'changes.json'), { taskId: id, status: result.status, stopReason: result.stopReason, revision: result.revision, model: result.model, reasoningEffort: result.reasoningEffort, error: result.error, changed: result.changes.files.map(f => ({ path: f.path, executable: f.executable })), removed: result.changes.removed, skipped: result.changes.skipped });
    const response = result.error ? `Task ${result.status} (revision ${result.revision}).\n\n${result.error}\n\n${result.response}` : result.response;
    await fs.writeFile(path.join(directory, 'response.md'), response, { mode: 0o600 });
    task.resultDirectory = directory;
    task.resultRevision = result.revision;
    task.workCopyRoot = workCopyRoot;
    task.workCopyPaths = expectedPaths;
    task.savedAt = new Date().toISOString();
    task.deliveryPending = false;
    if (result.syncId) {
      task.savedRevision = result.revision;
      task.pendingSave = { syncId: result.syncId, revision: result.revision };
    }
    await writeJson(taskPath, task);
    if (task.pendingSave) {
      try { await connect(peer, { action: 'ack', taskId: id, ...task.pendingSave }, onProgress, signal); }
      catch (error) { throw new Error(`Saved locally at ${path.join(workCopyRoot, 'files')}; confirmation failed: ${error.message}. Retry collect_result.`, { cause: error }); }
      delete task.pendingSave; await writeJson(taskPath, task);
    }
    return { taskId: id, status: result.status, stopReason: result.stopReason, model: result.model, reasoningEffort: result.reasoningEffort, error: result.error, resultDirectory: directory, responseFile: path.join(directory, 'response.md'), workCopyDirectory: path.join(workCopyRoot, 'files'), savedAt: task.savedAt, savedRevision: task.savedRevision, deliveryPending: false, changed: result.changes.files.map(f => f.path), removed: result.changes.removed, skipped: result.changes.skipped, note: 'Files and text response are saved locally. Read the main output and responseFile, then include both as Markdown links with complete absolute local targets in the final answer. The complete task copy is reused when files have not changed. Resolve skipped necessary outputs before cleanup.' };
  }
  async editConnection(name, input, onProgress, signal) {
    const releases = [];
    try { return await this.store.update(async config => {
      const peer = config.peers?.[input.peer];
      if (!peer) throw new Error(`Unknown peer: ${input.peer}`);
      const identity = peer.pairId || peer.id || randomUUID();
      const records = [];
      // Registration uses this same config lock; task locks serialize existing updates.
      for (const file of (await fs.readdir(path.join(this.stateRoot, 'tasks'))).filter(f => f.endsWith('.json'))) {
        const target = path.join(this.stateRoot, 'tasks', file), saved = await readJson(target);
        if (saved.peerId ? saved.peerId !== identity : saved.peer !== input.peer) continue;
        const id = taskId(file.slice(0, -5));
        releases.push(await processLock(path.join(this.stateRoot, 'tasks', '.locks', id)));
        records.push({ id, target, saved: await readJson(target) });
      }
      if (name === 'delete_peer') {
        const abandoned = new Set(input.abandonTasks || []), remaining = [];
        for (const id of abandoned) if (!records.some(t => t.id === id)) throw new Error(`Unknown task for this connection: ${id}`);
        for (const record of records.filter(r => !r.saved.finished)) {
          let current;
          try { current = await connect(peer, { action: 'status', taskId: record.id }, onProgress, signal); }
          catch (error) {
            if (!abandoned.has(record.id)) throw new Error(`Cannot verify task ${record.id}: ${error.message}. Results may remain remote; explicitly abandon this task only after reviewing that loss of access.`);
            remaining.push({ taskId: record.id, status: 'unknown', reason: error.message }); continue;
          }
          if (['running', 'ready', 'unknown', 'finishing', 'restoring'].includes(current.status)) throw new Error(`Stop or resolve task ${record.id} (${current.status}) before deleting the connection.`);
          const uncollected = current.syncVersion ? current.savedRevision !== current.revision || current.unresolvedSkipped?.length : record.saved.resultRevision !== current.revision;
          if (uncollected && !abandoned.has(record.id)) throw new Error(`Task ${record.id} has uncollected results or necessary files not saved. Collect them or explicitly abandon this task first.`);
          remaining.push({ taskId: record.id, status: current.status, abandoned: abandoned.has(record.id) });
        }
        delete config.peers[input.peer];
        return { peer: input.peer, status: 'deleted', remoteTasks: remaining, note: 'The local connection was deleted. Remote pairing and files, and saved local results remain. This connection can no longer continue its old tasks; pairing the same device again creates a new connection and does not restore that access. View saved local results with list_tasks.' };
      }
      const nextName = input.name || input.peer;
      if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(nextName) || ['__proto__', 'constructor', 'prototype'].includes(nextName)) throw new Error('Choose a connection name of 1–80 letters, numbers, dots, underscores or hyphens.');
      if (nextName !== input.peer && Object.hasOwn(config.peers, nextName)) throw new Error('That connection name is already in use.');
      if (input.host !== undefined || input.port !== undefined) {
        if (peer.transport !== 'lan') throw new Error('Address editing is supported for LAN peers only.');
        await connect({ ...peer, host: input.host ?? peer.host, port: input.port ?? peer.port }, { action: 'check' }, onProgress, signal);
      }
      for (const record of records.filter(r => !r.saved.peerId)) await writeJson(record.target, { ...record.saved, peerId: identity });
      peer.id = identity;
      if (input.host !== undefined) peer.host = input.host;
      if (input.port !== undefined) peer.port = input.port;
      delete config.peers[input.peer]; config.peers[nextName] = peer;
      return { peer: nextName, status: 'updated', note: 'Task association, provider identity and transfer consent are preserved.' };
    });
    } finally { for (const release of releases.reverse()) await release(); }
  }
  async close() { await this.sharing?.close(); }
}
