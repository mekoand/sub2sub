import http from 'node:http';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, safePath } from './files.mjs';
import { taskId } from './provider.mjs';
import { validateToolInput } from './tools.mjs';
import { summarizeTasks } from './statistics.mjs';
import { deviceName } from './config.mjs';
import packageInfo from '../package.json' with { type: 'json' };

const assets = fileURLToPath(new URL('../web/', import.meta.url));
const actions = new Set(['device_settings', 'local_storage', 'cleanup_local_files', 'list_shared_tasks', 'onboarding', 'caller_settings', 'provider_settings', 'list_models', 'resource_usage', 'start_sharing', 'stop_sharing', 'exit_sharing', 'create_pairing', 'pair_peer', 'authorize_peer', 'list_pairings', 'pairing_settings', 'revoke_pairing', 'cleanup_shared_task', 'cancel_shared_task', 'edit_peer', 'delete_peer', 'check_peer', 'task_status', 'cancel_task', 'collect_result', 'finish_task', 'web_management']);
const security = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

export class Management {
  constructor(client) { this.client = client; }
  status() {
    return { enabled: Boolean(this.server), status: this.error ? 'unavailable' : this.server ? 'running' : 'disabled', url: this.server ? `${this.origin}/#${this.token}` : undefined, error: this.error, ownerPid: process.pid,
      note: 'Private local management link. The listener belongs to this MCP process and ends when it exits; independent sharing is unaffected. No browser is opened automatically.' };
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  async open() {
    const config = this.client.store ? await this.client.store.read() : this.client.config;
    if (config.webManagement?.enabled === false) { await this.closeListener(); return this.status(); }
    if (this.server) return this.status();
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 30;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    server.on('error', error => { this.error = error.message; process.stderr.write(`sub2sub management server: ${error.message}\n`); });
    this.server = server;
    this.origin = `http://127.0.0.1:${server.address().port}`;
    this.token = randomBytes(32).toString('base64url');
    this.error = undefined;
    return this.status();
  }
  async close() {
    await this.starting;
    await this.closeListener();
  }
  async closeListener() {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined; this.token = undefined;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  async handle(req, res) {
    const json = (value, code = 200) => { res.writeHead(code, { ...security, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.headers.host !== new URL(this.origin).host || req.headers.origin && req.headers.origin !== this.origin) { json({ error: 'Local origin required.' }, 403); return; }
      const url = new URL(req.url, this.origin);
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(staticFiles, url.pathname)) {
        const [file, type] = staticFiles[url.pathname];
        const content = await fs.readFile(path.join(assets, file));
        res.writeHead(200, { ...security, 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      const token = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
      const expected = Buffer.from(this.token || '');
      if (!expected.length || token.length !== expected.length || !timingSafeEqual(token, expected)) { json({ error: 'Open the private link returned by web_management.' }, 401); return; }
      const config = this.client.store ? await this.client.store.read() : this.client.config;
      if (config.webManagement?.enabled === false) {
        res.once('finish', () => { void this.close().catch(error => { process.stderr.write(`sub2sub management shutdown: ${error.message}\n`); }); });
        json({ error: 'Web management is disabled. Reopen it from the conversation.' }, 410); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const role = url.searchParams.get('role') || 'caller', days = Number(url.searchParams.get('days') || 7);
        validateToolInput('resource_statistics', { role, days });
        const call = (name, input = {}) => this.client.call(name, input, undefined, controller.signal);
        const { tasks } = await call(role === 'caller' ? 'list_tasks' : 'list_shared_tasks');
        const peers = role === 'caller' ? (await call('list_peers', { check: url.searchParams.get('check') === 'true' })).peers : (await call('list_pairings')).pairings;
        json({ device: deviceName(config), version: packageInfo.version, platform: os.platform(), role, tasks, peers,
          sharing: await call('sharing_status'), statistics: summarizeTasks(tasks, { role, days }) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/task') {
        await this.client.initialize();
        const id = taskId(url.searchParams.get('id'));
        const saved = await readJson(path.join(this.client.stateRoot, 'tasks', `${id}.json`));
        let delivery;
        if (saved.resultDirectory) {
          const manifest = await this.openFile(id, undefined, 'changes.json');
          try {
            const result = JSON.parse(await manifest.readFile('utf8'));
            if (!Array.isArray(result.skipped) || result.skipped.some(name => typeof name !== 'string')) throw new Error('Invalid saved delivery file list.');
            delivery = { status: result.status, error: result.error, stopReason: result.stopReason, skipped: result.skipped, revision: result.revision };
          } finally { await manifest.close(); }
        }
        json({ taskId: id, responseFile: saved.resultDirectory ? path.join(saved.resultDirectory, 'response.md') : undefined,
          files: saved.workCopyPaths || [], workCopyDirectory: saved.workCopyRoot ? path.join(saved.workCopyRoot, 'files') : undefined,
          localFilesCleaned: saved.localFilesCleaned, savedAt: saved.savedAt, deliveryPending: saved.deliveryPending, delivery }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const handle = await this.openFile(taskId(url.searchParams.get('id')), url.searchParams.get('path'), url.searchParams.get('answer') === 'true' ? 'response.md' : undefined);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Saved artifact is not a regular file.');
          if (url.searchParams.get('download') === 'true') {
            res.writeHead(200, { ...security, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' });
            const stream = handle.createReadStream({ autoClose: false });
            await new Promise((resolve, reject) => { stream.on('error', reject); res.on('error', reject); res.on('close', resolve); stream.pipe(res); });
          } else {
            const buffer = Buffer.alloc(Math.min(stat.size, 128 * 1024));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            json({ text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: stat.size > buffer.length });
          }
        } finally { await handle.close(); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/call') {
        let body = '';
        req.setEncoding('utf8');
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Management request exceeds 128 KiB.'); }
        const request = JSON.parse(body);
        if (!actions.has(request.name)) throw new Error('This operation is not available in the management page.');
        const input = validateToolInput(request.name, request.input);
        if (request.name === 'web_management' && input.enabled === false) {
          await this.client.store.update(current => { current.webManagement = { enabled: false }; });
          res.once('finish', () => { void this.close().catch(error => { process.stderr.write(`sub2sub management shutdown: ${error.message}\n`); }); });
          json({ enabled: false, status: 'disabled' }); return;
        }
        json(await this.client.call(request.name, input, undefined, controller.signal)); return;
      }
      json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (!res.headersSent) json({ error: error.message }, 400);
      else res.destroy(error);
    }
  }
  async openFile(id, name, resultFile) {
    await this.client.initialize();
    const root = this.client.stateRoot;
    const saved = await readJson(path.join(root, 'tasks', `${id}.json`));
    let file;
    if (resultFile) {
      if (!saved.resultDirectory || path.dirname(saved.resultDirectory) !== path.join(root, 'results') || !path.basename(saved.resultDirectory).startsWith(`${id}-`)) throw new Error('No saved answer for this task.');
      file = path.join(saved.resultDirectory, resultFile);
    } else {
      safePath(name);
      if (!saved.workCopyRoot || path.dirname(saved.workCopyRoot) !== path.join(root, 'workcopies', id) || !saved.workCopyPaths?.includes(name)) throw new Error('File is not in the saved task copy.');
      file = path.join(saved.workCopyRoot, 'files', name);
    }
    // Check every persisted path component; a task artifact cannot browse the host.
    const relative = path.relative(root, file);
    safePath(relative.split(path.sep).join('/'));
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked artifacts cannot be opened through management.');
    }
    return fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
}
