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
import { readJson, writeJson, MAX_BYTES } from './files.mjs';
import { deviceName, codexExecutable, executionExecutable, executionHarness, harnessSettings, allowedModels, executionSettings, retentionDays, TASK_FILE_SCOPE } from './config.mjs';
import { processLock } from './lock.mjs';
import { manageTaskHistory } from './codex-history.mjs';
import { queryModels, queryExecutionModels, modelCapabilities, requireModel } from './models.mjs';
import { transferLimits, WIRE_BYTES } from './limits.mjs';
import { queryUsage } from './usage.mjs';
import { manageClaudeHistory } from './claude.mjs';
import { launchWindowsNode } from './windows-node.mjs';

const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const matches = (value, hash) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));

function privateIPv4(value) {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
function address(value) {
  if (!privateIPv4(value)) throw new Error('Use a LAN or Tailscale IPv4 address. Public internet endpoints are not supported.');
  return value;
}
function endpoint(value) {
  address(value.host);
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.fingerprint !== 'string' || !/^[A-F0-9]{64}$/.test(value.fingerprint)) throw new Error('Invalid LAN endpoint or certificate identity.');
}
function invitation(text) {
  if (typeof text !== 'string' || !text.startsWith('sub2sub:') || text.length > 4096) throw new Error('Invalid pairing invitation. Ask the provider for a new invitation.');
  let value;
  try { value = JSON.parse(Buffer.from(text.slice(8), 'base64url').toString()); }
  catch (error) { throw new Error('Invalid pairing invitation.', { cause: error }); }
  if (!value || value.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) throw new Error('Unsupported or invalid pairing invitation.');
  endpoint(value);
  return value;
}

// Pin the provider certificate before sending HTTP headers, tokens, or a body.
export function lanRequest(peer, route, input, onProgress = () => {}, signal) {
  endpoint(peer);
  return new Promise((resolve, reject) => {
    let request, timer, connectTimer, finished = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(connectTimer);
      signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); reject(error); } else resolve(result);
    };
    const abort = () => done(new Error('Connection interrupted. Query the existing task status before resuming; it may still be running on the provider.'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > WIRE_BYTES) { done(new Error('LAN request exceeds supported transport size.')); return; }
    request = https.request({
      hostname: peer.host, port: peer.port, path: route, method: 'POST', agent: false,
      rejectUnauthorized: false, minVersion: 'TLSv1.2',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(peer.token ? { authorization: `Bearer ${peer.token}` } : {}) }
    }, response => {
      response.setEncoding('utf8');
      let bytes = 0, buffer = '', result, failure;
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > WIRE_BYTES) { done(new Error('LAN response exceeds supported transport size.')); return; }
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const message = JSON.parse(line);
            if (Object.hasOwn(message, 'error')) failure = new Error(`Peer: ${message.error}`);
            else if (Object.hasOwn(message, 'result')) result = message.result;
            else if (typeof message.progress === 'string') onProgress(message.progress);
            else throw new Error('Invalid LAN response.');
          } catch (error) { done(error); return; }
        }
      });
      response.on('error', error => done(error));
      response.on('end', () => done(failure || (response.statusCode !== 200 || buffer || result === undefined ? new Error(`Incomplete LAN response (${response.statusCode}). Check the task status before retrying.`) : undefined), result));
    });
    request.on('error', error => done(new Error(`LAN connection failed: ${error.message}. Check that the provider has sharing enabled.`, { cause: error })));
    request.on('socket', socket => socket.once('secureConnect', () => {
      try {
        const cert = new X509Certificate(socket.getPeerCertificate().raw);
        if (cert.fingerprint256.replaceAll(':', '') !== peer.fingerprint) throw new Error('Provider certificate does not match the paired identity. No task or credential was sent.');
        // A newly created certificate may be seconds ahead of the caller clock.
        // Identity is still pinned; expiry is never extended.
        if (Date.now() + 5 * 60 * 1000 < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) throw new Error('Provider certificate is not currently valid. Check both device clocks or renew an expired identity; no task or credential was sent.');
        clearTimeout(connectTimer);
        request.end(body);
      } catch (error) { done(error); }
    }));
    connectTimer = setTimeout(() => done(new Error('LAN connection timed out. Check the provider address and sharing status.')), 15000);
    timer = setTimeout(() => done(new Error('LAN request exceeded 31 minutes. Query the task status before resuming.')), 31 * 60 * 1000);
  });
}

export async function pairPeer(store, input, signal) {
  if (typeof input.peer !== 'string' || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(input.peer) || ['__proto__', 'constructor', 'prototype'].includes(input.peer)) throw new Error('Choose a peer name of 1–80 letters, numbers, dots, underscores or hyphens.');
  const config = await store.read();
  if (Object.hasOwn(config.peers || {}, input.peer)) throw new Error('That peer name is already configured. Choose another name.');
  const invite = invitation(input.invitation);
  const paired = await lanRequest(invite, '/pair', { secret: invite.secret, name: deviceName(config) }, undefined, signal);
  taskId(paired.pairId);
  if (!/^[A-Za-z0-9_-]{43}$/.test(paired.token) || typeof paired.name !== 'string' || paired.name.length > 100) throw new Error('Invalid pairing response from provider.');
  const harness = executionHarness(paired);
  const transferAuthorization = { scope: input.allowTaskFiles === true ? 'task-files' : 'none', updatedAt: new Date().toISOString() };
  await store.update(current => {
    current.peers ||= {};
    if (Object.hasOwn(current.peers, input.peer)) throw new Error('Peer name was configured by another operation. Pair again using a different name.');
    current.peers[input.peer] = { transport: 'lan', host: invite.host, port: invite.port, fingerprint: invite.fingerprint, pairId: paired.pairId, token: paired.token, transferAuthorization };
  });
  return { peer: input.peer, provider: paired.name, pairId: paired.pairId, transport: 'lan', status: 'paired', harness, model: paired.model, reasoningEffort: paired.reasoningEffort, transferAuthorization, transferScope: TASK_FILE_SCOPE };
}

export class Sharing {
  constructor(store, stateRoot, { independent = false } = {}) {
    this.store = store; this.root = path.join(stateRoot, 'sharing');
    this.independent = independent;
    this.accepting = false; this.active = null; this.invite = null;
    this.controlSequence = 0;
  }
  status() { return { status: this.accepting ? 'sharing' : 'stopped', ...(this.endpoint || {}), ownerPid: process.pid, harness: this.harness, version: packageInfo.version, runtimePath: process.execPath, nodeVersion: process.version, checkedAt: new Date().toISOString(), maintenanceError: this.maintenanceError, activeTask: this.active ? { taskId: this.active.taskId, pairId: this.active.pairId } : null }; }
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
      return { status: 'stopped', checkedAt: new Date().toISOString(), activeTask: null };
    }
    try { return { ...await lanRequest(runtime, '/local', { action: 'status' }), installedVersion: packageInfo.version }; }
    catch (error) { return { status: 'unreachable', ownerPid: runtime.pid, checkedAt: new Date().toISOString(), reason: error.message }; }
  }
  async manage(action, input = {}, signal) {
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
        const result = await lanRequest(runtime, '/local', { action, ...input }, undefined, signal);
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
    if (this.independent && ['start', 'pair'].includes(action)) {
      this.launching ||= this.launch(input).finally(() => { this.launching = null; });
      await this.launching;
      const runtime = await this.runtime();
      if (!runtime) throw new Error('The sharing node exited during startup. Check sharing/node.log.');
      if (sequence !== this.controlSequence) {
        if (!this.startRequested) await lanRequest(runtime, '/local', { action: 'stop' });
        if (action === 'pair') throw new Error('Invitation request was superseded by a later sharing control. Request a new invitation when ready.');
        return lanRequest(runtime, '/local', { action: 'status' });
      }
      return lanRequest(runtime, '/local', { action, ...input }, undefined, signal);
    }
    if (action === 'start') return this.start(input);
    if (action === 'pair') return this.createPairing(input);
    if (action === 'stop') return this.stop();
    if (action === 'exit') {
      if (this.active) throw new Error('An active turn must finish or be explicitly cancelled before exiting the node.');
      await this.close();
      return this.status();
    }
    if (action === 'revoke') return this.revoke(input.pairId, input.cleanup, signal);
    if (action === 'configure') return this.configure(input, signal);
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
      const ready = message => finish(message.error ? new Error(message.error) : message.result?.status === 'sharing' ? undefined : new Error('Invalid sharing startup response.'));
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
    if (this.switching || switching && this.active) throw new Error('Finish or cancel the active task before switching execution tools.');
    const settings = {
      allowedModels: allowedModels({ ...harnessSettings(config.provider, harness), ...(input.allModels || input.allowedModels ? { allowedModels: input.allModels ? 'all' : input.allowedModels } : {}) }),
      ...transferLimits({ ...config.provider, ...input }), retentionDays: retentionDays({ ...config.provider, ...input })
    };
    let executable;
    this.switching = switching;
    try {
      if (switching) {
        executable = await executionExecutable(config, harness);
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        await queryExecutionModels(harness, executable, this.root, signal);
      }
      if (Object.keys(input).length) await this.store.update(current => {
        current.provider ||= {}; current.provider.harnesses ||= {};
        current.provider.harnesses[harness] = { ...current.provider.harnesses[harness], allowedModels: settings.allowedModels };
        current.provider.harness = harness;
        Object.assign(current.provider, transferLimits(settings), { retentionDays: settings.retentionDays });
      });
      if (switching && this.server) { this.harness = harness; this.executable = executable; }
      return { role: 'provider', harness, allowedModels: settings.allowedModels, advanced: { ...transferLimits(settings), retentionDays: settings.retentionDays }, note: 'One execution tool is offered at a time. All models includes future available models. Existing tasks retain their original tool and settings.' };
    } finally { this.switching = false; }
  }
  start(input) {
    if (this.closing) throw new Error('The plugin is shutting down.');
    if (this.server) { this.accepting = this.startRequested; return this.status(); }
    if (this.starting) throw new Error('Sharing is starting. Check sharing_status before retrying.');
    this.starting = this.open(input);
    return this.starting;
  }
  async open(input) {
    try {
      const config = await this.store.read();
      const choices = [...new Set(Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address).filter(privateIPv4))];
      if (!input.address && !config.provider?.address && choices.length !== 1) throw new Error(`Select a LAN or Tailscale address with start_sharing.address. Available: ${choices.join(', ') || 'none; connect to your private network first'}.`);
      const host = address(input.address || config.provider?.address || choices[0]);
      const port = input.port ?? config.provider?.port ?? 47631;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Sharing port must be an integer between 0 and 65535.');
      this.harness = executionHarness(config.provider);
      this.executable = await executionExecutable(config, this.harness);
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      this.release = await processLock(path.join(this.root, 'listener'));
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
      const server = https.createServer({ ...identity, minVersion: 'TLSv1.2', requestTimeout: 60000, headersTimeout: 15000, maxHeaderSize: 8192 }, (req, res) => { void this.handle(req, res); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      this.server = server;
      this.endpoint = { host, port: server.address().port, fingerprint: new X509Certificate(identity.cert).fingerprint256.replaceAll(':', '') };
      this.localToken = secret();
      await writeJson(path.join(this.root, 'runtime.json'), { pid: process.pid, ...this.endpoint, token: this.localToken });
      await this.store.update(current => { current.provider ||= {}; Object.assign(current.provider, { address: host, port: this.endpoint.port }); });
      this.accepting = this.startRequested;
      this.sweepTimer = setInterval(() => { void this.sweep().catch(error => { this.maintenanceError = error.message; process.stderr.write(`sub2sub expiry check failed: ${error.message}\n`); }); }, 60000);
      this.sweepTimer.unref();
      return this.status();
    } catch (error) {
      if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); this.server = null; }
      if (this.localToken) { await fs.rm(path.join(this.root, 'runtime.json'), { force: true }); this.localToken = null; }
      if (this.release) { await this.release(); this.release = null; }
      throw error;
    } finally { this.starting = false; }
  }
  async createPairing(input = {}) {
    if (!this.accepting) await this.start(input);
    if (!this.accepting) throw new Error('Sharing was stopped while creating the invitation.');
    this.invite = { secret: secret(), expiresAt: Date.now() + 10 * 60 * 1000 };
    return { invitation: 'sub2sub:' + Buffer.from(JSON.stringify({ version: 1, ...this.endpoint, secret: this.invite.secret })).toString('base64url'), expiresAt: new Date(this.invite.expiresAt).toISOString(), note: 'One use, valid for 10 minutes. Share privately with the intended caller.' };
  }
  async handle(req, res) {
    res.on('error', () => res.destroy()); // A caller disconnect does not cancel provider-owned execution.
    const send = message => { if (!res.destroyed) res.write(JSON.stringify(message) + '\n'); };
    try {
      await this.sweep();
      if (req.method !== 'POST' || !['/pair', '/rpc', '/local'].includes(req.url)) throw new Error('Unknown request.');
      let config = await this.store.read();
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (req.url === '/local' && (!this.localToken || !matches(token, digest(this.localToken)))) throw new Error('Local sharing management is not authorized.');
      let pairId;
      if (req.url === '/rpc') {
        pairId = Object.entries(config.provider?.pairings || {}).find(([, peer]) => matches(token, peer.tokenHash))?.[0];
        if (!pairId) throw new Error('Caller is not paired or its authorization was revoked.');
      }
      let data = '', bytes = 0;
      req.setEncoding('utf8');
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > (req.url === '/rpc' ? WIRE_BYTES : 2048)) throw new Error('Request is too large.');
        data += chunk;
      }
      const input = JSON.parse(data);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request must be an object.');
      if (req.url === '/local') {
        if (Object.keys(input).some(key => !['action', 'address', 'port', 'pairId', 'taskId', 'cleanup', 'discardUncollected', 'harness', 'allModels', 'allowedModels', 'inputBytes', 'inputFiles', 'resultBytes', 'resultFiles', 'retentionDays'].includes(key))) throw new Error('Unknown local management field.');
        if (input.action === 'exit') {
          if (this.active) throw new Error('An active turn must finish or be explicitly cancelled before exiting the node.');
          this.closing = true;
          this.stop();
          // Let this response reach its caller before closing the listener.
          res.once('close', () => { void this.close().catch(error => { process.stderr.write(`sub2sub node exit failed: ${error.message}\n`); process.exitCode = 1; }); });
          send({ result: this.status() });
        } else send({ result: input.action === 'status' ? this.status() : await this.manage(input.action, Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'action'))) });
      } else if (req.url === '/pair') {
        if (!this.accepting || !this.invite || Date.now() >= this.invite.expiresAt || !matches(input.secret, digest(this.invite.secret))) throw new Error('Pairing invitation expired or already used. Ask the provider for a new one.');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Invalid caller name.');
        this.invite = null;
        const id = randomUUID(), newToken = secret();
        await this.store.update(current => {
          current.provider ||= {}; current.provider.pairings ||= {};
          current.provider.pairings[id] = { name: input.name, tokenHash: digest(newToken), pairedAt: new Date().toISOString() };
        });
        send({ result: { pairId: id, token: newToken, name: deviceName(config), harness: this.harness, ...executionSettings(harnessSettings(config.provider, this.harness), this.harness) } });
      } else {
        // Recheck after upload so revocation during a large transfer takes effect.
        config = await this.store.read();
        if (!matches(token, config.provider?.pairings?.[pairId]?.tokenHash)) throw new Error('Caller authorization was revoked.');
        if (input.action === 'usage') {
          send({ result: await queryUsage(this.executable, this.root, undefined, this.harness) });
        } else if (input.action === 'models') {
          const harness = this.harness, executable = this.executable;
          const models = await queryExecutionModels(harness, executable, this.root);
          if (this.harness !== harness) throw new Error('Execution tool changed during model discovery. Query the current models again.');
          send({ result: modelCapabilities(models, config.provider, harness) });
        } else if (input.action === 'check') {
          send({ result: { protocol: 2, usage: true, limits: transferLimits(config.provider), transport: 'lan', status: !this.accepting ? 'stopped' : this.active ? 'busy' : 'available', name: deviceName(config), harness: this.harness, ...executionSettings(harnessSettings(config.provider, this.harness), this.harness) } });
        } else {
          if (Object.keys(input).some(key => !['action', 'protocol', 'harness', 'taskId', 'snapshot', 'prompt', 'revision', 'discardPaths', 'model', 'reasoningEffort', 'cleanup', 'limits', 'syncId', 'details'].includes(key))) throw new Error('Unknown provider request field.');
          const root = path.join(this.root, 'tasks', taskId(pairId));
          taskId(input.taskId);
          if (['run', 'restore'].includes(input.action)) {
            if (input.protocol !== 2) throw new Error('This caller uses an incompatible execution protocol. Update both endpoints to sub2sub 0.4.');
            if (!this.accepting) throw new Error('Sharing is stopped. Existing results remain available.');
            if (this.active || this.switching) throw new Error('Provider is busy. Check task status before sending another task.');
            const harness = this.harness;
            if (executionHarness(input) !== harness) throw new Error(`This node offers ${harness}. Select matching capabilities with an updated caller before sending task files.`);
            const settings = executionSettings(input, harness);
            const catalog = await queryExecutionModels(harness, this.executable, this.root);
            const current = await this.store.read();
            requireModel(settings, modelCapabilities(catalog, current.provider, harness));
            if (!this.accepting || this.active || this.switching || this.harness !== harness) throw new Error('Provider stopped, became busy or changed execution tools during model discovery. Query its current capabilities before retrying.');
            if (!matches(token, current.provider?.pairings?.[pairId]?.tokenHash)) throw new Error('Caller authorization was revoked.');
            const controller = new AbortController();
            this.active = { taskId: input.taskId, pairId, controller, response: res };
            const running = providerRequest({ ...input, harness, ...settings }, { root, executable: this.executable, modelInfo: catalog.find(model => model.model === settings.model), limits: transferLimits(current.provider), retention: retentionDays(current.provider), signal: controller.signal, onProgress: progress => send({ progress }) });
            this.active.done = running;
            try { send({ result: await running }); } finally { this.active = null; }
          } else {
            let executable = this.executable;
            if (input.action === 'finish') {
              let state;
              try { state = await readJson(path.join(root, input.taskId, 'state.json')); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
              executable = executionHarness(state || input) === 'codex' ? await codexExecutable(config) : undefined;
            }
            const result = await providerRequest(input, { root, executable, limits: transferLimits(config.provider) });
            if (input.action === 'status') {
              result.executionActive = this.active?.taskId === input.taskId && this.active?.pairId === pairId;
              if (result.status === 'running' && !result.executionActive) Object.assign(result, { recordedStatus: 'running', status: 'unknown', reason: 'The recorded execution is not owned by the current sharing process.' });
            }
            send({ result });
          }
        }
      }
    } catch (error) { send({ error: error.message }); }
    finally { res.end(); }
  }
  async pairings() {
    const config = await this.store.read();
    return { pairings: Object.entries(config.provider?.pairings || {}).map(([pairId, peer]) => ({ pairId, name: peer.name, pairedAt: peer.pairedAt })) };
  }
  async revoke(pairId, cleanup = 'keep', signal) {
    taskId(pairId);
    if (!['keep', 'records', 'all'].includes(cleanup)) throw new Error('Choose cleanup explicitly: keep, records or all.');
    await this.store.update(config => {
      if (!Object.hasOwn(config.provider?.pairings || {}, pairId)) throw new Error('Unknown pairing.');
      delete config.provider.pairings[pairId];
    });
    if (this.active?.pairId === pairId) {
      const active = this.active;
      active.response.destroy();
      active.controller.abort();
      // The original request reports the interruption and persists its state.
      await active.done.catch(() => {});
    }
    return { pairId, status: 'revoked', cleanup: cleanup === 'keep' ? { status: 'retained' } : await this.cleanup(pairId, cleanup, signal) };
  }
  async cleanup(pairId, cleanup, signal) {
    taskId(pairId);
    if (!['keep', 'records', 'all'].includes(cleanup)) throw new Error('Choose cleanup explicitly: keep, records or all.');
    if (cleanup === 'keep') return { pairId, status: 'retained' };
    const config = await this.store.read();
    if (Object.hasOwn(config.provider?.pairings || {}, pairId)) throw new Error('Disconnect this caller with revoke_pairing before deleting its data.');
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
      const state = await readJson(path.join(directory, pair, taskId(id), 'state.json'));
      const report = reports.find(r => r.pairId === pair && r.taskId === id && r.revision === state.revision);
      tasks.push({ pairId: pair, taskId: id, harness: state.harness || 'codex', createdAt: state.createdAt, endedAt: state.endedAt, status: state.status, revision: state.revision, savedRevision: state.savedRevision, saveConfirmed: Boolean(state.lastSync), unresolvedSkipped: state.unresolvedSkipped, expiresAt: state.expiresAt, retentionDays: state.retentionDays, expired: Boolean(state.expiresAt && Date.now() >= Date.parse(state.expiresAt)), cleanup: state.cleanup || report, error: state.error, inspection: await inspectTask(path.join(directory, pair, id), details) });
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
    if (!input.discardUncollected && (!state.syncVersion || state.savedRevision !== state.revision)) throw new Error('Results have not been confirmed saved by the caller. Inspect this task and explicitly choose discardUncollected to abandon them.');
    const executable = executionHarness(state) === 'codex' ? await codexExecutable(await this.store.read()) : undefined;
    return providerRequest({ action: 'finish', taskId: input.taskId, revision: state.savedRevision, cleanup: input.cleanup }, { root, executable, signal, ownerCleanup: input.discardUncollected === true });
  }
  stop() { this.startRequested = false; this.accepting = false; this.invite = null; return { ...this.status(), note: 'New turns and pairing are stopped. Existing tasks may finish; paired callers can still query, cancel and collect. Use cancel_shared_task to interrupt a task.' }; }
  async close() {
    this.closing = true;
    clearInterval(this.sweepTimer);
    this.stop();
    if (this.starting) await this.starting.catch(() => {}); // The starting tool reports its own error.
    if (!this.server) return;
    const closing = new Promise(resolve => this.server.close(resolve));
    if (this.active) {
      this.active.controller.abort();
      await this.active.done.catch(() => {}); // The request handler reports and persists the execution error.
    }
    this.server.closeAllConnections();
    await closing; this.server = null;
    await fs.rm(path.join(this.root, 'runtime.json'), { force: true });
    await this.release(); this.release = null;
  }
}
