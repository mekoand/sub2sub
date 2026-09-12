import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Config } from '../lib/config.mjs';
import { Client } from '../lib/client.mjs';
import { openMcp } from './helpers/mcp.mjs';

async function setup(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-web-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state'), configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ stateRoot, peers: {}, ...extra }));
  const store = new Config(configPath), client = new Client(await store.read(), stateRoot, store);
  t.after(() => client.close());
  return { root, stateRoot, configPath, store, client };
}
const endpoint = status => ({ origin: new URL(status.url).origin, headers: { Authorization: `Bearer ${new URL(status.url).hash.slice(1)}` } });

test('EOF during MCP initialization and closing a starting listener leave no orphan process', async t => {
  const { client, configPath } = await setup(t);
  const starting = client.web.start();
  await client.close(); await starting;
  assert.equal(client.web.status().enabled, false);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))], { env: { ...process.env, SUB2SUB_CONFIG: configPath }, stdio: ['pipe', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end(JSON.stringify({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  assert.equal(await exited, 0);
  clearTimeout(timeout);
});

test('MCP enables loopback management without model startup or config writes; switch persists and host shutdown closes it', async t => {
  const { configPath } = await setup(t);
  const original = await fs.readFile(configPath, 'utf8');
  const mcp = await openMcp(configPath, { env: { SUB2SUB_CODEX: '/synthetic/unavailable', SUB2SUB_CLAUDE: '/synthetic/unavailable' } });
  let closed = false; t.after(async () => { if (!closed) await mcp.close(); });
  const catalog = await mcp.request('tools/list');
  assert.ok(catalog.tools.some(tool => tool.name === 'resource_statistics'));
  const status = await mcp.tool('web_management');
  const { origin, headers } = endpoint(status);
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const overview = await fetch(`${origin}/api/overview`, { headers });
  assert.equal(overview.status, 200); assert.deepEqual((await overview.json()).tasks, []);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  const off = await fetch(`${origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'web_management', input: { enabled: false } }) });
  assert.equal((await off.json()).enabled, false);
  assert.equal((await mcp.tool('web_management')).status, 'disabled');
  assert.equal(JSON.parse(await fs.readFile(configPath)).webManagement.enabled, false);
  const next = await openMcp(configPath); t.after(() => next.close());
  assert.equal((await next.tool('web_management')).enabled, false);
  const reopened = endpoint(await mcp.tool('web_management', { enabled: true }));
  assert.notEqual(reopened.headers.Authorization, headers.Authorization);
  await mcp.close(); closed = true;
  await assert.rejects(fetch(`${reopened.origin}/api/overview`, { headers: reopened.headers }));
});

test('web actions require private token, exact local Host/Origin and the shared tool schema', async t => {
  const { client, store } = await setup(t);
  const { origin, headers } = endpoint(await client.call('web_management', {}));
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(`${origin}/api/overview`)).status, 401);
  assert.equal((await fetch(`${origin}/api/overview`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  const hostCode = await new Promise((resolve, reject) => { const req = http.get(origin + '/api/overview', { headers: { ...headers, Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(hostCode, 403);
  for (const body of [{ name: 'start_task', input: {} }, { name: 'caller_settings', input: { inputFiles: '5' } }, { name: 'caller_settings', input: { unexpected: true } }]) {
    const response = await fetch(`${origin}/api/call`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  const request = await fetch(`${origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'caller_settings', input: { inputFiles: 12 } }) });
  assert.equal(request.status, 200); assert.equal((await store.read()).caller.inputFiles, 12);
  const blocked = await fetch(`${origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'create_pairing' }) });
  assert.equal((await blocked.json()).status, 'onboarding_required');
});

test('saved artifacts work with an offline peer, stay inert, and cannot traverse paths or symlinks', async t => {
  const { client, stateRoot } = await setup(t);
  await client.initialize();
  const id = randomUUID(), generation = path.join(stateRoot, 'workcopies', id, 'generation'), results = path.join(stateRoot, 'results', `${id}-saved`);
  await fs.mkdir(path.join(generation, 'files'), { recursive: true }); await fs.mkdir(results, { recursive: true });
  const content = '<script>window.PWNED = true</script>中文成果';
  await fs.writeFile(path.join(generation, 'files', 'report.html'), content);
  await fs.writeFile(path.join(results, 'response.md'), 'Saved answer');
  await fs.writeFile(path.join(results, 'changes.json'), JSON.stringify({ skipped: ['.cache/required.txt'], error: 'Stopped at deadline', stopReason: 'time_limit', status: 'interrupted', revision: 2 }));
  const record = { peer: 'offline', resultDirectory: results, workCopyRoot: generation, workCopyPaths: ['report.html', 'linked'], savedAt: new Date().toISOString(), deliveryPending: true };
  const index = path.join(stateRoot, 'tasks', `${id}.json`); await fs.writeFile(index, JSON.stringify(record));
  await fs.symlink(path.join(results, 'response.md'), path.join(generation, 'files', 'linked'));
  const { origin, headers } = endpoint(await client.call('web_management', {}));
  const detail = await (await fetch(`${origin}/api/task?id=${id}`, { headers })).json();
  assert.equal(detail.deliveryPending, true);
  assert.deepEqual(detail.delivery.skipped, ['.cache/required.txt']);
  assert.equal(detail.delivery.stopReason, 'time_limit');
  assert.equal(detail.delivery.error, 'Stopped at deadline');
  const preview = await fetch(`${origin}/api/file?id=${id}&path=report.html`, { headers });
  assert.match(preview.headers.get('Content-Type'), /application\/json/);
  assert.equal((await preview.json()).text, content);
  const download = await fetch(`${origin}/api/file?id=${id}&path=report.html&download=true`, { headers });
  assert.equal(download.headers.get('Content-Disposition'), 'attachment'); assert.equal(await download.text(), content);
  for (const name of ['../response.md', '/etc/passwd', 'linked', 'missing']) {
    assert.equal((await fetch(`${origin}/api/file?id=${id}&path=${encodeURIComponent(name)}`, { headers })).status, 400);
  }
  record.resultDirectory = path.join(stateRoot, 'elsewhere'); await fs.writeFile(index, JSON.stringify(record));
  assert.equal((await fetch(`${origin}/api/file?id=${id}&answer=true`, { headers })).status, 400);
});

test('web and conversation share visibility settings without requiring a model call', async t => {
  const { client, store } = await setup(t, { provider: { codexPath: '/missing/native/codex' } });
  const { origin, headers } = endpoint(await client.call('web_management', {}));
  const response = await fetch(`${origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'provider_settings', input: { keepSessionVisible: true } }) });
  const saved = await response.json();
  assert.equal(response.status, 200); assert.equal(saved.keepSessionVisible, true);
  assert.equal((await client.call('provider_settings', {})).keepSessionVisible, true);
  assert.equal((await store.read()).provider.keepSessionVisible, true);
  await assert.rejects(client.call('provider_settings', { keepSessionVisible: 'false' }), /boolean/);
  await store.update(config => { config.provider.harness = 'claude'; });
  const unsupported = await client.call('provider_settings', {});
  assert.equal(unsupported.keepSessionVisible, true); assert.equal(unsupported.sessionVisibilitySupported, false);
  assert.match(unsupported.note, /Claude.*unsupported/);
});

test('management exposes the same device name and local storage preview as conversation tools', async t => {
  const { client } = await setup(t);
  const { origin, headers } = endpoint(await client.call('web_management', {}));
  const call = async (name, input = {}) => {
    const response = await fetch(`${origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name, input }) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await call('device_settings', { name: '办公室 Mac' })).deviceName, '办公室 Mac');
  assert.equal((await client.call('device_settings', {})).deviceName, '办公室 Mac');
  assert.equal((await call('local_storage')).bytes, 0);
  assert.equal((await (await fetch(`${origin}/api/overview`, { headers })).json()).device, '办公室 Mac');
});

test('provider connection rules can be edited through management using the shared nullable schema', async t => {
  const pairId = randomUUID();
  const { client, store } = await setup(t, { provider: { pairings: { [pairId]: { name: 'Synthetic caller', pairedAt: new Date().toISOString(), tokenHash: 'a'.repeat(64) } } } });
  const { origin, headers } = endpoint(await client.call('web_management', {}));
  const edit = input => fetch(`${origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'pairing_settings', input: { pairId, ...input } }) });
  const expiresAt = '2030-01-15T10:30:00.000Z';
  let response = await edit({ maxConcurrent: 2, expiresAt });
  assert.equal(response.status, 200); assert.equal((await response.json()).expiresAt, expiresAt);
  response = await edit({ maxConcurrent: '2' }); assert.equal(response.status, 400);
  response = await edit({ maxConcurrent: null, expiresAt: null }); assert.equal(response.status, 200);
  assert.equal((await response.json()).authorizationStatus, 'active');
  const saved = (await store.read()).provider.pairings[pairId];
  assert.equal(saved.maxConcurrent, null); assert.equal(saved.expiresAt, null);
  const overview = await (await fetch(`${origin}/api/overview?role=provider`, { headers })).json();
  assert.equal(overview.peers[0].maxConcurrent, null);
  assert.ok(!JSON.stringify(overview).includes('tokenHash'));
});
