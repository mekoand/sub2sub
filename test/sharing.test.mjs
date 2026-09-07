import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMcp } from './helpers/mcp.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';
import { Sharing } from '../lib/lan.mjs';
import { Config } from '../lib/config.mjs';

test('sharing accepts and delivers work after its management process exits', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-independent-'));
  const processes = [];
  t.after(async () => {
    await Promise.all(processes.map(p => p.close()));
    for (const name of ['owner', 'caller']) await stopTestSharing(path.join(root, name));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ['owner', 'caller']) await fs.writeFile(path.join(root, `${name}.json`), JSON.stringify({
    stateRoot: path.join(root, name), peers: {},
    provider: { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) }
  }));
  const owner = await openMcp(path.join(root, 'owner.json')); processes.push(owner);
  const caller = await openMcp(path.join(root, 'caller.json')); processes.push(caller);
  const invite = await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'owner', allowTaskFiles: true });
  await owner.close();
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'available');
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'input.txt'), 'A task after the management tool closes.');
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution' });
  const result = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(JSON.parse(await fs.readFile(result.responseFile, 'utf8')).model, 'gpt-5.6-luna');
  const manager = await openMcp(path.join(root, 'owner.json')); processes.push(manager);
  assert.equal((await manager.tool('sharing_status')).status, 'sharing');
  const probe = process.kill;
  const ownerPid = (await manager.tool('sharing_status')).ownerPid;
  const mocked = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === ownerPid && signal === 0) throw Object.assign(new Error('Different Windows logon session'), { code: 'EPERM' });
    return probe(pid, signal);
  });
  assert.equal((await new Sharing(new Config(path.join(root, 'owner.json')), path.join(root, 'owner')).machineStatus()).status, 'sharing');
  mocked.mock.restore();
  const running = caller.tool('continue_task', { taskId: task.taskId, prompt: 'hang' });
  const outcome = running.then(value => ({ value }), error => ({ error }));
  let active;
  for (let i = 0; i < 100; i++) {
    active = (await manager.tool('sharing_status')).activeTask;
    if (active) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(active);
  await manager.close();
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'busy');
  const reopened = await openMcp(path.join(root, 'owner.json')); processes.push(reopened);
  await assert.rejects(reopened.tool('exit_sharing'), /active.*finish|cancel/i);
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'busy');
  await caller.tool('cancel_task', { taskId: task.taskId });
  await outcome;
  assert.equal((await reopened.tool('exit_sharing')).status, 'stopped');
  assert.equal((await reopened.tool('sharing_status')).status, 'stopped');
  await reopened.tool('start_sharing');
  const continued = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'report-execution' });
  assert.equal(continued.threadId, task.threadId);
});

test('simultaneous management processes start one node and repeated starts reuse it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-start-'));
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, JSON.stringify({ stateRoot: root, provider: { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } }));
  const managers = await Promise.all([openMcp(file), openMcp(file)]);
  t.after(async () => {
    await Promise.all(managers.map(p => p.close()));
    await stopTestSharing(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  const states = await Promise.all(managers.map(p => p.tool('start_sharing', { address: '127.0.0.1', port: 0 })));
  assert.equal(states[0].ownerPid, states[1].ownerPid);
  assert.ok(managers.every(p => p.child.pid !== states[0].ownerPid));
  assert.equal((await managers[1].tool('start_sharing')).ownerPid, states[0].ownerPid);
});


test('new management reports the existing node version and only loads new code after an explicit idle restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-update-'));
  const old = path.join(root, 'previous-package'), file = path.join(root, 'config.json');
  await fs.mkdir(old);
  const source = fileURLToPath(new URL('../', import.meta.url));
  for (const name of ['bin', 'lib', 'node_modules', 'package.json']) await fs.cp(path.join(source, name), path.join(old, name), { recursive: true });
  const version = JSON.parse(await fs.readFile(path.join(old, 'package.json'), 'utf8'));
  version.version = '0.0.0-previous'; await fs.writeFile(path.join(old, 'package.json'), JSON.stringify(version));
  await fs.writeFile(file, JSON.stringify({ stateRoot: path.join(root, 'state'), provider: { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } }));
  const before = await openMcp(file, { args: [path.join(old, 'bin/mcp.mjs')] });
  const current = await openMcp(file);
  t.after(async () => { await before.close(); await current.close(); await stopTestSharing(path.join(root, 'state')); await fs.rm(root, { recursive: true, force: true }); });
  const started = await before.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  await before.close();
  const observed = await current.tool('sharing_status');
  assert.equal(observed.version, '0.0.0-previous'); assert.notEqual(observed.installedVersion, observed.version);
  assert.equal((await current.tool('start_sharing')).ownerPid, started.ownerPid);
  await current.tool('exit_sharing');
  const restarted = await current.tool('start_sharing');
  assert.equal(restarted.version, observed.installedVersion); assert.equal(restarted.fingerprint, started.fingerprint);
});
