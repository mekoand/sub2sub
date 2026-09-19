import { writeMessage, readMessages, releaseReceived, retainReceived, legacyMessage, parseLegacy } from './transfer.mjs';
import fs from 'node:fs/promises';
import { localStorage, cleanupLocalFiles } from './storage.mjs';
import { updatePlugin } from './updates.mjs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { snapshot, materialize, readJson, writeJson, validateFiles, safePath, fileSize } from './files.mjs';
import { taskId } from './provider.mjs';
import { Config, executionSettings, executionHarness, harnessSettings, hostSelection, allowedModels, retentionDays, maxConcurrent, keepSessionVisible, deviceName, connectionNames, cleanupAllOnExpiry, requireRetentionConsent, TASK_FILE_SCOPE } from './config.mjs';
import { Sharing, pairPeer, lanRequest, invitation } from './lan.mjs';
import { requireModel } from './models.mjs';
import { transferLimits, effectiveLimits, fileLimits, WIRE_BYTES, transferWarning, legacyLimits } from './limits.mjs';
import { buildWorkCopy, restoreCopy, checkWorkCopy } from './sync.mjs';
import { prepareUpload } from './upload.mjs';
import { processLock } from './lock.mjs';
import { Management } from './web.mjs';
import { crossNetwork } from './config.mjs';
import { measuredRounds, summarizeTasks } from './statistics.mjs';

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
    const streaming = request.protocol === 3;
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let result, failure, stderr = '', bytes = 0, killTimer;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timeout;
    const activity = () => { clearTimeout(timeout); timeout = setTimeout(() => { failure = new Error('Peer stalled for 31 minutes. Check task status before retrying.'); abort(); }, 31 * 60 * 1000); };
    activity(); child.stdin.on('drain', activity); child.stdout.on('data', activity);
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { failure = error; });
    if (!streaming) child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > WIRE_BYTES) { failure = new Error('Peer response exceeds the supported transport size.'); abort(); }
    });
    let lines, reading;
    if (streaming) {
      reading = (async () => {
        for await (const message of readMessages(child.stdout, request.action === 'result' ? fileLimits(request.limits ?? legacyLimits(), 'result') : {})) {
          if ('error' in message) failure = new Error(`Peer: ${message.error}`);
          else if ('result' in message) {
            if (result) { await releaseReceived(message); throw new Error('Duplicate host result.'); }
            result = retainReceived(message, message.result);
          } else if ('progress' in message) { onProgress(message.progress); await releaseReceived(message); }
          else throw new Error('Unexpected response from peer.');
        }
      })().catch(error => { failure = error; abort(); });
    } else {
      lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const message = parseLegacy(line);
          if ('error' in message) failure = new Error(`Peer: ${message.error}`);
          else if ('result' in message) result = message.result;
          else if ('progress' in message) onProgress(message.progress);
          else throw new Error('Unexpected response from peer.');
        } catch (error) { failure = error; abort(); }
      });
    }
    child.on('close', async code => {
      await reading;
      clearTimeout(timeout); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      lines?.close();
      if (failure) { await releaseReceived(result); reject(failure); }
      else if (signal?.aborted) { await releaseReceived(result); reject(new Error('Connection cancelled. Check the task status before resuming.')); }
      else if (code !== 0 || result === undefined) { await releaseReceived(result); reject(new Error(`Peer connection failed (${code}). ${stderr}`)); }
      else resolve(result);
    });
    if (streaming) void writeMessage(child.stdin, request).then(() => child.stdin.end(), error => { failure = error; abort(); });
    else child.stdin.end(JSON.stringify(request));
  });
}

export class Client {
  constructor(config, stateRoot, store) {
    this.config = config; this.stateRoot = stateRoot; this.store = store;
    this.web = new Management(this);
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
  async connect(peer, request, onProgress, signal) {
    const named = { ...peer, localDeviceName: deviceName(this.config) };
    const result = peer.transport === 'lan' ? await this.networkRequest(named, '/rpc', request, onProgress, signal) : await connect(named, request, onProgress, signal);
    if (this.store && result.remoteDeviceName && peer.deviceName !== result.remoteDeviceName) {
      await this.store.update(config => {
        const saved = Object.values(config.peers || {}).find(p => p.pairId === peer.pairId && p.token === peer.token);
        if (!saved) return;
        saved.deviceName = result.remoteDeviceName;
        connectionNames(Object.values(config.peers), p => p.automaticName ? p.deviceName : Object.keys(config.peers).find(key => config.peers[key] === p));
        Object.assign(peer, saved);
      });
    }
    return result;
  }
  async networkRequest(peer, route, input, onProgress, signal) {
    let result;
    try { result = await lanRequest(peer, route, input, onProgress, signal, { connectTimeout: peer.tailcat ? 3000 : 15000 }); }
    catch (error) {
      if (!peer.tailcat || !error.beforeSend || signal?.aborted) throw error;
      if (!crossNetwork(await this.store.read()).enabled) throw new Error('Cross-network connection is off. Explicitly enable it on both devices or restore the direct private-network connection.', { cause: error });
      return this.sharing.manage('request', { peer, route, request: input }, signal, onProgress);
    }
    // An error saving recovery metadata must never replay a completed direct request.
    if (peer.tailcat && input.taskId && ['run', 'restore', 'status'].includes(input.action) && await this.sharing.runtime()) await this.sharing.manage('resolveNetwork', { peer: { pairId: peer.pairId }, request: { taskId: input.taskId, action: input.action }, result: { executionActive: result.executionActive } });
    return retainReceived(result, { ...result, ...(peer.tailcat ? { connectionRoute: 'direct' } : {}) });
  }
  async capabilities(peer, onProgress, signal) {
    try {
      const result = await this.connect(peer, { action: 'models' }, onProgress, signal);
      if (result.connection?.authorizationStatus === 'expired') throw new Error('Connection authorization has expired. Ask the host to extend the original connection. Existing results remain accessible.');
      if (['paused', 'exhausted'].includes(result.connection?.budget?.status)) throw new Error(`Connection Token budget is ${result.connection.budget.status}. Ask the host to review this connection’s budget. Existing results remain accessible.`);
      return result;
    }
    catch (error) { throw new Error(`Cannot confirm host capabilities: ${error.message}. The cause is unconfirmed; review this error and query list_models when ready. No task files were sent and no model was selected.`, { cause: error }); }
  }
  async selectHost(input, copy, onProgress, signal) {
    const { autoSelectHost, candidateHosts } = hostSelection(this.config.caller);
    if (!autoSelectHost || !candidateHosts.length) throw new Error('请指定共享端，或开启自动选择并配置候选。 / Specify a host, or enable automatic selection with ordered candidates. No files were sent.');
    const harness = executionHarness(input);
    const settings = executionSettings({ ...harnessSettings(this.config.caller, harness), ...input }, harness);
    if (!settings.model || !settings.reasoningEffort) throw new Error('先选择模型与思考强度。 / Choose a model and reasoning effort before automatic host selection. No files were sent.');
    const skipped = [];
    for (const name of candidateHosts) {
      if (signal?.aborted) throw new Error('Host selection cancelled. No files were sent.');
      try {
        const peer = this.peer(name);
        if (peer.transferAuthorization?.scope !== 'task-files') throw new Error('未授权任务文件 / Task-file transfer is not authorized.');
        const state = await this.connect(peer, { action: 'check' }, onProgress, signal);
        if (state.status !== 'available') throw new Error(`共享端不可用 / Host is not available: ${state.status || 'unknown'}.`);
        if (['exhausted', 'paused'].includes(state.connection?.budget?.status)) throw new Error(`连接预算不可用 / Connection budget is ${state.connection.budget.status}.`);
        if (executionHarness(state) !== harness) throw new Error(`执行工具不匹配 / Execution tool does not match ${harness}.`);
        const capabilities = await this.capabilities(peer, onProgress, signal);
        requireRetentionConsent(peer, capabilities.retentionPolicy);
        if (['exhausted', 'paused'].includes(capabilities.connection?.budget?.status)) throw new Error(`连接预算不可用 / Connection budget is ${capabilities.connection.budget.status}.`);
        if (executionHarness(capabilities) !== harness) throw new Error(`执行工具已变化 / Execution tool does not match ${harness}.`);
        requireModel(settings, capabilities);
        const limits = effectiveLimits(this.config.caller, capabilities.transferProtocol === 3 ? capabilities.limits : legacyLimits(capabilities.limits));
        validateFiles(copy.files, fileLimits(limits, 'input'));
        const selection = { skipped, budgetStatus: capabilities.connection?.budget?.status ?? state.connection?.budget?.status ?? 'unverified', note: '提交前选择，不保证接单；提交后不自动换共享端。缺少预算信息时未核实余额。 / Selected before submission; admission is not guaranteed. No automatic reroute after submission. Budget is unverified when no budget metadata is available.' };
        onProgress?.(`已选择共享端 ${name}，仅派发一次。 / Selected host ${name}; submitting once.`);
        return { name, peer, capabilities, selection };
      } catch (error) {
        if (signal?.aborted) throw error;
        skipped.push({ peer: name, reason: error.message });
      }
    }
    throw new Error(`没有符合要求的共享端；未发送任务。 / No eligible host; no task was sent. ${skipped.map(item => `${item.peer}: ${item.reason}`).join('\n')}`);
  }
  async initialize() {
    if (!path.isAbsolute(this.stateRoot)) throw new Error('stateRoot must be an absolute path.');
    for (const folder of ['snapshots', 'tasks', 'results']) await fs.mkdir(path.join(this.stateRoot, folder), { recursive: true, mode: 0o700 });
    this.stateRoot = await fs.realpath(this.stateRoot);
  }
  async onboardingStatus(action = 'status') {
    if (!['status', 'confirm', 'skip', 'reopen'].includes(action)) throw new Error('Choose onboarding action: status, confirm, skip or reopen.');
    const config = await this.store.read();
    if (config.onboarding && !['pending', 'confirmed', 'skipped', 'existing'].includes(config.onboarding.status)) throw new Error('Invalid saved onboarding status.');
    if (action === 'status') {
      if (config.onboarding) return config.onboarding.status;
      let existing = Boolean(config.deviceName || ['caller', 'provider', 'peers'].some(key => Object.keys(config[key] || {}).length));
      for (const folder of ['tasks', 'sharing']) {
        try { existing ||= (await fs.readdir(path.join(this.stateRoot, folder))).length > 0; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return existing ? 'existing' : 'pending';
    }
    return this.store.update(current => {
      current.onboarding = { status: action === 'confirm' ? 'confirmed' : action === 'skip' ? 'skipped' : 'pending' };
      return current.onboarding.status;
    });
  }
  async onboarding(input = {}) {
    const status = await this.onboardingStatus(input.action);
    const config = await this.store.read();
    return {
      status, confirmationRequired: status === 'pending',
      settings: {
        crossNetwork: crossNetwork(config),
        deviceName: deviceName(config),
        caller: {
          role: 'Delegate work and receive results.',
          ...hostSelection(config.caller),
          execution: Object.fromEntries(['codex', 'claude'].map(harness => [harness, executionSettings(harnessSettings(config.caller, harness), harness)])),
          modelAvailability: 'unverified',
          limits: transferLimits(config.caller)
        },
        provider: {
          role: 'Share this device’s execution environment with authorized clients.',
          harness: executionHarness(config.provider),
          network: { address: config.provider?.address || 'auto-select', port: config.provider?.port ?? 47631 },
          allowedModels: Object.fromEntries(['codex', 'claude'].map(harness => [harness, allowedModels(harnessSettings(config.provider, harness))])),
          modelAvailability: 'unverified',
          maxConcurrent: maxConcurrent(config.provider), keepSessionVisible: keepSessionVisible(config.provider), limits: transferLimits(config.provider), retentionDays: retentionDays(config.provider), cleanupAllOnExpiry: cleanupAllOnExpiry(config.provider)
        },
        advanced: {
          configPath: this.store.file, stateRoot: this.stateRoot,
          executionPaths: { codex: config.provider?.codexPath || process.env.SUB2SUB_CODEX || 'auto-detect', claude: config.provider?.claudePath || process.env.SUB2SUB_CLAUDE || 'auto-detect' },
          supportedLimits: { bytes: null, files: null }
        }
      },
      connections: Object.entries(config.peers || {}).map(([name, peer]) => ({ name, displayName: peer.displayName || name, transport: peer.transport, host: peer.host, port: peer.port, taskRoot: peer.taskRoot, runtimePath: peer.runtimePath, nodePath: peer.nodePath, codexPath: peer.codexPath, status: 'unchecked', transferAuthorization: { scope: peer.transferAuthorization?.scope || 'none' } })),
      pairings: (await this.sharing.pairings()).pairings,
      sharing: await this.sharing.machineStatus(),
      note: 'No model availability was queried. Null choices are unset; list a connected node’s models before choosing. All models includes future models. Null transfer limits mean unlimited. Both sides’ finite limits apply using the smaller value; transfers above 64 MiB show a notice and continue. Retention cleanup requires saved results and no active or uncertain execution; it runs while sub2sub runs. Settings confirmation is not permission to send task files.',
      nextStep: status === 'pending' ? 'Show all settings, including advanced values and current state. Wait for the user to confirm or explicitly skip, then resume their original request. Use existing settings actions for changes and show the updated summary before confirmation.' : 'Continue the user’s request. Reopen the guide when requested; saved settings are preserved.'
    };
  }
  async call(name, input, onProgress, signal) {
    if (name === 'web_management') {
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
        await this.store.update(config => { config.webManagement = { enabled: input.enabled }; });
      }
      if (input.enabled === false) await this.web.close(); else await this.web.start();
      return this.web.status();
    }
    if (['local_storage', 'cleanup_local_files'].includes(name)) {
      await this.initialize();
      return name === 'local_storage' ? localStorage(this.stateRoot) : cleanupLocalFiles(this.stateRoot, input);
    }
    if (name === 'resource_statistics') {
      const { tasks } = await this.call(input.role === 'provider' ? 'list_shared_tasks' : 'list_tasks', {}, onProgress, signal);
      return summarizeTasks(tasks, input);
    }
    if (name === 'update_plugin') return updatePlugin(this, input, signal);
    if (name === 'onboarding') return this.onboarding(input);
    if (this.store) {
      // Concurrent controls must reach Sharing in request order after this read.
      const reading = this.onboardingRead ||= this.onboardingStatus().finally(() => { this.onboardingRead = undefined; });
      const status = await reading;
      if (status === 'pending' && ['start_sharing', 'create_pairing', 'pair_peer', 'prepare_work_copy', 'start_task', 'continue_task'].includes(name)) {
        return { status: 'onboarding_required', requestedAction: name, onboarding: await this.onboarding(), nextStep: 'No requested action was performed. Show the complete summary and wait for confirmation or explicit skipping. Then retry the original request with its existing arguments; do not ask the user to repeat it. Task-file consent is separate.' };
      }
      if (status === 'pending' && (name === 'caller_settings' && Object.keys(input).some(key => key !== 'harness') || ['provider_settings', 'configure_model', 'device_settings'].includes(name) && Object.keys(input).length)) {
        await this.store.update(config => { config.onboarding ||= { status: 'pending' }; });
      }
    }
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
    if (name === 'device_settings') {
      if (input.crossNetwork !== undefined && typeof input.crossNetwork !== 'boolean') throw new Error('crossNetwork must be a boolean.');
      if (input.crossNetwork !== undefined) await this.sharing.manage('network', { enabled: input.crossNetwork });
      if (input.name !== undefined) await this.store.update(config => { config.deviceName = deviceName({ deviceName: input.name.trim() }); });
      this.config = await this.store.read();
      return { deviceName: deviceName(this.config), crossNetwork: { ...crossNetwork(this.config), ...((await this.sharing.machineStatus()).crossNetwork || {}) }, note: 'sub2sub display name only. Paired devices learn it on subsequent communication; explicit connection aliases remain unchanged.' };
    }
    if (name === 'resource_usage') {
      if (!input.peer) return this.sharing.manage('usage', {}, signal);
      const peer = this.peer(input.peer);
      const current = await this.connect(peer, { action: 'check' }, onProgress, signal);
      if (!current.usage) return { harness: current.harness || 'codex', status: 'unsupported', checkedAt: new Date().toISOString(), reason: 'This peer does not support quota queries. Update its sub2sub installation.' };
      return this.connect(peer, { action: 'usage' }, onProgress, signal);
    }
    if (name === 'list_models') {
      if (input.peer) return this.connect(this.peer(input.peer), { action: 'models' }, onProgress, signal);
      return this.sharing.manage('models', {}, signal);
    }
    if (name === 'caller_settings') {
      const harness = executionHarness({ harness: input.harness });
      if (Object.keys(input).some(key => key !== 'harness')) await this.store.update(config => {
        const selection = hostSelection({ ...config.caller, ...input });
        if (input.candidateHosts !== undefined && selection.candidateHosts.some(name => !Object.hasOwn(config.peers || {}, name))) throw new Error('候选必须是已有连接。 / Candidate hosts must be existing connections.');
        config.caller ||= {}; config.caller.harnesses ||= {};
        config.caller.harnesses[harness] = executionSettings({ ...harnessSettings(config.caller, harness), ...input }, harness);
        Object.assign(config.caller, transferLimits({ ...config.caller, ...input }));
        if (input.autoSelectHost !== undefined || input.candidateHosts !== undefined) Object.assign(config.caller, selection);
      });
      const saved = (await this.store.read()).caller;
      return { role: 'caller', harness, ...hostSelection(saved), execution: executionSettings(harnessSettings(saved, harness), harness), advanced: transferLimits(saved), supported: { bytes: null, files: null }, note: 'Defaults are shared by nodes using this execution tool. Null means no default has been chosen: list the node models and ask the user to select a model and effort before sending files. Existing tasks keep their own choices. Automatic selection is opt-in, uses candidate order and never reroutes after submission. Candidate settings do not authorize task-file transfer.' };
    }
    if (name === 'provider_settings') return this.sharing.manage('configure', input, signal);
    if (name === 'setup_status') return { configPath: this.store.file, stateRoot: this.stateRoot, nodeVersion: process.version, sharing: await this.sharing.machineStatus(), addresses: Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address), nextStep: 'Host: create_pairing directly, with address if needed. Client: pair_peer with the private invitation after agreeing to the task-file scope.' };
    if (name === 'sharing_status') {
      const current = await this.sharing.machineStatus(), harness = current.harness || executionHarness(this.config.provider);
      return { ...current, ...(this.programCleanup ? { programCleanup: await this.programCleanup } : {}), harness, allowedModels: allowedModels(harnessSettings(this.config.provider, harness)) };
    }
    if (name === 'configure_model') {
      if (Object.keys(input).length) await this.store.update(config => {
        const selected = executionSettings({ ...harnessSettings(config.provider, 'codex'), ...input });
        config.provider = { ...config.provider, ...selected, allowedModels: [selected.model] };
        config.provider.harnesses ||= {};
        config.provider.harnesses.codex = { ...config.provider.harnesses.codex, ...selected, allowedModels: [selected.model] };
      });
      return { ...executionSettings((await this.store.read()).provider), note: 'Legacy host setting restricts sharing to this model. It no longer replaces client choices. Use caller_settings and provider_settings.' };
    }
    if (name === 'pair_peer') return pairPeer(this.store, input, signal, (...args) => this.networkRequest(...args));
    if (name === 'authorize_peer') {
      const transferAuthorization = { scope: input.allowTaskFiles ? 'task-files' : 'none', updatedAt: new Date().toISOString() };
      if (input.allowTaskFiles && input.retentionPolicy) {
        const current = await this.connect(this.peer(input.peer), { action: 'check' }, onProgress, signal);
        if (!current.retentionPolicy) throw new Error('The host retention policy changed. Review its current rule before authorizing.');
        requireRetentionConsent({ transferAuthorization: { retentionPolicy: input.retentionPolicy } }, current.retentionPolicy);
        transferAuthorization.retentionPolicy = current.retentionPolicy;
      }
      await this.store.update(config => {
        if (!Object.hasOwn(config.peers || {}, input.peer)) throw new Error(`Unknown peer: ${input.peer}`);
        config.peers[input.peer].transferAuthorization = transferAuthorization;
      });
      return { peer: input.peer, transferAuthorization, transferScope: TASK_FILE_SCOPE };
    }
    if (name === 'list_pairings') return this.sharing.pairings();
    if (name === 'pairing_settings') return this.sharing.manage('configurePairing', input, signal);
    if (name === 'revoke_pairing') return this.sharing.manage('revoke', input, signal);
    if (name === 'cleanup_shared_tasks') return this.sharing.manage('cleanupPair', input, signal);
    if (name === 'cleanup_shared_task') return this.sharing.manage('cleanupTask', input, signal);
    if (name === 'list_shared_tasks') return this.sharing.tasks(input.details);
    if (name === 'cancel_shared_task') return this.sharing.cancel(input);
    if (name === 'list_peers') {
      const peers = await Promise.all(Object.entries(this.config.peers || {}).map(async ([name, peer]) => {
        const summary = { name, displayName: peer.displayName || name, deviceName: peer.deviceName, transport: peer.transport, crossNetwork: Boolean(peer.tailcat), transferAuthorization: peer.transferAuthorization || { scope: 'none' } };
        if (input.check === false) return { ...summary, status: 'unchecked' };
        try { const current = await this.connect(peer, { action: 'check' }, onProgress, signal); return { ...summary, displayName: peer.displayName || name, deviceName: peer.deviceName, status: current.status || 'available', connectionRoute: current.connectionRoute, harness: current.harness || 'codex', limits: current.limits, retentionPolicy: current.retentionPolicy, connection: current.connection, checkedAt: new Date().toISOString() }; }
        catch (error) { return { ...summary, status: 'unreachable', reason: error.message, checkedAt: new Date().toISOString() }; }
      }));
      const guidance = {
        available: 'Choose an available peer for your task.',
        expired: 'Ask the host to extend the original connection. Existing task results remain accessible.',
        budget_exhausted: 'Ask the host to raise this connection’s cumulative Token limit. Existing results remain accessible.',
        budget_paused: 'The host must review missing final usage in this connection’s budget settings. Existing results remain accessible.',
        busy: 'Busy peers have reached node or connection capacity; wait for a task to finish before delegating another.',
        stopped: 'Start sharing on stopped peers before delegating. Existing results remain accessible.',
        unreachable: 'Check the network and whether sub2sub is running on unreachable peers.',
        unchecked: 'Availability has not been checked; request a live status check when needed.'
      };
      return { peers, setupNeeded: peers.length === 0, nextStep: peers.length === 0 ? 'Share your Codex: ask to generate an invitation. Use another device: paste its invitation to connect.' : [...new Set(peers.map(peer => guidance[peer.status]))].join(' '), transferScope: TASK_FILE_SCOPE };
    }
    if (name === 'check_peer') return this.connect(this.peer(input.peer), { action: 'check' }, onProgress, signal);
    await this.initialize();
    if (name === 'edit_peer' || name === 'delete_peer') return this.editConnection(name, input, onProgress, signal);
    if (name === 'list_tasks') {
      const files = await fs.readdir(path.join(this.stateRoot, 'tasks'));
      const tasks = [];
      for (const file of files.filter(file => file.endsWith('.json'))) {
        const saved = await readJson(path.join(this.stateRoot, 'tasks', file));
        const connection = saved.peerId ? Object.entries(this.config.peers || {}).find(([, peer]) => (peer.pairId || peer.id) === saved.peerId)?.[0] : saved.peer;
        tasks.push({ taskId: taskId(file.slice(0, -5)), harness: saved.harness || 'codex', keepSessionVisible: saved.keepSessionVisible, sessionVisibility: saved.sessionVisibility, peer: connection || saved.peer, peerDisplayName: this.config.peers?.[connection]?.displayName || connection || saved.peer, connectionPresent: Boolean(connection && this.config.peers?.[connection]), createdAt: saved.createdAt, endedAt: saved.endedAt, retentionDays: saved.retentionDays, cleanupAllOnExpiry: saved.cleanupAllOnExpiry, expiresAt: saved.expiresAt, status: saved.status, revision: saved.revision, rounds: saved.finished ? undefined : measuredRounds(saved.rounds), finished: Boolean(saved.finished), cleanupStatus: saved.cleanupStatus, localFilesCleaned: saved.localFilesCleaned, resultDirectory: saved.resultDirectory, responseFile: saved.resultDirectory ? path.join(saved.resultDirectory, 'response.md') : undefined, workCopyDirectory: saved.workCopyRoot ? path.join(saved.workCopyRoot, 'files') : undefined, savedRevision: saved.savedRevision, savedAt: saved.savedAt, skipped: saved.skipped, deliveryPending: saved.deliveryPending });
      }
      tasks.sort((a, b) => (b.endedAt || b.createdAt || '').localeCompare(a.endedAt || a.createdAt || ''));
      return { tasks, note: 'Local records only. To show saved results, read the requested output files under workCopyDirectory, the saved answer at responseFile, and resultDirectory/changes.json for skipped outputs and execution errors. Present the output and saved answer as Markdown links with complete absolute local targets; for spaces use [Output](</full/local/path>). No host connection is needed. deliveryPending=true means the latest requested execution has not been confirmed saved locally; listed files are from the previous save. Missing times or deliveryPending mean unknown freshness. Use task_status only when current host state is requested.' };
    }
    if (name === 'prepare_work_copy') {
      const peer = input.peer ? this.peer(input.peer) : undefined;
      const { autoSelectHost, candidateHosts } = hostSelection(this.config.caller);
      const destinations = !peer && autoSelectHost ? candidateHosts.map(name => {
        const candidate = this.peer(name);
        return { peer: name, transport: candidate.transport, host: candidate.host, transferAuthorization: candidate.transferAuthorization || { scope: 'none' } };
      }) : undefined;
      const id = randomUUID();
      const frozen = path.join(this.stateRoot, 'snapshots', `${id}.json`);
      await fs.mkdir(frozen, { mode: 0o700 });
      let copy;
      try {
        copy = await snapshot(input.workspace, input.paths, { ...fileLimits(this.config.caller, 'input'), storage: path.join(frozen, 'files') });
        await writeJson(path.join(frozen, 'metadata.json'), copy);
      } catch (error) { await fs.rm(frozen, { recursive: true, force: true }); throw error; }
      return { snapshotId: id, warning: transferWarning(copy.bytes), fileCount: copy.files.length, bytes: copy.bytes, files: copy.files.map(f => f.path), excluded: copy.skipped, ...(peer ? { destination: { peer: input.peer, transport: peer.transport, host: peer.host }, transferAuthorization: peer.transferAuthorization || { scope: 'none' }, transferScope: TASK_FILE_SCOPE } : destinations ? { destinations, transferScope: TASK_FILE_SCOPE } : {}), note: 'Local frozen copy only; no files have been sent. Candidate lists do not authorize transfers.' };
    }
    if (name === 'start_task') {
      const copy = await readJson(path.join(this.stateRoot, 'snapshots', `${taskId(input.snapshotId)}.json`));
      const selected = input.peer ? { name: input.peer, peer: this.peer(input.peer) } : await this.selectHost(input, copy, onProgress, signal);
      const { peer, name: peerName, selection } = selected;
      if (peer.transport === 'lan' && peer.transferAuthorization?.scope !== 'task-files') throw new Error('Task-file transfer is not authorized for this peer. Explain the scope once, obtain user consent, then use authorize_peer. No files were sent.');
      const capabilities = selected.capabilities || await this.capabilities(peer, onProgress, signal);
      requireRetentionConsent(peer, capabilities.retentionPolicy);
      const harness = executionHarness(capabilities);
      if (input.harness !== undefined && executionHarness(input) !== harness) throw new Error(`Selected host does not offer the requested ${input.harness} execution tool. No files were sent.`);
      const settings = executionSettings({ ...harnessSettings(this.config.caller, harness), ...input }, harness);
      requireModel(settings, capabilities);
      const limits = effectiveLimits(this.config.caller, capabilities.transferProtocol === 3 ? capabilities.limits : legacyLimits(capabilities.limits));
      try { validateFiles(copy.files, fileLimits(limits, 'input')); }
      catch (error) { if (capabilities.transferProtocol !== 3) throw new Error(`Older host transfer limits apply. Upgrade both nodes or reduce this work copy: ${error.message}`, { cause: error }); throw error; }
      const transferProtocol = capabilities.transferProtocol === 3 ? 3 : 2;
      const upload = transferProtocol === 3 ? { files: copy.files } : await legacyMessage({ files: copy.files });
      const id = randomUUID();
      const taskPath = path.join(this.stateRoot, 'tasks', `${id}.json`);
      const saved = { peer: peerName, peerId: peer.pairId || peer.id, snapshotId: input.snapshotId, transferProtocol, harness, ...settings, limits, createdAt: new Date().toISOString(), deliveryPending: true };
      let release;
      let registered = false;
      let result;
      const register = async config => {
        const current = config.peers?.[peerName];
        if (!current || JSON.stringify(current) !== JSON.stringify(peer)) throw new Error('Connection or transfer consent changed before task registration. Query it and try again. No files were sent.');
        const releaseStorage = await processLock(path.join(this.stateRoot, '.local-files-lock'));
        try {
          await readJson(path.join(this.stateRoot, 'snapshots', `${taskId(input.snapshotId)}.json`));
          release = await processLock(path.join(this.stateRoot, 'tasks', '.locks', id));
          await writeJson(taskPath, saved);
        } finally { await releaseStorage(); }
      };
      try {
        if (this.store) await this.store.update(register); else await register(this.config);
        registered = true;
        if (transferWarning(copy.bytes)) onProgress?.(transferWarning(copy.bytes));
        onProgress?.(`Created task ${id}. Sending ${copy.files.length} files (${copy.bytes} bytes).`);
        result = await this.connect({ ...peer, transferCompression: capabilities.transferCompression }, { action: 'run', protocol: transferProtocol, taskId: id, snapshot: upload, prompt: input.prompt, ...(capabilities.retentionPolicy ? { retentionPolicy: capabilities.retentionPolicy } : {}), ...settings, ...(capabilities.harness ? { harness } : {}), limits }, onProgress, signal);
        await writeJson(taskPath, { ...saved, status: result.status, revision: result.revision, rounds: measuredRounds(result.rounds), endedAt: result.endedAt, keepSessionVisible: result.keepSessionVisible, sessionVisibility: result.sessionVisibility, retentionDays: result.retentionDays, cleanupAllOnExpiry: result.cleanupAllOnExpiry, expiresAt: result.expiresAt });
        if (result.stopReason === 'time_limit') return { ...await this.saveTimeLimitResult(result, onProgress, signal), peer: peerName, ...(selection ? { selection } : {}) };
        return { ...result, peer: peerName, ...(selection ? { selection } : {}), deliveryPending: true };
      }
      catch (error) {
        const next = result ? '. An execution response was received. Retry collect_result on this task after resolving the save error; do not rerun the work to retry saving.'
          : registered ? '. Query task_status for this task before submitting again; an interrupted response does not confirm execution stopped.' : '';
        throw new Error(`Task ${id}: ${error.message}${next} Selected host: ${peerName}. 不自动换共享端重发。 / No automatic host retry.`, { cause: error });
      }
      finally { await release?.(); }
    }
    if (['task_status', 'cancel_task'].includes(name)) return this.taskCall(name, input, onProgress, signal);
    const release = await processLock(path.join(this.stateRoot, 'tasks', '.locks', taskId(input.taskId)));
    try { return await this.taskCall(name, input, onProgress, signal); }
    catch (error) {
      if (name === 'collect_result') throw new Error(`Task ${input.taskId}: collecting or saving results failed: ${error.message}. Retry collect_result on this task after resolving the reported error; do not rerun the work to retry saving.`, { cause: error });
      throw error;
    }
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
    if (name === 'finish_task' && input.cleanup === 'keep') return { taskId: id, status: 'retained', cleanupStatus: task.cleanupStatus, resultDirectory: task.resultDirectory, retentionDays: task.retentionDays, cleanupAllOnExpiry: task.cleanupAllOnExpiry, expiresAt: task.expiresAt, note: (task.cleanupAllOnExpiry ? 'Accepted full expiry deletes all host task content and associated native history even if uncollected; the original session cannot continue. Cleanup waits for active or uncertain execution and in-flight transfers. ' : '') + 'No data deleted or restored; the retention policy is unchanged. Keeping does not extend the deadline. expiresAt is the last known deadline; older records or interrupted connections may need task_status to confirm it. Cleanup runs while the host is active. Without accepted full expiry, it also waits for local save confirmation and resolved necessary outputs.' };
    if (task.finished && name !== 'finish_task') {
      if (name === 'task_status') {
        if (input.details) return { ...await this.connect(this.taskPeer(task), { action: 'status', taskId: id, details: true }, onProgress, signal), localCleanupRecord: task.cleanupStatus, resultDirectory: task.resultDirectory };
        return { taskId: id, status: task.cleanupStatus || 'finished', resultDirectory: task.resultDirectory, note: 'Local cleanup record only. Use details=true to check remote files now.' };
      }
      throw new Error('Task was finished and its work copy removed. Start a new task to do more work.');
    }
    if (task.localFilesCleaned && ['continue_task', 'collect_result'].includes(name)) throw new Error('Local task files were cleared. This task can no longer be collected or continued by this installation. Remote files may still exist; local cleanup did not remove them. Start a new task with the required inputs.');
    const peer = this.taskPeer(task);
    if (task.pendingSave && ['collect_result', 'continue_task', 'finish_task'].includes(name)) {
      await checkWorkCopy(this.stateRoot, id, task.workCopyRoot, task.workCopyPaths);
      await this.connect(peer, { action: 'ack', taskId: id, ...task.pendingSave }, onProgress, signal);
      delete task.pendingSave; await writeJson(taskPath, task);
    }
    if (name === 'continue_task' && peer.transport === 'lan' && peer.transferAuthorization?.scope !== 'task-files') throw new Error('Follow-up instructions are not authorized for this peer. Use authorize_peer only after user consent.');
    if (name === 'finish_task') {
      if (!task.finished) {
        if (!task.resultDirectory && !(task.localFilesCleaned && task.resultRevision !== undefined)) throw new Error('Collect the result locally before finishing.');
        if (task.workCopyRoot) await checkWorkCopy(this.stateRoot, id, task.workCopyRoot, task.workCopyPaths);
        const collected = task.localFilesCleaned ? { skipped: task.skipped || [] } : await readJson(path.join(task.resultDirectory, 'changes.json'));
        const discard = input.discardPaths === undefined ? [] : input.discardPaths;
        if (!Array.isArray(discard)) throw new Error('discardPaths must be an array of skipped paths that are no longer needed.');
        for (const skipped of discard) safePath(skipped);
        const unresolved = collected.skipped.filter(skipped => !discard.includes(skipped));
        if (unresolved.length) throw new Error(`Resolve skipped paths before cleanup: ${unresolved.join(', ')}. Recover needed outputs and collect again, or list only unneeded paths in discardPaths.`);
      }
      const finished = await this.connect(peer, { action: 'finish', protocol: task.transferProtocol || 2, ...(task.harness === 'claude' ? { harness: 'claude' } : {}), taskId: id, revision: task.resultRevision, discardPaths: input.discardPaths, cleanup: input.cleanup }, onProgress, signal);
      task.finished = input.cleanup !== 'workcopy';
      task.cleanupStatus = finished.status;
      if (task.finished) delete task.rounds;
      await writeJson(taskPath, task);
      if (task.snapshotId) {
        const releaseStorage = await processLock(path.join(this.stateRoot, '.local-files-lock'));
        try {
          const references = await Promise.all((await fs.readdir(path.join(this.stateRoot, 'tasks'))).filter(f => f.endsWith('.json')).map(f => readJson(path.join(this.stateRoot, 'tasks', f))));
          if (!references.some(t => !t.finished && t.cleanupStatus !== 'released' && t.snapshotId === task.snapshotId)) await fs.rm(path.join(this.stateRoot, 'snapshots', `${taskId(task.snapshotId)}.json`), { recursive: true, force: true });
        } finally { await releaseStorage(); }
      }
      return { ...finished, resultDirectory: task.resultDirectory, note: 'Selected remote cleanup completed. Local source, downloaded results and the local task index remain.' };
    }
    const actions = { continue_task: 'run', task_status: 'status', cancel_task: 'cancel', collect_result: 'result' };
    if (!actions[name]) throw new Error(`Unknown tool: ${name}`);
    let settings, restoration, executionTool, upload, transferCompression;
    if (name === 'continue_task') {
      // Old local indexes lack execution settings; read the task, not current defaults.
      const remote = await this.connect(peer, { action: 'status', taskId: id }, onProgress, signal);
      if (['expired', 'expiring'].includes(remote.status) || remote.cleanupAllOnExpiry && Date.now() >= Date.parse(remote.expiresAt)) throw new Error('Task retention expired. The original session cannot continue; start a new task from available local files.');
      const previous = task.model ? task : remote;
      const harness = executionHarness(previous);
      settings = executionSettings({ ...previous, ...input }, harness);
      const capabilities = await this.capabilities(peer, onProgress, signal);
      transferCompression = capabilities.transferCompression;
      if (executionHarness(capabilities) !== harness) throw new Error(`This task uses ${harness}. Ask the host to switch back before continuing it.`);
      executionTool = capabilities.harness ? { harness } : undefined;
      task.transferProtocol = capabilities.transferProtocol === 3 ? 3 : 2;
      requireModel(settings, capabilities);
      if (input.snapshotId !== undefined || input.deletePaths !== undefined) {
        if (capabilities.taskFileUpdates !== true || capabilities.transferProtocol !== 3) throw new Error('This host does not support task file updates. Upgrade the host before uploading changes; ordinary follow-up instructions remain available. No files were sent.');
        const prepared = input.snapshotId ? await readJson(path.join(this.stateRoot, 'snapshots', `${taskId(input.snapshotId)}.json`)) : { files: [] };
        await checkWorkCopy(this.stateRoot, id, task.workCopyRoot, task.workCopyPaths);
        const limits = effectiveLimits(task.limits ?? remote.limits ?? legacyLimits(), effectiveLimits(this.config.caller, capabilities.limits));
        upload = await prepareUpload(task, prepared, input.deletePaths ?? [], fileLimits(limits, 'input'), remote);
        const bytes = upload.files.reduce((sum, file) => sum + fileSize(file), 0);
        if (transferWarning(bytes)) onProgress?.(transferWarning(bytes));
        onProgress?.(`Sending ${upload.files.length} changed files (${bytes} bytes); ${upload.removed.length} explicitly deleted files. Unselected files stay unchanged.`);
      }
      if (['released', 'restoring'].includes(remote.status)) {
        const limits = effectiveLimits(task.limits ?? remote.limits ?? legacyLimits(), effectiveLimits(this.config.caller, capabilities.transferProtocol === 3 ? capabilities.limits : legacyLimits(capabilities.limits)));
        const copy = await restoreCopy(this.stateRoot, id, task.workCopyRoot, task.workCopyPaths, fileLimits(limits, 'input'));
        if (transferWarning(copy.bytes)) onProgress?.(transferWarning(copy.bytes));
        if (task.transferProtocol !== 3) copy.files = (await legacyMessage({ files: copy.files })).files;
        restoration = { action: 'restore', revision: task.savedRevision, snapshot: { files: copy.files }, limits };
        if (upload) {
          // Keep each message within the complete-input limit; changed files are not counted twice.
          onProgress?.('The host work copy was cleared. Restoring the complete saved copy before applying changes.');
          await this.connect({ ...peer, transferCompression }, { ...restoration, restoreOnly: true, protocol: 3, taskId: id, prompt: input.prompt, ...settings, ...executionTool }, onProgress, signal);
          restoration = undefined;
        }
        delete task.cleanupStatus;
      }
      Object.assign(task, settings, { deliveryPending: true, status: 'unknown' }); await writeJson(taskPath, task);
    }
    let result;
    try { result = await this.connect({ ...peer, transferCompression }, { action: actions[name], protocol: task.transferProtocol || 2, limits: task.limits ?? legacyLimits(), taskId: id, prompt: input.prompt, details: input.details, ...(upload ? { upload } : {}), ...settings, ...executionTool, ...restoration }, onProgress, signal); }
    catch (error) {
      if (name === 'continue_task') throw new Error(`Task ${id}: ${error.message}. Query task_status for this task before submitting again; an interrupted response does not confirm execution stopped.`, { cause: error });
      throw error;
    }
    if (name === 'task_status') {
      let release;
      try { release = await processLock(path.join(this.stateRoot, 'tasks', '.locks', id)); }
      catch (error) { if (error.code !== 'LOCK_BUSY') throw error; }
      if (release) {
        try {
          let current;
          try { current = await readJson(taskPath); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          // A status read must not overwrite a turn/save that completed meanwhile.
          if (current && JSON.stringify(current) === JSON.stringify(task)) await writeJson(taskPath, { ...current, status: result.status });
        } finally { await release(); }
      }
    }
    if (name === 'continue_task' || name === 'collect_result') {
      Object.assign(task, { status: result.status, revision: result.revision, rounds: measuredRounds(result.rounds), endedAt: result.endedAt, keepSessionVisible: result.keepSessionVisible, sessionVisibility: result.sessionVisibility, retentionDays: result.retentionDays, cleanupAllOnExpiry: result.cleanupAllOnExpiry, expiresAt: result.expiresAt });
      if (name === 'continue_task') {
        try { await writeJson(taskPath, task); }
        catch (error) { throw new Error(`Task ${id}: saving the received execution response failed: ${error.message}. Retry collect_result on this task after resolving the save error; do not rerun the work to retry saving.`, { cause: error }); }
      }
    }
    if (name === 'continue_task' && result.stopReason === 'time_limit') return this.saveTimeLimitResult(result, onProgress, signal);
    if (name !== 'collect_result') return { ...result, ...(task.workCopyRoot ? { workCopyDirectory: path.join(task.workCopyRoot, 'files'), savedAt: task.savedAt } : {}), ...(name === 'continue_task' ? { deliveryPending: true, note: 'This execution still needs collect_result before delivery. Any local workCopyDirectory is from the previous save.' } : {}) };
    try {
    const resultLimits = fileLimits(task.limits ?? legacyLimits(), 'result');
    validateFiles(result.changes.files, { result: true, ...resultLimits });
    if (!Array.isArray(result.changes.removed) || typeof result.response !== 'string') throw new Error('Invalid result from peer.');
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
    delete task.localFilesCleaned;
    task.resultDirectory = directory;
    task.resultRevision = result.revision;
    task.workCopyRoot = workCopyRoot;
    task.workCopyPaths = expectedPaths;
    task.savedAt = new Date().toISOString();
    task.deliveryPending = false;
    task.skipped = result.changes.skipped;
    if (result.syncId) {
      task.savedRevision = result.revision;
      task.pendingSave = { syncId: result.syncId, revision: result.revision };
    }
    await writeJson(taskPath, task);
    if (task.pendingSave) {
      try { await this.connect(peer, { action: 'ack', taskId: id, ...task.pendingSave }, onProgress, signal); }
      catch (error) { throw new Error(`Saved locally at ${path.join(workCopyRoot, 'files')}; confirmation failed: ${error.message}. Retry collect_result.`, { cause: error }); }
      delete task.pendingSave; await writeJson(taskPath, task);
    }
    return { taskId: id, status: result.status, rounds: measuredRounds(task.rounds), stopReason: result.stopReason, keepSessionVisible: result.keepSessionVisible, sessionVisibility: result.sessionVisibility, model: result.model, reasoningEffort: result.reasoningEffort, error: result.error, resultDirectory: directory, responseFile: path.join(directory, 'response.md'), workCopyDirectory: path.join(workCopyRoot, 'files'), savedAt: task.savedAt, savedRevision: task.savedRevision, deliveryPending: false, changed: result.changes.files.map(f => f.path), removed: result.changes.removed, skipped: result.changes.skipped, note: 'Files and text response are saved locally. Read the main output and responseFile, then include both as Markdown links with complete absolute local targets in the final answer. The complete task copy is reused when files have not changed. Resolve skipped necessary outputs before cleanup.' };
    } finally { await releaseReceived(result); }
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
          try { current = peer.transport === 'lan' ? await this.networkRequest({ ...peer, localDeviceName: deviceName(config) }, '/rpc', { action: 'status', taskId: record.id }, onProgress, signal) : await connect(peer, { action: 'status', taskId: record.id }, onProgress, signal); }
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
        if (config.caller?.candidateHosts) config.caller.candidateHosts = config.caller.candidateHosts.filter(name => name !== input.peer);
        return { peer: input.peer, status: 'deleted', remoteTasks: remaining, note: 'The local connection was deleted. Remote pairing and files, and saved local results remain. This connection can no longer continue its old tasks; pairing the same device again creates a new connection and does not restore that access. View saved local results with list_tasks.' };
      }
      const nextName = input.name || input.peer;
      if (typeof nextName !== 'string' || !nextName.trim() || nextName.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(nextName)) throw new Error('Choose a connection name of 1–100 characters.');
      if (nextName !== input.peer && Object.hasOwn(config.peers, nextName)) throw new Error('That connection name is already in use.');
      let migrated;
      if (input.invitation !== undefined && input.migrate !== true) throw new Error('Use migrate: true to update an existing connection with an invitation.');
      if (input.migrate !== undefined && input.migrate !== true) throw new Error('migrate must be true for an explicit connection migration.');
      if (input.migrate) {
        if (peer.transport !== 'lan') throw new Error('Only an existing paired connection can migrate. SSH/local developer connections do not have a pairing identity.');
        if (!crossNetwork(config).enabled) throw new Error('Enable cross-network connections explicitly on both devices before migrating.');
        if (input.host !== undefined || input.port !== undefined) throw new Error('Use an invitation for migration, or edit a direct address separately.');
        let endpoint;
        if (input.invitation) endpoint = invitation(input.invitation);
        else {
          try { endpoint = (await this.networkRequest(peer, '/rpc', { action: 'network' }, onProgress, signal)).endpoint; }
          catch (error) { throw new Error(`Cannot obtain this host's cross-network address: ${error.message}. Enable the service on the host and update older nodes. If its old address is unavailable, supply a new invitation from that same device; do not delete or re-pair.`, { cause: error }); }
        }
        if (endpoint?.fingerprint !== peer.fingerprint) throw new Error('The invitation or endpoint belongs to a different host identity. The original connection was retained.');
        if (typeof endpoint.tailcat !== 'string' || !endpoint.tailcat) throw new Error('This invitation cannot describe cross-network access. Update the host and enable cross-network connections before creating a new invitation. The original direct connection was retained.');
        migrated = { ...peer, host: endpoint.host, port: endpoint.port, tailcat: endpoint.tailcat };
        // Verify the advertised Tailcat endpoint with the existing token even when LAN is available.
        const probe = await this.sharing.manage('request', { peer: migrated, route: '/rpc', request: { action: 'check' } }, signal, onProgress);
        if (probe.remoteDeviceName) migrated.deviceName = probe.remoteDeviceName;
      }
      if (input.host !== undefined || input.port !== undefined) {
        if (peer.transport !== 'lan') throw new Error('Address editing is supported for LAN peers only.');
        const current = await connect({ ...peer, localDeviceName: deviceName(config), host: input.host ?? peer.host, port: input.port ?? peer.port }, { action: 'check' }, onProgress, signal);
        if (current.remoteDeviceName) peer.deviceName = current.remoteDeviceName;
      }
      for (const record of records.filter(r => !r.saved.peerId)) await writeJson(record.target, { ...record.saved, peerId: identity });
      if (migrated) Object.assign(peer, migrated);
      peer.id = identity;
      if (input.name !== undefined) peer.automaticName = false;
      if (input.host !== undefined) peer.host = input.host;
      if (input.port !== undefined) peer.port = input.port;
      delete config.peers[input.peer]; config.peers[nextName] = peer;
      if (config.caller?.candidateHosts) config.caller.candidateHosts = config.caller.candidateHosts.map(name => name === input.peer ? nextName : name);
      connectionNames(Object.values(config.peers), p => p.automaticName ? p.deviceName : Object.keys(config.peers).find(key => config.peers[key] === p));
      return { peer: nextName, status: 'updated', crossNetwork: Boolean(peer.tailcat), note: 'Task association, host identity and transfer consent are preserved.' };
    });
    } finally { for (const release of releases.reverse()) await release(); }
  }
  async close() { await this.web.close(); await this.sharing?.close(); }
}
