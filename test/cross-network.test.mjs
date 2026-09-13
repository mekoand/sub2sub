import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { Client } from '../lib/client.mjs';
import { Config } from '../lib/config.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-network-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) { await client.close(); await stopTestSharing(client.stateRoot); }
    await fs.rm(root, { recursive: true, force: true });
  });
  const device = async name => {
    const store = new Config(path.join(root, name + '.json'));
    await store.update(c => Object.assign(c, { deviceName: name, stateRoot: path.join(root, name), peers: {}, provider: { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } }));
    const client = new Client(await store.read(), path.join(root, name), store); clients.push(client); return client;
  };
  return { root, device, clients };
}

test('one device setting is visible to other managers without starting sharing', async t => {
  const { device, clients } = await setup(t);
  const caller = await device('caller');
  const other = new Client(await caller.store.read(), caller.stateRoot, new Config(caller.store.file)); clients.push(other);
  await caller.call('device_settings', { crossNetwork: true });
  assert.equal((await other.call('device_settings', {})).crossNetwork.enabled, true);
  assert.equal((await other.call('sharing_status', {})).status, 'stopped');
  await other.call('device_settings', { crossNetwork: false });
  assert.equal((await caller.call('device_settings', {})).crossNetwork.enabled, false);
});

test('explicitly enabled devices pair and continue one task through the transport helper', async t => {
  const before = process.env.SUB2SUB_TAILCAT;
  process.env.SUB2SUB_TAILCAT = process.env.SUB2SUB_REAL_TAILCAT || fileURLToPath(new URL('./fixtures/fake-tailcat.mjs', import.meta.url));
  t.after(() => { if (before === undefined) delete process.env.SUB2SUB_TAILCAT; else process.env.SUB2SUB_TAILCAT = before; });
  const { root, device } = await setup(t);
  const owner = await device('owner'), caller = await device('caller');
  await owner.call('device_settings', { crossNetwork: true });
  const invitation = await owner.call('create_pairing', { address: '127.0.0.1', port: 0 });
  const payload = JSON.parse(Buffer.from(invitation.invitation.slice(8), 'base64url').toString());
  assert.equal(payload.version, 2);
  assert.ok(payload.tailcat);
  // Make the advertised direct endpoint unavailable. The helper remains reachable.
  payload.port = 1;
  const input = { invitation: 'sub2sub:' + Buffer.from(JSON.stringify(payload)).toString('base64url'), peer: 'owner', allowTaskFiles: true };
  await assert.rejects(caller.call('pair_peer', input), /cross.network.*off|enable.*cross.network/i);
  await caller.call('device_settings', { crossNetwork: true });
  const fingerprint = payload.fingerprint; payload.fingerprint = 'F'.repeat(64);
  await assert.rejects(caller.call('pair_peer', { ...input, invitation: 'sub2sub:' + Buffer.from(JSON.stringify(payload)).toString('base64url') }), /certificate does not match/);
  payload.fingerprint = fingerprint;
  assert.equal((await caller.call('pair_peer', input)).status, 'paired');
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'input.txt'), 'test input');
  const copy = await caller.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await caller.call('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'write result' });
  assert.equal(first.status, 'completed');
  const next = await caller.call('continue_task', { taskId: first.taskId, prompt: 'write more' });
  assert.equal(next.threadId, first.threadId);
  assert.equal((await caller.call('collect_result', { taskId: first.taskId })).status, 'completed');
  await owner.call('exit_sharing', {});
  await owner.call('start_sharing', {});
  assert.equal((await caller.call('check_peer', { peer: 'owner' })).status, 'available');
  await owner.call('stop_sharing', {});
  assert.equal((await caller.call('collect_result', { taskId: first.taskId })).status, 'completed');
  await owner.call('device_settings', { crossNetwork: false });
  assert.equal((await owner.call('device_settings', {})).crossNetwork.enabled, false);
  await owner.call('device_settings', { crossNetwork: true });
  assert.equal((await owner.call('sharing_status', {})).status, 'stopped');
  assert.equal((await caller.call('collect_result', { taskId: first.taskId })).status, 'completed');
  await owner.call('device_settings', { crossNetwork: false });
});

for (const termination of ['cancel', 'revoke']) test(`both devices preserve active cross-network tasks through caller restart and allow closing after ${termination}`, async t => {
  const before = process.env.SUB2SUB_TAILCAT;
  process.env.SUB2SUB_TAILCAT = process.env.SUB2SUB_REAL_TAILCAT || fileURLToPath(new URL('./fixtures/fake-tailcat.mjs', import.meta.url));
  t.after(() => { if (before === undefined) delete process.env.SUB2SUB_TAILCAT; else process.env.SUB2SUB_TAILCAT = before; });
  const { root, device } = await setup(t);
  const owner = await device('owner'), caller = await device('caller');
  await owner.call('device_settings', { crossNetwork: true });
  await caller.call('device_settings', { crossNetwork: true });
  const invitation = await owner.call('create_pairing', { address: '127.0.0.1', port: 0 });
  const payload = JSON.parse(Buffer.from(invitation.invitation.slice(8), 'base64url').toString()); payload.port = 1;
  await caller.call('pair_peer', { invitation: 'sub2sub:' + Buffer.from(JSON.stringify(payload)).toString('base64url'), peer: 'owner', allowTaskFiles: true });
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'input.txt'), 'test');
  const copy = await caller.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  let ready; const started = new Promise(resolve => { ready = resolve; });
  const controller = new AbortController();
  const running = caller.call('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'hang' }, text => { if (text.includes('Waiting for cancellation')) ready(); }, controller.signal).catch(error => error);
  await started;
  await assert.rejects(owner.call('device_settings', { crossNetwork: false }), /finish.*cancel/i);
  await assert.rejects(caller.call('device_settings', { crossNetwork: false }), /finish.*cancel/i);
  await assert.rejects(caller.call('exit_sharing', {}), /finish.*cancel/i);
  assert.equal((await owner.call('device_settings', {})).crossNetwork.enabled, true);
  const task = (await owner.call('list_shared_tasks', {})).tasks[0];
  controller.abort(); await running;
  const runtime = await caller.sharing.runtime();
  process.kill(runtime.pid, 'SIGKILL');
  while (await caller.sharing.runtime()) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(caller.call('device_settings', { crossNetwork: false }), /finish.*cancel/i);
  assert.equal((await owner.call('list_shared_tasks', {})).tasks.length, 1);
  if (termination === 'revoke') await owner.call('revoke_pairing', { pairId: task.pairId });
  else await caller.call('cancel_task', { taskId: task.taskId });
  for (let i = 0; i < 100; i++) {
    if (termination === 'revoke' || !(await caller.call('task_status', { taskId: task.taskId })).executionActive) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await caller.call('device_settings', { crossNetwork: false });
  await owner.call('device_settings', { crossNetwork: false });
});

test('concurrent managers promote a caller node to one private-network listener', async t => {
  const { device, clients } = await setup(t);
  const owner = await device('owner');
  const other = new Client(await owner.store.read(), owner.stateRoot, new Config(owner.store.file)); clients.push(other);
  await owner.call('device_settings', { crossNetwork: false });
  const states = await Promise.all([owner, other].map(c => c.call('start_sharing', { address: '127.0.0.1', port: 0 })));
  assert.equal(states[0].port, states[1].port);
  assert.equal(states[0].ownerPid, states[1].ownerPid);
  await owner.call('exit_sharing', {});
});

test('an unauthenticated unfinished invitation request cannot keep cross-network enabled', async t => {
  const before = process.env.SUB2SUB_TAILCAT;
  process.env.SUB2SUB_TAILCAT = fileURLToPath(new URL('./fixtures/fake-tailcat.mjs', import.meta.url));
  t.after(() => { if (before === undefined) delete process.env.SUB2SUB_TAILCAT; else process.env.SUB2SUB_TAILCAT = before; });
  const { device } = await setup(t);
  const owner = await device('owner');
  await owner.call('device_settings', { crossNetwork: true });
  const invite = await owner.call('create_pairing', { address: '127.0.0.1', port: 0 });
  const payload = JSON.parse(Buffer.from(invite.invitation.slice(8), 'base64url').toString());
  const request = https.request({ hostname: '127.0.0.1', port: Number(payload.tailcat.split(':')[1]), method: 'POST', path: '/pair', rejectUnauthorized: false, headers: { expect: '100-continue', 'content-length': '100' } });
  request.on('error', () => {}); t.after(() => request.destroy());
  const entered = new Promise(resolve => request.once('continue', resolve));
  request.flushHeaders(); await entered;
  await owner.call('device_settings', { crossNetwork: false });
  assert.equal((await owner.call('device_settings', {})).crossNetwork.enabled, false);
});

test('explicit migration retains an existing pairing, consent and native task, and failed identity checks retain the old route', async t => {
  const before = process.env.SUB2SUB_TAILCAT;
  process.env.SUB2SUB_TAILCAT = fileURLToPath(new URL('./fixtures/fake-tailcat.mjs', import.meta.url));
  t.after(() => { if (before === undefined) delete process.env.SUB2SUB_TAILCAT; else process.env.SUB2SUB_TAILCAT = before; });
  const { root, device } = await setup(t);
  const owner = await device('owner'), caller = await device('caller');
  const invite = await owner.call('create_pairing', { address: '127.0.0.1', port: 0 });
  const paired = await caller.call('pair_peer', { invitation: invite.invitation, peer: 'owner', allowTaskFiles: true });
  const source = path.join(root, 'input'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'input.txt'), 'migration');
  const copy = await caller.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const original = await caller.call('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'before migration' });
  await assert.rejects(caller.call('edit_peer', { peer: 'owner', migrate: true }), /enable.*cross.network|cross.network.*off/i);
  await caller.call('device_settings', { crossNetwork: true });
  await owner.call('device_settings', { crossNetwork: true });
  assert.equal((await caller.call('list_peers', {})).peers[0].crossNetwork, false);
  const migrated = await caller.call('edit_peer', { peer: 'owner', migrate: true });
  assert.equal(migrated.crossNetwork, true);
  const config = await caller.store.read(); const peer = config.peers.owner;
  assert.equal(peer.pairId, paired.pairId); assert.equal(peer.transferAuthorization.scope, 'task-files');
  const bad = JSON.parse(Buffer.from((await owner.call('create_pairing', {})).invitation.slice(8), 'base64url').toString());
  bad.fingerprint = '0'.repeat(64);
  await assert.rejects(caller.call('edit_peer', { peer: 'owner', migrate: true, invitation: 'sub2sub:' + Buffer.from(JSON.stringify(bad)).toString('base64url') }), /identity|certificate/i);
  assert.deepEqual((await caller.store.read()).peers.owner, peer);
  // Preserve the old pairing while recovering via a new invitation when its direct address is no longer reachable.
  const replacement = JSON.parse(Buffer.from((await owner.call('create_pairing', {})).invitation.slice(8), 'base64url').toString());
  replacement.port = 1;
  await caller.call('edit_peer', { peer: 'owner', migrate: true, invitation: 'sub2sub:' + Buffer.from(JSON.stringify(replacement)).toString('base64url') });
  const next = await caller.call('continue_task', { taskId: original.taskId, prompt: 'after migration' });
  assert.equal(next.threadId, original.threadId);
  assert.equal((await owner.call('list_pairings', {})).pairings.length, 1);
});
