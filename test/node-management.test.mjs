import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../lib/config.mjs';
import { Sharing, lanRequest } from '../lib/lan.mjs';

test('local node management survives loss of the LAN listener', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-management-'));
  const store = new Config(path.join(root, 'config.json'));
  await store.update(config => { config.provider = { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) }; });
  const node = new Sharing(store, root);
  const manager = new Sharing(store, root);
  t.after(async () => { await node.close(); await fs.rm(root, { recursive: true, force: true }); });
  const before = await node.manage('start', { address: '127.0.0.1', port: 0 });
  assert.equal((await manager.machineStatus()).status, 'sharing');
  // Remove only the LAN transport, as happens when its bound interface disappears.
  node.server.closeAllConnections();
  await new Promise(resolve => node.server.close(resolve));
  const after = await manager.machineStatus();
  assert.equal(after.status, 'sharing');
  assert.equal(after.ownerPid, before.ownerPid);
  assert.equal(after.occupiedSlots, 0);
  assert.equal((await manager.manage('stop')).status, 'stopped');
  const runtime = await manager.runtime();
  assert.equal(runtime.host, '127.0.0.1');
  assert.notEqual(runtime.port, before.port);
  await assert.rejects(lanRequest({ ...runtime, token: 'x'.repeat(43) }, '/local', { action: 'status' }), /not authorized/);
  await assert.rejects(lanRequest(runtime, '/rpc', { action: 'status' }), /Incomplete LAN response \(404\)/);
  await manager.manage('exit');
  assert.equal(await manager.runtime(), null);
});

test('failed runtime publication closes the management listener and allows a clean retry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-management-start-'));
  const store = new Config(path.join(root, 'config.json'));
  await store.update(config => { config.provider = { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) }; });
  const node = new Sharing(store, root);
  t.after(async () => { await node.close(); await fs.rm(root, { recursive: true, force: true }); });
  const writeFile = fs.writeFile.bind(fs);
  let endpoint;
  const failure = t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (String(file).includes('runtime.json')) {
      endpoint = { ...node.endpoint, host: '127.0.0.1', port: node.managementServer.address().port, token: node.localToken };
      throw new Error('test runtime publication failed');
    }
    return writeFile(file, ...args);
  });
  await assert.rejects(node.manage('start', { address: '127.0.0.1', port: 0 }), /test runtime publication failed/);
  failure.mock.restore();
  assert.ok(endpoint);
  await assert.rejects(lanRequest(endpoint, '/local', { action: 'status' }), /ECONNREFUSED/);
  assert.equal(node.managementServer, null);
  assert.equal(await node.runtime(), null);
  assert.equal((await node.manage('start', { address: '127.0.0.1', port: 0 })).status, 'sharing');
  const manager = new Sharing(store, root);
  assert.equal((await manager.machineStatus()).status, 'sharing');
  await manager.manage('exit');
});

for (const [name, interfaces, explicit, expected] of [
  ['uses the only current interface after the saved address disappears', ['127.0.0.1'], undefined, '127.0.0.1'],
  ['asks for a choice when the saved address disappears with multiple interfaces', ['127.0.0.1', '10.23.45.67'], undefined, null],
  ['retains an explicit address choice with multiple interfaces', ['127.0.0.1', '10.23.45.67'], '127.0.0.1', '127.0.0.1'],
]) {
  test(`node restart ${name}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-restart-address-'));
    const store = new Config(path.join(root, 'config.json'));
    await store.update(config => { config.provider = { address: '192.168.254.253', codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) }; });
    // Only the interface inventory is simulated; start still opens real HTTPS sockets.
    t.mock.method(os, 'networkInterfaces', () => ({ test: interfaces.map(address => ({ family: 'IPv4', internal: false, address })) }));
    const node = new Sharing(store, root);
    t.after(async () => { await node.close(); await fs.rm(root, { recursive: true, force: true }); });
    if (expected) {
      assert.equal((await node.manage('start', { ...(explicit ? { address: explicit } : {}), port: 0 })).host, expected);
      assert.equal((await store.read()).provider.address, expected);
    } else {
      await assert.rejects(node.manage('start', { port: 0 }), /Select a private-network address/);
      assert.equal((await store.read()).provider.address, '192.168.254.253');
    }
  });
}
