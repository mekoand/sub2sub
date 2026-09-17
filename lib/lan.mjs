import { STREAM_TYPE, writeMessage, readMessages, readRequest, releaseReceived, retainReceived, parseLegacy, legacyMessage } from './transfer.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';
import packageInfo from '../package.json' with { type: 'json' };
import { providerRequest, taskId, inspectTask } from './provider.mjs';
import { readJson, writeJson } from './files.mjs';
import { deviceName, connectionNames, codexExecutable, executionExecutable, executionHarness, harnessSettings, allowedModels, executionSettings, retentionDays, maxConcurrent, keepSessionVisible, TASK_FILE_SCOPE } from './config.mjs';
import { processLock } from './lock.mjs';
import { manageTaskHistory } from './codex-history.mjs';
import { queryModels, queryExecutionModels, modelCapabilities, requireModel } from './models.mjs';
import { transferLimits, fileLimits, WIRE_BYTES } from './limits.mjs';
import { queryUsage } from './usage.mjs';
import { manageClaudeHistory } from './claude.mjs';
import { launchWindowsNode } from './windows-node.mjs';
import { startTailcat } from './tailcat.mjs';
import { crossNetwork } from './config.mjs';
import { measuredUsage } from './task-usage.mjs';

const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const matches = (value, hash) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));

function pairingRules(peer) {
  const limit = peer.maxConcurrent ?? null, expiresAt = peer.expiresAt ?? null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Connection maxConcurrent must be a positive safe integer or null.');
  if (expiresAt !== null && (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== (expiresAt.includes('.') ? expiresAt : expiresAt.replace('Z', '.000Z')))) throw new Error('Connection expiresAt must be a valid UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ) or null.');
  const tokenLimit = peer.tokenLimit ?? null, account = peer.tokenBudget;
  if (tokenLimit !== null && (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1)) throw new Error('Connection tokenLimit must be a positive safe integer or null.');
  if (account !== undefined) {
    if (!account || !Number.isSafeInteger(account.usedTokens) || account.usedTokens < 0 || typeof account.incomplete !== 'boolean' || typeof account.paused !== 'boolean' || !account.pending || typeof account.pending !== 'object' || Array.isArray(account.pending)) throw new Error('Invalid saved connection Token budget.');
    for (const [id, receipt] of Object.entries(account.pending)) {
      taskId(id); taskId(receipt?.taskId);
      if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw new Error('Invalid pending budget round.');
    }
  }
  const usedTokens = account?.usedTokens ?? 0;
  const budget = { limit: tokenLimit, usedTokens, remainingTokens: tokenLimit === null ? null : Math.max(0, tokenLimit - usedTokens), status: tokenLimit === null ? 'disabled' : account?.paused ? 'paused' : usedTokens >= tokenLimit ? 'exhausted' : 'available', incomplete: account?.incomplete ?? false, pendingRounds: Object.keys(account?.pending || {}).length };
  return { maxConcurrent: limit, expiresAt, authorizationStatus: expiresAt !== null && Date.now() >= Date.parse(expiresAt) ? 'expired' : 'active', budget };
}

function requireBudget(peer) {
  const { budget } = pairingRules(peer);
  if (budget.status === 'paused') throw new Error('Connection Token budget is paused because final usage is incomplete. Ask the host to explicitly accept the gap in connection settings. Existing results remain accessible.');
  if (budget.status === 'exhausted') throw new Error('Connection Token budget is exhausted. Ask the host to raise its cumulative limit; existing results remain accessible.');
}

function settleBudget(peer, id, round) {
  const account = peer?.tokenBudget;
  if (!account?.pending[id]) return;
  const usage = measuredUsage(round?.usage);
  const tokens = usage?.source === 'claude-agent-sdk'
    ? (usage.models || []).reduce((total, model) => total + ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'].reduce((sum, key) => sum + (model.tokens[key] ?? 0), 0), 0)
    : usage?.tokens.totalTokens ?? (usage?.tokens.inputTokens ?? 0) + (usage?.tokens.outputTokens ?? 0);
  const total = account.usedTokens + tokens;
  if (!Number.isSafeInteger(total)) throw new Error('Connection Token budget exceeds supported integer precision.');
  account.usedTokens = total;
  if (!round?.endedAt || usage?.status !== 'observed') account.incomplete = account.paused = true;
  // Remove the in-flight receipt in the same atomic write as the cumulative
  // counter. Repeated completion/recovery cannot charge it twice.
  delete account.pending[id];
}

function privateIPv4(value) {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
function address(value) {
  if (!privateIPv4(value)) throw new Error('Use a private-network IPv4 address. Public internet endpoints are not supported.');
  return value;
}
function sharingAddress(input, config) {
  if (input.address) return address(input.address);
  const interfaces = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4');
  const saved = config.provider?.address;
  if (saved && interfaces.some(n => n.address === saved)) return address(saved);
  const choices = [...new Set(interfaces.filter(n => !n.internal).map(n => n.address).filter(privateIPv4))];
  if (choices.length !== 1) throw new Error(`Select a private-network address with start_sharing.address. Available: ${choices.join(', ') || 'none; connect to your private network first'}.`);
  return address(choices[0]);
}
function endpoint(value) {
  address(value.host);
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.fingerprint !== 'string' || !/^[A-F0-9]{64}$/.test(value.fingerprint)) throw new Error('Invalid LAN endpoint or certificate identity.');
}
export function invitation(text) {
  if (typeof text !== 'string' || !text.startsWith('sub2sub:') || text.length > 4096) throw new Error('Invalid pairing invitation. Ask the host for a new invitation.');
  let value;
  try { value = JSON.parse(Buffer.from(text.slice(8), 'base64url').toString()); }
  catch (error) { throw new Error('Invalid pairing invitation.', { cause: error }); }
  if (!value || ![1, 2].includes(value.version) || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) throw new Error('Unsupported or invalid pairing invitation.');
  endpoint(value);
  if (value.version === 1) delete value.tailcat;
  if (value.version === 2 && (typeof value.tailcat !== 'string' || !value.tailcat || value.tailcat.length > 4096)) throw new Error('Invalid cross-network invitation.');
  return value;
}

// Pin the provider certificate before sending HTTP headers, tokens, or a body.
export function lanRequest(peer, route, input, onProgress = () => {}, signal, options = {}) {
  endpoint(peer);
  return new Promise((resolve, reject) => {
    let request, timer, connectTimer, finished = false, sent = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(connectTimer);
      signal?.removeEventListener('abort', abort);
      if (error) { error.notSubmitted = !sent; request?.destroy(); reject(error); } else resolve(result);
    };
    const abort = () => done(new Error('Connection interrupted. Query the existing task status before resuming; it may still be running on the host.'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const streaming = input.protocol === 3 || route === '/local' && peer.transferProtocol === 3;
    if (route === '/local' && !streaming && input.request?.protocol === 3) { done(new Error('The local sharing node uses the older transfer protocol. Finish active work, then restart the node with the updated installation before transferring files.')); return; }
    const body = streaming ? undefined : JSON.stringify(input);
    if (!streaming && Buffer.byteLength(body) > WIRE_BYTES + (route === '/local' ? 8192 : 0)) { done(new Error('LAN request exceeds supported transport size.')); return; }
    request = https.request({
      hostname: peer.host, port: peer.port, path: route, method: 'POST', agent: false,
      rejectUnauthorized: false, minVersion: 'TLSv1.2',
      headers: { 'content-type': streaming ? STREAM_TYPE : 'application/json', ...(streaming ? {} : { 'content-length': Buffer.byteLength(body) }), ...(peer.localDeviceName ? { 'x-sub2sub-device-name': encodeURIComponent(peer.localDeviceName) } : {}), ...(peer.token ? { authorization: `Bearer ${peer.token}` } : {}) }
    }, response => {
      if (response.headers['content-type'] === STREAM_TYPE) {
        void (async () => {
          let result, received;
          try {
            for await (const message of readMessages(response, options.receiveLimits ?? ((input.action === 'result' ? input : input.request)?.action === 'result' ? fileLimits((input.action === 'result' ? input : input.request).limits, 'result') : {}))) {
              resetTimer();
              if (Object.hasOwn(message, 'error')) throw Object.assign(new Error(`Peer: ${message.error}`), { code: message.code });
              if (Object.hasOwn(message, 'result')) {
                if (received) { await releaseReceived(message); throw new Error('Duplicate transfer result.'); }
                received = message; result = retainReceived(message, message.result);
              } else if (typeof message.progress === 'string') { onProgress(message.progress); await releaseReceived(message); }
              else throw new Error('Invalid transfer response.');
            }
            if (!received || response.statusCode !== 200) throw new Error('Incomplete transfer response.');
            if (response.headers['x-sub2sub-device-name']) result.remoteDeviceName = deviceName({ deviceName: decodeURIComponent(response.headers['x-sub2sub-device-name']) });
            done(undefined, result);
          } catch (error) { await releaseReceived(received); done(error); }
        })();
        return;
      }
      response.setEncoding('utf8');
      let remoteDeviceName;
      try { if (response.headers['x-sub2sub-device-name']) remoteDeviceName = deviceName({ deviceName: decodeURIComponent(response.headers['x-sub2sub-device-name']) }); }
      catch (error) { done(error); return; }
      let bytes = 0, buffer = '', result, failure;
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > WIRE_BYTES) { done(new Error('LAN response exceeds supported transport size.')); return; }
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const message = parseLegacy(line);
            if (Object.hasOwn(message, 'error')) failure = Object.assign(new Error(`Peer: ${message.error}`), { code: message.code });
            else if (Object.hasOwn(message, 'result')) result = message.result;
            else if (typeof message.progress === 'string') onProgress(message.progress);
            else throw new Error('Invalid LAN response.');
          } catch (error) { done(error); return; }
        }
      });
      response.on('error', error => done(error));
      response.on('end', () => done(failure || (response.statusCode !== 200 || buffer || result === undefined ? new Error(`Incomplete LAN response (${response.statusCode}). Check the task status before retrying.`) : undefined), remoteDeviceName ? { ...result, remoteDeviceName } : result));
    });
    request.on('error', error => done(Object.assign(new Error(`LAN connection failed: ${error.message}. Check that the host has sharing enabled.`, { cause: error }), { beforeSend: !sent })));
    request.on('socket', socket => socket.once('secureConnect', () => {
      try {
        const cert = new X509Certificate(socket.getPeerCertificate().raw);
        if (cert.fingerprint256.replaceAll(':', '') !== peer.fingerprint) throw new Error('Host certificate does not match the paired identity. No task or credential was sent.');
        // A newly created certificate may be seconds ahead of the caller clock.
        // Identity is still pinned; expiry is never extended.
        if (Date.now() + 5 * 60 * 1000 < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) throw new Error('Host certificate is not currently valid. Check both device clocks or renew an expired identity; no task or credential was sent.');
        clearTimeout(connectTimer);
        sent = true;
        if (streaming) {
          void writeMessage(request, input).then(() => request.end(), error => done(error));
        } else request.end(body);
      } catch (error) { done(error); }
    }));
    connectTimer = setTimeout(() => done(Object.assign(new Error('LAN connection timed out. Check the host address and sharing status.'), { beforeSend: !sent })), options.connectTimeout ?? 15000);
    const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => done(new Error('Connection stalled. Query the task status before resuming.')), options.requestTimeout ?? 31 * 60 * 1000); };
    request.on('socket', socket => { socket.on('data', resetTimer); socket.on('drain', resetTimer); });
    resetTimer();
  });
}

export async function pairPeer(store, input, signal, request = lanRequest) {
  if (input.peer !== undefined && (typeof input.peer !== 'string' || !input.peer.trim() || input.peer.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(input.peer))) throw new Error('Choose a peer name of 1–100 characters.');
  const config = await store.read();
  if (input.peer && Object.hasOwn(config.peers || {}, input.peer)) throw new Error('That peer name is already configured. Choose another name.');
  const invite = invitation(input.invitation);
  const paired = await request(invite, '/pair', { secret: invite.secret, name: deviceName(config) }, undefined, signal);
  taskId(paired.pairId);
  if (!/^[A-Za-z0-9_-]{43}$/.test(paired.token) || typeof paired.name !== 'string' || paired.name.length > 100) throw new Error('Invalid pairing response from host.');
  const harness = executionHarness(paired);
  const transferAuthorization = { scope: input.allowTaskFiles === true ? 'task-files' : 'none', updatedAt: new Date().toISOString() };
  let peerName = input.peer;
  await store.update(current => {
    current.peers ||= {};
    if (!peerName) { peerName = paired.name; let suffix = 2; while (Object.hasOwn(current.peers, peerName) || ['__proto__', 'constructor', 'prototype'].includes(peerName)) peerName = `${paired.name} ${suffix++}`; }
    if (Object.hasOwn(current.peers, peerName)) throw new Error('Peer name was configured by another operation. Pair again using a different name.');
    current.peers[peerName] = { deviceName: paired.name, automaticName: input.peer === undefined, transport: 'lan', host: invite.host, port: invite.port, fingerprint: invite.fingerprint, ...(invite.tailcat ? { tailcat: invite.tailcat } : {}), pairId: paired.pairId, token: paired.token, transferAuthorization };
    connectionNames(Object.entries(current.peers).map(([key, peer]) => Object.assign(peer, { displayBase: peer.displayBase ?? key })), peer => peer.automaticName ? peer.deviceName : Object.keys(current.peers).find(key => current.peers[key] === peer));
  });
  return { peer: peerName, provider: paired.name, pairId: paired.pairId, transport: 'lan', status: 'paired', harness, model: paired.model, reasoningEffort: paired.reasoningEffort, transferAuthorization, transferScope: TASK_FILE_SCOPE };
}

export class Sharing {
  constructor(store, stateRoot, { independent = false } = {}) {
    this.store = store; this.root = path.join(stateRoot, 'sharing');
    this.independent = independent;
    this.accepting = false; this.active = new Map(); this.limit = 4; this.invite = null;
    this.controlSequence = 0;
    this.networkRequests = 0; this.networkFlows = new Map(); this.pendingNetwork = new Map();
  }
  status() {
    const activeTasks = [...this.active.values()].map(({ taskId, pairId }) => ({ taskId, pairId }));
    return { status: this.accepting ? 'sharing' : 'stopped', ...(this.endpoint || {}), ownerPid: process.pid, harness: this.harness, version: packageInfo.version, runtimePath: process.execPath, nodeVersion: process.version, checkedAt: new Date().toISOString(), maintenanceError: this.maintenanceError, crossNetwork: { status: this.networkError ? 'unavailable' : this.tailcat?.alive ? 'ready' : 'idle', reason: this.networkError || this.tailcat?.diagnostics || undefined }, activeTask: activeTasks[0] || null, activeTasks, occupiedSlots: activeTasks.length, maxConcurrent: this.limit };
  }
  async runtime() {
    let runtime;
    try { runtime = await readJson(path.join(this.root, 'runtime.json')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid < 1) throw new Error('Invalid sharing process record.');
    try { process.kill(runtime.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return null;
      // Windows may deny PID probing across logon sessions for the same user.
      // The authenticated local endpoint, rather than this probe, confirms it.
      if (error.code !== 'EPERM') throw error;
    }
    return runtime;
  }
  async machineStatus() {
    if (this.launching) return { status: 'starting', checkedAt: new Date().toISOString(), activeTask: null };
    if (this.server || this.starting) return { ...this.status(), ...(this.starting ? { status: 'starting' } : {}) };
    const runtime = await this.runtime();
    if (!runtime) {
      try { await fs.stat(path.join(this.root, 'listener')); return { status: 'unknown', checkedAt: new Date().toISOString(), reason: 'A listener record exists but its live endpoint is not confirmed.' }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { status: 'stopped', checkedAt: new Date().toISOString(), activeTask: null, activeTasks: [], occupiedSlots: 0, maxConcurrent: maxConcurrent((await this.store.read()).provider) };
    }
    try { return { ...await lanRequest(runtime, '/local', { action: 'status' }), sessionVersion: packageInfo.version }; }
    catch (error) { return { status: 'unreachable', ownerPid: runtime.pid, checkedAt: new Date().toISOString(), reason: error.message }; }
  }
  async manage(action, input = {}, signal, onProgress) {
    // Record intent before listener discovery so a later stop wins during startup.
    const control = ['start', 'pair', 'stop', 'exit'].includes(action);
    const sequence = control ? ++this.controlSequence : undefined;
    if (control) this.startRequested = ['start', 'pair'].includes(action);
    if (action === 'exit' && this.launching) await this.launching;
    if (!this.server && !this.starting) {
      const runtime = await this.runtime();
      if (control && sequence !== this.controlSequence) {
        if (action === 'pair') throw new Error('Invitation request was superseded by a later sharing control. Request a new invitation when ready.');
        return runtime ? lanRequest(runtime, '/local', { action: 'status' }, undefined, signal) : this.status();
      }
      if (runtime) {
        const result = await lanRequest(runtime, '/local', { action, ...input }, onProgress, signal);
        if (action === 'exit') {
          const until = performance.now() + 5000;
          while ((await this.runtime())?.pid === runtime.pid) {
            if (performance.now() >= until) throw new Error('The node has not finished exiting. Check sharing_status before restarting it.');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        return result;
      }
    }
    if (this.independent && ['start', 'pair', 'network', 'request'].includes(action)) {
      this.launching ||= this.launch(['network', 'request'].includes(action) ? { networkOnly: true, address: '127.0.0.1', port: 0 } : input).finally(() => { this.launching = null; });
      await this.launching;
      const runtime = await this.runtime();
      if (!runtime) throw new Error('The sharing node exited during startup. Check sharing/node.log.');
      if (control && sequence !== this.controlSequence) {
        if (!this.startRequested) await lanRequest(runtime, '/local', { action: 'stop' });
        if (action === 'pair') throw new Error('Invitation request was superseded by a later sharing control. Request a new invitation when ready.');
        return lanRequest(runtime, '/local', { action: 'status' });
      }
      return lanRequest(runtime, '/local', { action, ...input }, onProgress, signal);
    }
    if (action === 'start') return this.start(input);
    if (action === 'network') return this.configureNetwork(input);
    if (action === 'request') return this.requestNetwork(input, onProgress);
    if (action === 'resolveNetwork') return this.resolveNetwork(input);
    if (action === 'pair') return this.createPairing(input);
    if (action === 'stop') return this.stop();
    if (action === 'exit') {
      if (this.active.size || this.networkRequests || this.pendingNetwork.size || this.tailcatStarting || this.promoting) throw new Error('An active turn or cross-network transfer must finish or be explicitly cancelled before exiting the node.');
      await this.close();
      return this.status();
    }
    if (action === 'revoke') return this.revoke(input.pairId, input.cleanup, signal);
    if (action === 'configure') return this.configure(input, signal);
    if (action === 'configurePairing') return this.configurePairing(input);
    if (action === 'cleanupTask') return this.cleanupTask(input, signal);
    if (action === 'cleanupPair') return this.cleanup(input.pairId, input.cleanup, signal);
    if (['usage', 'models'].includes(action)) {
      const config = await this.store.read();
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const harness = this.harness || executionHarness(config.provider);
      if (action === 'usage' && harness !== 'codex') return queryUsage(undefined, this.root, signal, harness);
      const executable = this.executable || await executionExecutable(config, harness);
      return action === 'usage' ? queryUsage(executable, this.root, signal, harness) : modelCapabilities(await queryExecutionModels(harness, executable, this.root, signal), config.provider, harness);
    }
    throw new Error('Unknown local sharing action.');
  }
  async configureNetwork(input) {
    if (typeof input.enabled !== 'boolean') throw new Error('Cross-network enabled must be a boolean.');
    if (this.networkChanging) throw new Error('Cross-network settings are changing. Query the setting again.');
    this.networkChanging = true;
    try {
      if (!input.enabled) {
        await this.reconcileNetwork();
        if (this.networkRequests || this.tailcatStarting || [...this.active.values()].some(t => t.viaTailcat) || this.pendingNetwork.size) throw new Error('Finish the active cross-network task or transfer, or explicitly cancel it, before turning cross-network connections off. Query the original task if its last response was lost.');
        await this.closeTailcat();
      }
      await this.store.update(config => { config.crossNetwork = { enabled: input.enabled }; });
      if (input.enabled && this.server && !this.networkOnly) {
        try { await this.ensureTailcat(); } catch (error) { this.networkError = error.message; }
      }
      return { ...crossNetwork(await this.store.read()), ...this.status().crossNetwork };
    } finally { this.networkChanging = false; }
  }
  async ensureTailcat() {
    if (this.tailcat?.alive) return this.tailcat;
    if (this.tailcatStarting) return this.tailcatStarting;
    this.tailcatStarting = (async () => {
      if (!crossNetwork(await this.store.read()).enabled) throw new Error('Cross-network connection is off.');
      if (!this.crossServer) {
        this.crossServer = https.createServer(this.tlsOptions, (req, res) => { void this.handle(req, res, true); });
        await new Promise((resolve, reject) => { this.crossServer.once('error', reject); this.crossServer.listen(0, '127.0.0.1', resolve); });
      }
      this.tailcat = await startTailcat('serve', path.join(this.root, 'tailcat-identity.json'), this.crossServer.address().port);
      this.networkError = undefined;
      void this.tailcat.exited.then(() => { this.networkError = 'Cross-network helper stopped. Direct private-network connections remain available.'; });
      return this.tailcat;
    })();
    try { return await this.tailcatStarting; } finally { this.tailcatStarting = null; }
  }
  async closeTailcat() {
    if (this.tailcatStarting) await this.tailcatStarting.catch(() => {}); // Startup caller reports this failure.
    if (this.tailcat) { await this.tailcat.close(); this.tailcat = null; }
    if (this.crossServer) { this.crossServer.closeAllConnections(); await new Promise(resolve => this.crossServer.close(resolve)); this.crossServer = null; }
    this.networkError = undefined;
  }
  async requestNetwork({ peer, route, request }, onProgress) {
    if (!['/pair', '/rpc'].includes(route) || typeof peer?.tailcat !== 'string' || !peer.tailcat || peer.tailcat.length > 4096) throw new Error('Invalid cross-network request.');
    endpoint(peer);
    const config = await this.store.read();
    if (this.networkChanging || !crossNetwork(config).enabled) throw new Error('Cross-network connection is off or settings are changing.');
    const key = route === '/rpc' && request.taskId ? `${taskId(peer.pairId)}/${taskId(request.taskId)}` : undefined;
    this.networkRequests++;
    let tunnel;
    try {
      tunnel = await startTailcat('dial', peer.tailcat);
      // Setting changes cannot pass the occupied-request check during this await.
      if (key && ['run', 'restore'].includes(request.action)) { this.pendingNetwork.set(key, { pairId: peer.pairId, taskId: request.taskId }); await this.saveNetworkPending(); }
      const result = await lanRequest({ ...peer, host: '127.0.0.1', port: tunnel.port }, route, request, onProgress);
      if (key && (['run', 'restore'].includes(request.action) || request.action === 'status' && result.executionActive === false)) { this.pendingNetwork.delete(key); await this.saveNetworkPending(); }
      return retainReceived(result, { ...result, connectionRoute: 'tailcat' });
    } catch (error) {
      if (key && (error.notSubmitted || error.code === 'PAIRING_REVOKED')) { this.pendingNetwork.delete(key); await this.saveNetworkPending(); }
      throw error;
    } finally {
      if (tunnel) await tunnel.close();
      this.networkRequests--;
    }
  }
  saveNetworkPending() {
    const write = () => writeJson(path.join(this.root, 'network-pending.json'), [...this.pendingNetwork.values()]);
    const saving = this.savingNetwork ? this.savingNetwork.then(write, write) : write();
    this.savingNetwork = saving;
    return saving;
  }
  async resolveNetwork({ peer, request, result }) {
    if (!peer?.pairId || !request?.taskId) return { status: 'unchanged' };
    const key = `${peer.pairId}/${taskId(request.taskId)}`;
    if (this.pendingNetwork.has(key) && (['run', 'restore'].includes(request.action) || request.action === 'status' && result?.executionActive === false)) {
      this.pendingNetwork.delete(key); await this.saveNetworkPending();
    }
    return { status: 'checked' };
  }
  async reconcileNetwork() {
    if (!this.pendingNetwork.size || this.networkRequests) return;
    const config = await this.store.read();
    if (!crossNetwork(config).enabled) return;
    for (const [key, record] of this.pendingNetwork) {
      const peer = Object.values(config.peers || {}).find(p => p.pairId === record.pairId);
      if (!peer) continue;
      let tunnel;
      try {
        let result;
        try { result = await lanRequest(peer, '/rpc', { action: 'status', taskId: record.taskId }, undefined, undefined, { connectTimeout: 3000, requestTimeout: 15000 }); }
        catch (error) {
          if (!error.beforeSend || !peer.tailcat) throw error;
          tunnel = await startTailcat('dial', peer.tailcat);
          result = await lanRequest({ ...peer, host: '127.0.0.1', port: tunnel.port }, '/rpc', { action: 'status', taskId: record.taskId }, undefined, undefined, { requestTimeout: 15000 });
        }
        if (result.executionActive === false) this.pendingNetwork.delete(key);
      } catch (error) {
        if (error.code === 'PAIRING_REVOKED') this.pendingNetwork.delete(key);
        else this.networkError = `Cannot confirm task ${record.taskId}: ${error.message}`;
      }
      finally { if (tunnel) await tunnel.close(); }
    }
    await this.saveNetworkPending();
  }
  async launch(input) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const entry = fileURLToPath(new URL('../bin/share.mjs', import.meta.url));
    if (process.platform === 'win32') return launchWindowsNode(entry, this.root, { configFile: path.resolve(this.store.file), stateRoot: path.dirname(this.root), input });
    const log = await fs.open(path.join(this.root, 'node.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [...process.execArgv, entry, path.resolve(this.store.file), path.dirname(this.root), JSON.stringify(input)], {
        detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc']
      });
      await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        child.removeListener('error', fail);
        child.removeListener('exit', exited);
        child.removeListener('message', ready);
        child.unref();
        if (error) reject(error); else resolve();
      };
      const fail = error => finish(error);
      const exited = code => finish(new Error(`Sharing node exited during startup (${code}). Check ${path.join(this.root, 'node.log')}.`));
      const ready = message => finish(message.error ? new Error(message.error) : ['sharing', 'stopped'].includes(message.result?.status) ? undefined : new Error('Invalid sharing startup response.'));
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error(`Sharing startup timed out. Check ${path.join(this.root, 'node.log')}.`)); }, 30000);
      child.once('error', fail); child.once('exit', exited); child.once('message', ready);
      });
    } finally { await log.close(); }
  }
  async configure(input, signal) {
    if (input.allModels !== undefined && input.allowedModels !== undefined) throw new Error('Choose allModels or allowedModels, not both.');
    if (input.allModels === false) throw new Error('To restrict sharing, supply an explicit allowedModels list.');
    const config = await this.store.read();
    const previous = this.harness || executionHarness(config.provider);
    const harness = input.harness === undefined ? previous : executionHarness(input);
    const switching = harness !== previous;
    if (this.switching || switching && this.active.size) throw new Error('Finish or cancel the active task before switching execution tools.');
    const settingsFor = provider => ({
      allowedModels: allowedModels({ ...harnessSettings(provider, harness), ...(input.allModels || input.allowedModels ? { allowedModels: input.allModels ? 'all' : input.allowedModels } : {}) }),
      keepSessionVisible: keepSessionVisible({ ...provider, ...input }), maxConcurrent: maxConcurrent({ ...provider, ...input }), ...transferLimits({ ...provider, ...input }), retentionDays: retentionDays({ ...provider, ...input })
    });
    let settings = settingsFor(config.provider);
    let executable;
    this.switching = switching;
    try {
      if (switching) {
        executable = await executionExecutable(config, harness);
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        await queryExecutionModels(harness, executable, this.root, signal);
      }
      if (Object.keys(input).length) await this.store.update(current => {
        settings = settingsFor(current.provider);
        current.provider ||= {}; current.provider.harnesses ||= {};
        current.provider.harnesses[harness] = { ...current.provider.harnesses[harness], allowedModels: settings.allowedModels };
        current.provider.harness = harness;
        Object.assign(current.provider, transferLimits(settings), { retentionDays: settings.retentionDays, maxConcurrent: settings.maxConcurrent, keepSessionVisible: settings.keepSessionVisible });
      });
      if (switching && this.server) { this.harness = harness; this.executable = executable; }
      this.limit = settings.maxConcurrent;
      return { role: 'provider', keepSessionVisible: settings.keepSessionVisible, sessionVisibilitySupported: harness === 'codex', maxConcurrent: settings.maxConcurrent, harness, allowedModels: settings.allowedModels, advanced: { ...transferLimits(settings), retentionDays: settings.retentionDays }, note: 'One execution tool is offered at a time. All models includes future available models. Existing tasks retain their original tool and settings. Session visibility applies only to new Codex tasks; Claude display/archiving is unsupported and unchanged. Viewing does not extend work-copy retention.' };
    } finally { this.switching = false; }
  }
  async configurePairing(input) {
    taskId(input.pairId);
    if (Object.keys(input).some(key => !['pairId', 'maxConcurrent', 'expiresAt', 'tokenLimit', 'acceptUsageGap'].includes(key))) throw new Error('Unknown connection setting.');
    if (input.acceptUsageGap !== undefined && typeof input.acceptUsageGap !== 'boolean') throw new Error('acceptUsageGap must be a boolean.');
    let result;
    const read = config => {
      const peer = config.provider?.pairings?.[input.pairId];
      if (!peer) throw new Error('Unknown or revoked pairing. Pair again before configuring it.');
      return peer;
    };
    if (Object.keys(input).some(key => key !== 'pairId')) {
      await this.store.update(config => {
        const peer = read(config);
        const rules = pairingRules({ ...peer, ...input });
        for (const key of ['maxConcurrent', 'expiresAt']) if (Object.hasOwn(input, key)) peer[key] = rules[key];
        if (Object.hasOwn(input, 'tokenLimit')) peer.tokenLimit = rules.budget.limit;
        if (input.acceptUsageGap === true && peer.tokenBudget) peer.tokenBudget.paused = false;
        result = { pairId: input.pairId, name: peer.name, ...pairingRules(peer) };
      });
    } else {
      const peer = read(await this.store.read());
      result = { pairId: input.pairId, name: peer.name, ...pairingRules(peer) };
    }
    return result;
  }
  requirePairingCapacity(config, pairId) {
    const rules = pairingRules(config.provider.pairings[pairId]);
    if (rules.authorizationStatus === 'expired') throw new Error('Connection authorization has expired. Ask the host to extend this connection; existing tasks can still be queried, cancelled and collected.');
    requireBudget(config.provider.pairings[pairId]);
    if (rules.maxConcurrent !== null && [...this.active.values()].filter(active => active.pairId === pairId).length >= rules.maxConcurrent) throw new Error('Connection capacity is full. Wait for one of this connection’s active turns to finish before retrying.');
  }
  async recoverBudgets() {
    const config = await this.store.read();
    for (const [pairId, peer] of Object.entries(config.provider?.pairings || {})) {
      pairingRules(peer);
      for (const [id, receipt] of Object.entries(peer.tokenBudget?.pending || {})) {
        if ([...this.active.values()].some(active => active.budgetId === id)) continue;
        let state;
        try { state = await readJson(path.join(this.root, 'tasks', taskId(pairId), taskId(receipt.taskId), 'state.json')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const round = state?.rounds?.find(round => round.revision === receipt.revision);
        await this.store.update(current => settleBudget(current.provider?.pairings?.[pairId], id, round));
      }
    }
  }
  async start(input) {
    if (this.closing) throw new Error('The plugin is shutting down.');
    if (this.server) {
      await this.recoverBudgets();
      if (this.networkOnly && !input.networkOnly) {
        this.promoting ||= this.promote(input).finally(() => { this.promoting = null; });
        await this.promoting;
      }
      this.accepting = this.startRequested && !input.networkOnly;
      if (this.accepting && crossNetwork(await this.store.read()).enabled) void this.ensureTailcat().catch(error => { this.networkError = error.message; });
      return this.status();
    }
    if (this.starting) throw new Error('Sharing is starting. Check sharing_status before retrying.');
    this.starting = this.open(input);
    return this.starting;
  }
  async promote(input) {
    const config = await this.store.read();
    const executable = await executionExecutable(config, this.harness);
    const host = sharingAddress(input, config), port = input.port ?? config.provider?.port ?? 47631;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Sharing port must be an integer between 0 and 65535.');
    const server = https.createServer(this.tlsOptions, (req, res) => { void this.handle(req, res); });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      if (this.closing) throw new Error('The node is shutting down.');
      const endpoint = { ...this.endpoint, host, port: server.address().port };
      await this.store.update(current => { current.provider ||= {}; Object.assign(current.provider, { address: host, port: endpoint.port }); });
      this.lanServer = server; this.endpoint = endpoint; this.executable = executable; this.networkOnly = false;
    } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  }
  async open(input) {
    try {
      const config = await this.store.read();
      const host = sharingAddress(input, config);
      const port = input.port ?? config.provider?.port ?? 47631;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Sharing port must be an integer between 0 and 65535.');
      this.limit = maxConcurrent(config.provider);
      this.harness = executionHarness(config.provider);
      this.networkOnly = input.networkOnly === true;
      if (!this.networkOnly) this.executable = await executionExecutable(config, this.harness);
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      this.release = await processLock(path.join(this.root, 'listener'));
      await this.recoverBudgets();
      const identityPath = path.join(this.root, 'identity.json');
      let identity;
      try { identity = await readJson(identityPath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        let generated;
        try {
          generated = await selfsigned.generate([{ name: 'commonName', value: 'sub2sub' }], {
            keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 3650 * 86400000)
          });
        } catch (error) { throw new Error(`Could not create the sharing certificate with the bundled generator: ${error.message}`, { cause: error }); }
        identity = { key: generated.private, cert: generated.cert };
        await writeJson(identityPath, identity);
      }
      this.tlsOptions = { ...identity, minVersion: 'TLSv1.2', requestTimeout: 0, headersTimeout: 15000, maxHeaderSize: 8192 };
      const server = https.createServer(this.tlsOptions, (req, res) => { void this.handle(req, res); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      this.server = server;
      this.endpoint = { host, port: server.address().port, fingerprint: new X509Certificate(identity.cert).fingerprint256.replaceAll(':', '') };
      let pending;
      try { pending = await readJson(path.join(this.root, 'network-pending.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; pending = []; }
      if (!Array.isArray(pending)) throw new Error('Invalid cross-network task record.');
      this.pendingNetwork = new Map(pending.map(record => [`${taskId(record.pairId)}/${taskId(record.taskId)}`, record]));
      this.localToken = secret();
      // Node management must survive removal of the network interface used for sharing.
      this.managementServer = https.createServer(this.tlsOptions, (req, res) => {
        if (req.url !== '/local') { res.writeHead(404); res.end(); return; }
        void this.handle(req, res);
      });
      await new Promise((resolve, reject) => { this.managementServer.once('error', reject); this.managementServer.listen(0, '127.0.0.1', resolve); });
      await writeJson(path.join(this.root, 'runtime.json'), { pid: process.pid, transferProtocol: 3, ...this.endpoint, host: '127.0.0.1', port: this.managementServer.address().port, token: this.localToken });
      if (!this.networkOnly) await this.store.update(current => { current.provider ||= {}; Object.assign(current.provider, { address: host, port: this.endpoint.port }); });
      this.accepting = this.startRequested && !this.networkOnly;
      if (!this.networkOnly && crossNetwork(config).enabled) void this.ensureTailcat().catch(error => { this.networkError = error.message; });
      this.sweepTimer = setInterval(() => { void this.sweep().catch(error => { this.maintenanceError = error.message; process.stderr.write(`sub2sub expiry check failed: ${error.message}\n`); }); }, 60000);
      this.sweepTimer.unref();
      return this.status();
    } catch (error) {
      if (this.managementServer) { this.managementServer.closeAllConnections(); await new Promise(resolve => this.managementServer.close(resolve)); this.managementServer = null; }
      if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); this.server = null; }
      if (this.localToken) { await fs.rm(path.join(this.root, 'runtime.json'), { force: true }); this.localToken = null; }
      if (this.release) { await this.release(); this.release = null; }
      throw error;
    } finally { this.starting = false; }
  }
  async createPairing(input = {}) {
    if (!this.accepting) await this.start(input);
    if (!this.accepting) throw new Error('Sharing was stopped while creating the invitation.');
    let tailcat;
    if (crossNetwork(await this.store.read()).enabled) {
      try { tailcat = (await this.ensureTailcat()).address; }
      catch (error) { this.networkError = error.message; }
    }
    if (!this.accepting) throw new Error('Sharing was stopped while preparing the invitation.');
    this.invite = { secret: secret(), expiresAt: Date.now() + 10 * 60 * 1000 };
    return { invitation: 'sub2sub:' + Buffer.from(JSON.stringify({ version: tailcat ? 2 : 1, ...this.endpoint, ...(tailcat ? { tailcat } : {}), secret: this.invite.secret })).toString('base64url'), expiresAt: new Date(this.invite.expiresAt).toISOString(), crossNetwork: { available: Boolean(tailcat), reason: this.networkError }, note: 'One use, valid for 10 minutes. Share privately with the intended client.' };
  }
  async handle(req, res, viaTailcat = false) {
    let networkProtected = false;
    res.on('error', () => res.destroy()); // A caller disconnect does not cancel provider-owned execution.
    const streaming = req.headers['content-type'] === STREAM_TYPE;
    if (streaming) res.setHeader('content-type', STREAM_TYPE);
    let sending = Promise.resolve(), sendError, received;
    const send = message => {
      sending = sending.then(async () => {
        if (res.destroyed) return;
        try {
          if (streaming) await writeMessage(res, message);
          else res.write(JSON.stringify(await legacyMessage(message)) + '\n');
        } finally { await releaseReceived(message.result); }
      }).catch(error => { sendError = error; res.destroy(); });
    };
    req.setTimeout(60000, () => req.destroy(new Error('Upload stalled for 60 seconds.')));
    try {
      if (viaTailcat && (this.networkChanging || !crossNetwork(await this.store.read()).enabled || req.url === '/local')) throw new Error('Cross-network service is off or route is not authorized.');
      await this.sweep();
      if (req.method !== 'POST' || !['/pair', '/rpc', '/local'].includes(req.url)) throw new Error('Unknown request.');
      let config = await this.store.read();
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (req.url === '/local' && (!this.localToken || !matches(token, digest(this.localToken)))) throw new Error('Local sharing management is not authorized.');
      let pairId;
      if (req.url === '/rpc') {
        pairId = Object.entries(config.provider?.pairings || {}).find(([, peer]) => matches(token, peer.tokenHash))?.[0];
        if (!pairId) throw Object.assign(new Error('Client is not paired or its authorization was revoked.'), { code: 'PAIRING_REVOKED' });
      }
      if (viaTailcat && pairId) { this.networkRequests++; networkProtected = true; this.networkFlows.set(res, pairId); }
      if (req.url === '/pair' && streaming) throw new Error('Pairing requires the JSON protocol.');
      received = await readRequest(req, { streaming, ...(req.url === '/rpc' ? fileLimits(config.provider, 'input') : {}), legacyBytes: req.url === '/pair' ? 2048 : WIRE_BYTES + 8192 });
      const input = received.value;
      req.setTimeout(0);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request must be an object.');
      if (req.url === '/local') {
        if (Object.keys(input).some(key => !['action', 'enabled', 'peer', 'route', 'request', 'result', 'address', 'port', 'pairId', 'taskId', 'cleanup', 'discardUncollected', 'harness', 'allModels', 'allowedModels', 'inputBytes', 'inputFiles', 'resultBytes', 'resultFiles', 'retentionDays', 'maxConcurrent', 'keepSessionVisible', 'expiresAt', 'tokenLimit', 'acceptUsageGap'].includes(key))) throw new Error('Unknown local management field.');
        if (input.action === 'exit') {
          if (this.active.size || this.networkRequests || this.pendingNetwork.size || this.tailcatStarting || this.promoting) throw new Error('An active turn or cross-network transfer must finish or be explicitly cancelled before exiting the node.');
          this.closing = true;
          this.stop();
          // Let this response reach its caller before closing the listener.
          res.once('close', () => { void this.close().catch(error => { process.stderr.write(`sub2sub node exit failed: ${error.message}\n`); process.exitCode = 1; }); });
          send({ result: this.status() });
        } else send({ result: input.action === 'status' ? this.status() : await this.manage(input.action, Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'action')), undefined, progress => send({ progress })) });
      } else if (req.url === '/pair') {
        const verifiedInvite = this.invite;
        if (!this.accepting || !this.invite || Date.now() >= this.invite.expiresAt || !matches(input.secret, digest(this.invite.secret))) throw new Error('Pairing invitation expired or already used. Ask the host for a new one.');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Invalid client name.');
        if (viaTailcat) {
          const current = await this.store.read();
          if (this.networkChanging || !crossNetwork(current).enabled || !this.accepting || this.invite !== verifiedInvite || Date.now() >= verifiedInvite.expiresAt) throw new Error('Cross-network pairing is no longer available.');
          this.networkRequests++; networkProtected = true;
        }
        this.invite = null;
        const id = randomUUID(), newToken = secret();
        await this.store.update(current => {
          current.provider ||= {}; current.provider.pairings ||= {};
          current.provider.pairings[id] = { name: input.name, tokenHash: digest(newToken), pairedAt: new Date().toISOString() };
          connectionNames(Object.values(current.provider.pairings), peer => peer.name);
        });
        send({ result: { pairId: id, token: newToken, name: deviceName(config), harness: this.harness, ...executionSettings(harnessSettings(config.provider, this.harness), this.harness) } });
      } else {
        // Recheck after upload so revocation during a large transfer takes effect.
        config = await this.store.read();
        if (!matches(token, config.provider?.pairings?.[pairId]?.tokenHash)) throw Object.assign(new Error('Client authorization was revoked.'), { code: 'PAIRING_REVOKED' });
        const nameHeader = req.headers['x-sub2sub-device-name'];
        if (nameHeader !== undefined) {
          const callerName = deviceName({ deviceName: decodeURIComponent(nameHeader) });
          if (config.provider.pairings[pairId].name !== callerName) await this.store.update(current => {
            if (!matches(token, current.provider?.pairings?.[pairId]?.tokenHash)) throw Object.assign(new Error('Client authorization was revoked.'), { code: 'PAIRING_REVOKED' });
            current.provider.pairings[pairId].name = callerName;
            connectionNames(Object.values(current.provider.pairings), peer => peer.name);
          });
        }
        res.setHeader('x-sub2sub-device-name', encodeURIComponent(deviceName(config)));

        if (input.action === 'network') {
          if (!crossNetwork(config).enabled) throw new Error('Cross-network connection is off on the host. Ask its owner to enable it explicitly.');
          const helper = await this.ensureTailcat();
          const current = await this.store.read();
          if (this.networkChanging || !crossNetwork(current).enabled || !matches(token, current.provider?.pairings?.[pairId]?.tokenHash)) throw new Error('Cross-network settings or authorization changed. Query the original connection again.');
          send({ result: { endpoint: { ...this.endpoint, tailcat: helper.address } } });
        } else if (input.action === 'usage') {
          send({ result: await queryUsage(this.executable, this.root, undefined, this.harness) });
        } else if (input.action === 'models') {
          const harness = this.harness, executable = this.executable;
          const models = await queryExecutionModels(harness, executable, this.root);
          config = await this.store.read();
          if (this.harness !== harness) throw new Error('Execution tool changed during model discovery. Query the current models again.');
          if (!matches(token, config.provider?.pairings?.[pairId]?.tokenHash)) throw Object.assign(new Error('Client authorization was revoked.'), { code: 'PAIRING_REVOKED' });
          send({ result: { ...modelCapabilities(models, config.provider, harness), connection: pairingRules(config.provider.pairings[pairId]) } });
        } else if (input.action === 'check') {
          const connection = { ...pairingRules(config.provider.pairings[pairId]), occupiedSlots: [...this.active.values()].filter(active => active.pairId === pairId).length };
          send({ result: { protocol: 2, usage: true, limits: transferLimits(config.provider), transport: 'lan', connection, occupiedSlots: this.active.size, maxConcurrent: maxConcurrent(config.provider), status: connection.authorizationStatus === 'expired' ? 'expired' : connection.budget.status === 'paused' ? 'budget_paused' : connection.budget.status === 'exhausted' ? 'budget_exhausted' : !this.accepting ? 'stopped' : this.active.size >= maxConcurrent(config.provider) || connection.maxConcurrent !== null && connection.occupiedSlots >= connection.maxConcurrent ? 'busy' : 'available', name: deviceName(config), harness: this.harness, ...executionSettings(harnessSettings(config.provider, this.harness), this.harness) } });
        } else {
          if (Object.keys(input).some(key => !['action', 'protocol', 'harness', 'taskId', 'snapshot', 'prompt', 'revision', 'discardPaths', 'model', 'reasoningEffort', 'cleanup', 'limits', 'syncId', 'details'].includes(key))) throw new Error('Unknown host request field.');
          const root = path.join(this.root, 'tasks', taskId(pairId));
          taskId(input.taskId);
          if (['run', 'restore'].includes(input.action)) {
            if (![2, 3].includes(input.protocol)) throw new Error('This client uses an incompatible execution protocol. Update both endpoints to sub2sub 0.4.');
            if (!this.accepting) throw new Error('Sharing is stopped. Existing results remain available.');
            this.requirePairingCapacity(config, pairId);
            const key = `${pairId}/${input.taskId}`;
            if (this.active.has(key)) throw new Error('This task already has an active turn. Query its status before continuing.');
            if (this.active.size >= maxConcurrent(config.provider) || this.switching) throw new Error('Host is busy: node capacity is full. Wait for a task to finish before retrying.');
            const harness = this.harness;
            if (executionHarness(input) !== harness) throw new Error(`This node offers ${harness}. Select matching capabilities with an updated client before sending task files.`);
            const settings = executionSettings(input, harness);
            const catalog = await queryExecutionModels(harness, this.executable, this.root);
            const current = await this.store.read();
            requireModel(settings, modelCapabilities(catalog, current.provider, harness));
            if (this.active.has(key)) throw new Error('This task already has an active turn. Query its status before continuing.');
            if (!this.accepting || this.active.size >= maxConcurrent(current.provider) || this.switching || this.harness !== harness) throw new Error('Host stopped, became busy or changed execution tools during model discovery. Query its current capabilities before retrying.');
            if (!matches(token, current.provider?.pairings?.[pairId]?.tokenHash)) throw Object.assign(new Error('Client authorization was revoked.'), { code: 'PAIRING_REVOKED' });
            this.requirePairingCapacity(current, pairId);
            const controller = new AbortController();
            const budgetId = randomUUID();
            const active = { taskId: input.taskId, pairId, controller, response: res, viaTailcat, budgetId };
            this.active.set(key, active);
            const running = providerRequest({ ...input, harness, ...settings }, {
              onRoundStart: current.provider.pairings[pairId].tokenLimit == null ? undefined : async round => this.store.update(config => {
                const peer = config.provider?.pairings?.[pairId];
                if (!peer || !matches(token, peer.tokenHash)) throw new Error('Client authorization was revoked.');
                requireBudget(peer);
                if (peer.tokenLimit == null) return false;
                peer.tokenBudget ||= { usedTokens: 0, incomplete: false, paused: false, pending: {} };
                peer.tokenBudget.pending[budgetId] = { taskId: input.taskId, revision: round.revision };
                return true;
              }),
              onRoundEnd: current.provider.pairings[pairId].tokenLimit == null ? undefined : async round => {
                try { await this.store.update(config => settleBudget(config.provider?.pairings?.[pairId], budgetId, round)); }
                catch (error) { this.accepting = false; throw error; }
              },
              root, executable: this.executable, modelInfo: catalog.find(model => model.model === settings.model), limits: transferLimits(current.provider), retention: retentionDays(current.provider), keepSessionVisible: keepSessionVisible(current.provider), signal: controller.signal, onProgress: progress => send({ progress }) });
            active.done = running;
            try { send({ result: await running }); } finally { this.active.delete(key); }
          } else {
            let executable = this.executable;
            if (input.action === 'finish') {
              if (['records', 'all'].includes(input.cleanup)) await this.recoverBudgets();
              let state;
              try { state = await readJson(path.join(root, input.taskId, 'state.json')); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
              executable = executionHarness(state || input) === 'codex' ? await codexExecutable(config) : undefined;
            }
            const activeAtRead = input.action === 'status' && this.active.has(`${pairId}/${input.taskId}`);
            const result = await providerRequest(input, { root, executable, limits: transferLimits(config.provider), onProgress: progress => send({ progress }) });
            if (input.action === 'status') {
              // A turn can finish during file inspection after its running snapshot was read.
              result.executionActive = this.active.has(`${pairId}/${input.taskId}`) || result.status === 'running' && activeAtRead;
              if (result.status === 'running' && !result.executionActive) Object.assign(result, { recordedStatus: 'running', status: 'unknown', reason: 'The recorded execution is not owned by the current sharing process.' });
            }
            send({ result });
          }
        }
      }
    } catch (error) { send({ error: error.message, ...(error.code === 'PAIRING_REVOKED' ? { code: error.code } : {}) }); }
    finally { await sending; await releaseReceived(received?.value); if (!sendError) res.end(); this.networkFlows.delete(res); if (networkProtected) { if (res.writableFinished || res.destroyed) this.networkRequests--; else res.once('close', () => { this.networkRequests--; }); } }
  }
  async pairings() {
    const config = await this.store.read();
    connectionNames(Object.values(config.provider?.pairings || {}), peer => peer.name);
    return { pairings: Object.entries(config.provider?.pairings || {}).map(([pairId, peer]) => ({ pairId, name: peer.displayName, deviceName: peer.name, pairedAt: peer.pairedAt, ...pairingRules(peer) })) };
  }
  async revoke(pairId, cleanup = 'keep', signal) {
    taskId(pairId);
    if (!['keep', 'records', 'all'].includes(cleanup)) throw new Error('Choose cleanup explicitly: keep, records or all.');
    await this.store.update(config => {
      if (!Object.hasOwn(config.provider?.pairings || {}, pairId)) throw new Error('Unknown pairing.');
      delete config.provider.pairings[pairId];
    });
    for (const [response, owner] of this.networkFlows) if (owner === pairId) response.destroy();
    const revoked = [...this.active.values()].filter(active => active.pairId === pairId);
    for (const active of revoked) { active.response.destroy(); active.controller.abort(); }
    // Original handlers report interruption and persist each task's state.
    await Promise.allSettled(revoked.map(active => active.done));
    return { pairId, status: 'revoked', cleanup: cleanup === 'keep' ? { status: 'retained' } : await this.cleanup(pairId, cleanup, signal) };
  }
  async cleanup(pairId, cleanup, signal) {
    taskId(pairId);
    if (!['keep', 'records', 'all'].includes(cleanup)) throw new Error('Choose cleanup explicitly: keep, records or all.');
    if (cleanup === 'keep') return { pairId, status: 'retained' };
    const config = await this.store.read();
    if (Object.hasOwn(config.provider?.pairings || {}, pairId)) throw new Error('Disconnect this client with revoke_pairing before deleting its data.');
    const root = path.join(this.root, 'tasks', pairId);
    let files;
    try { files = await fs.readdir(root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    for (const id of files.filter(name => !name.startsWith('.'))) {
      const state = await readJson(path.join(root, taskId(id), 'state.json'));
      const executable = executionHarness(state) === 'codex' ? await codexExecutable(config) : undefined;
      await providerRequest({ action: 'finish', taskId: id, cleanup: 'records' }, { root, executable, signal, ownerCleanup: true });
    }
    // Native cwd metadata keeps the association after task records are gone.
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    let deletedThreads = 0;
    if (cleanup === 'all') {
      let harnesses;
      try { harnesses = await readJson(path.join(root, '.harnesses.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; harnesses = ['codex']; }
      for (const harness of harnesses) {
        executionHarness({ harness });
        const history = harness === 'claude' ? await manageClaudeHistory({ root: await fs.realpath(root) })
          : await manageTaskHistory({ executable: await codexExecutable(config), root: await fs.realpath(root), signal });
        deletedThreads += history.deletedThreads;
      }
    }
    return { pairId, status: cleanup === 'all' ? 'all_deleted' : 'records_deleted', ...(cleanup === 'all' ? { deletedThreads } : {}) };
  }
  async tasks(details = false) {
    const directory = path.join(this.root, 'tasks');
    let pairs;
    try { pairs = await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return { tasks: [] }; throw error; }
    const tasks = [];
    let reports = [];
    try { reports = await readJson(path.join(this.root, 'cleanup-report.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const pair of pairs) for (const id of (await fs.readdir(path.join(directory, taskId(pair)))).filter(name => !name.startsWith('.'))) {
      let state;
      try { state = await readJson(path.join(directory, pair, taskId(id), 'state.json')); state.harness ||= 'codex'; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { status: 'unknown', error: `Task record is not available; it may still be initializing or have been removed. Retry status after the current operation. ${error.message}` };
      }
      const report = reports.find(r => r.pairId === pair && r.taskId === id && r.revision === state.revision);
      tasks.push({ pairId: pair, taskId: id, harness: state.harness, threadId: state.threadId, keepSessionVisible: state.keepSessionVisible, sessionVisibility: state.sessionVisibility, createdAt: state.createdAt, endedAt: state.endedAt, status: state.status, revision: state.revision, rounds: state.rounds, savedRevision: state.savedRevision, saveConfirmed: Boolean(state.lastSync), unresolvedSkipped: state.unresolvedSkipped, expiresAt: state.expiresAt, retentionDays: state.retentionDays, expired: Boolean(state.expiresAt && Date.now() >= Date.parse(state.expiresAt)), cleanup: state.cleanup || report, error: state.error, inspection: await inspectTask(path.join(directory, pair, id), details) });
    }
    tasks.sort((a, b) => (b.endedAt || b.createdAt || '').localeCompare(a.endedAt || a.createdAt || ''));
    return { tasks };
  }
  async sweep() {
    if (this.sweeping) return this.sweeping;
    if (this.lastSweep !== undefined && Date.now() - this.lastSweep < 60000) return;
    this.sweeping = this.cleanupExpired();
    try { await this.sweeping; this.lastSweep = Date.now(); this.maintenanceError = undefined; }
    finally { this.sweeping = null; }
  }
  async cleanupExpired() {
    await this.recoverBudgets();
    const { tasks } = await this.tasks();
    const expired = tasks.filter(t => t.expired && t.status !== 'released');
    if (!expired.length) return;
    const reports = [];
    for (const task of expired) {
      const report = { taskId: task.taskId, pairId: task.pairId, revision: task.revision, checkedAt: new Date().toISOString(), status: 'waiting' };
      if (['running', 'unknown', 'finishing', 'restoring'].includes(task.status)) report.reason = `Task state ${task.status} does not permit automatic cleanup.`;
      else if (!task.saveConfirmed || task.savedRevision !== task.revision || task.unresolvedSkipped?.length) report.reason = 'Waiting for confirmation that all necessary results are saved locally.';
      else {
        try {
          await providerRequest({ action: 'finish', taskId: task.taskId, cleanup: 'workcopy', revision: task.savedRevision }, { root: path.join(this.root, 'tasks', task.pairId) });
          report.status = 'cleaned';
        } catch (error) { report.status = 'failed'; report.reason = error.message; }
      }
      reports.push(report);
    }
    await writeJson(path.join(this.root, 'cleanup-report.json'), reports);
  }
  async cancel(input) {
    return providerRequest({ action: 'cancel', taskId: taskId(input.taskId) }, { root: path.join(this.root, 'tasks', taskId(input.pairId)) });
  }
  async cleanupTask(input, signal) {
    if (['records', 'all'].includes(input.cleanup)) await this.recoverBudgets();
    const root = path.join(this.root, 'tasks', taskId(input.pairId));
    const state = await providerRequest({ action: 'status', taskId: taskId(input.taskId) }, { root });
    if (state.status === 'unknown' && !state.inspection.workCopyExists && input.cleanup === 'all') {
      let harnesses;
      try { harnesses = await readJson(path.join(root, '.harnesses.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; harnesses = ['codex']; }
      let deletedThreads = 0;
      for (const harness of harnesses) {
        executionHarness({ harness });
        const executable = harness === 'codex' ? await codexExecutable(await this.store.read()) : undefined;
        const result = await providerRequest({ action: 'finish', taskId: input.taskId, cleanup: 'all', harness }, { root, executable, signal });
        deletedThreads += result.deletedThreads;
      }
      return { taskId: input.taskId, status: 'all_deleted', deletedThreads };
    }
    if (!input.discardUncollected && (!state.syncVersion || state.savedRevision !== state.revision)) throw new Error('Results have not been confirmed saved by the client. Inspect this task and explicitly choose discardUncollected to abandon them.');
    const executable = executionHarness(state) === 'codex' ? await codexExecutable(await this.store.read()) : undefined;
    return providerRequest({ action: 'finish', taskId: input.taskId, revision: state.savedRevision, cleanup: input.cleanup }, { root, executable, signal, ownerCleanup: input.discardUncollected === true });
  }
  stop() { this.startRequested = false; this.accepting = false; this.invite = null; return { ...this.status(), note: 'New turns and pairing are stopped. Existing tasks may finish; paired clients can still query, cancel and collect. Use cancel_shared_task to interrupt a task.' }; }
  async close() {
    this.closing = true;
    clearInterval(this.sweepTimer);
    this.stop();
    if (this.starting) await this.starting.catch(() => {}); // The starting tool reports its own error.
    if (this.promoting) await this.promoting.catch(() => {}); // The start request reports its failure.
    await this.closeTailcat();
    if (this.managementServer) { this.managementServer.closeAllConnections(); await new Promise(resolve => this.managementServer.close(resolve)); this.managementServer = null; }
    if (this.lanServer) { this.lanServer.closeAllConnections(); await new Promise(resolve => this.lanServer.close(resolve)); this.lanServer = null; }
    if (!this.server) return;
    const closing = new Promise(resolve => this.server.close(resolve));
    const active = [...this.active.values()];
    for (const task of active) task.controller.abort();
    // Each request handler reports and persists its execution error.
    await Promise.allSettled(active.map(task => task.done));
    this.server.closeAllConnections();
    await closing; this.server = null;
    await fs.rm(path.join(this.root, 'runtime.json'), { force: true });
    await this.release(); this.release = null;
  }
}
