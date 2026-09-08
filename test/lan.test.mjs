import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import https from 'node:https';
import selfsigned from 'selfsigned';
import { openMcp } from './helpers/mcp.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';
import { Client, connect } from '../lib/client.mjs';
import { Config } from '../lib/config.mjs';
import { Sharing } from '../lib/lan.mjs';

async function setup(t, { clock = false, deadline = false, timeoutMs } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-lan-test-'));
  const clockFile = path.join(root, 'clock.txt'), initialTime = Date.now();
  if (clock) await fs.writeFile(clockFile, String(initialTime));
  const ownerOptions = clock ? { args: ['--import', fileURLToPath(new URL('./fixtures/clock.mjs', import.meta.url)), fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))], env: { SUB2SUB_TEST_CLOCK: clockFile } } : {};
  if (deadline) Object.assign(ownerOptions, { args: ['--import', fileURLToPath(new URL('./fixtures/deadline.mjs', import.meta.url)), fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))], env: { SUB2SUB_TEST_DEADLINE: path.join(root, 'deadline') } });
  const processes = [];
  const states = [];
  t.after(async () => {
    await Promise.all(processes.map(p => p.close()));
    for (const state of states) await stopTestSharing(state);
    await fs.rm(root, { recursive: true, force: true });
  });
  const device = async name => {
    states.push(path.join(root, name));
    const file = path.join(root, `${name}.json`);
    await fs.writeFile(file, JSON.stringify({ stateRoot: path.join(root, name), deviceName: name, peers: {}, provider: { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } }));
    const mcp = await openMcp(file, { timeoutMs, ...(name === 'owner' ? ownerOptions : {}) }); processes.push(mcp); return mcp;
  };
  const owner = await device('owner'), caller = await device('caller');
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'input.txt'), '任务输入');
  return { root, owner, caller, source, device, processes, clockFile, initialTime, ownerOptions };
}

async function interceptPeer(t, root, intercept) {
  const file = path.join(root, 'caller.json');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  const peer = { ...config.peers.owner };
  const identity = JSON.parse(await fs.readFile(path.join(root, 'owner/sharing/identity.json'), 'utf8'));
  const server = https.createServer(identity, async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const result = await connect(peer, input);
      if (await intercept(input, result) === 'disconnect') { res.destroy(); return; }
      res.end(JSON.stringify({ result }) + '\n');
    } catch (error) { res.end(JSON.stringify({ error: error.message }) + '\n'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  config.peers.owner.port = server.address().port;
  await fs.writeFile(file, JSON.stringify(config));
}

test('failed collection recommends collecting the same task without extra requests or execution', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'write result' });
  const requests = [];
  await interceptPeer(t, root, input => { requests.push(input.action); if (input.action === 'result') return 'disconnect'; });
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), error => {
    assert.match(error.message, /LAN connection failed/);
    assert.ok(error.message.includes(task.taskId));
    assert.match(error.message, /Retry collect_result.*do not rerun/i);
    return true;
  });
  assert.deepEqual(requests, ['result']);
});

test('lost execution reply preserves its error and recommends status without automatic probes', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const requests = [];
  await interceptPeer(t, root, input => { requests.push(input.action); if (input.action === 'run') return 'disconnect'; });
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'write result' }), /Task [\w-]+:.*LAN connection failed.*Query task_status.*before submitting/i);
  assert.deepEqual(requests, ['models', 'run']);
});

test('failed capability discovery preserves an unknown error without guessing an upgrade is required', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  await fs.writeFile(path.join(root, 'owner/sharing/model-list.json'), '{broken-catalog');
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'write result' }), error => {
    assert.match(error.message, /Cannot confirm provider capabilities/);
    assert.match(error.message, /cause is unconfirmed/i);
    assert.doesNotMatch(error.message, /update both endpoints to sub2sub 0\.4/i);
    return true;
  });
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
});

test('oversized input identifies the file and limit and suggests a smaller input', async t => {
  const { caller, source } = await setup(t);
  await caller.tool('caller_settings', { inputBytes: 2 });
  await assert.rejects(caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] }), /File exceeds 2 bytes limit: input\.txt.*smaller/i);
});

test('saving a received execution response fails with a collection hint for both initial and follow-up turns', { skip: process.platform === 'win32' }, async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const directory = path.join(root, 'caller/tasks');
  let taskId;
  await interceptPeer(t, root, async input => {
    if (input.action === 'run') { taskId = input.taskId; await fs.chmod(directory, 0o500); }
  });
  try {
    await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'write result' }), /EACCES.*Retry collect_result.*do not rerun/is);
  } finally { await fs.chmod(directory, 0o700); }
  assert.equal((await caller.tool('collect_result', { taskId })).status, 'completed');
  try {
    await assert.rejects(caller.tool('continue_task', { taskId, prompt: 'write more' }), /EACCES.*Retry collect_result.*do not rerun/is);
  } finally { await fs.chmod(directory, 0o700); }
  assert.equal((await caller.tool('collect_result', { taskId })).status, 'completed');
});

test('pairing generates and reuses its identity when the system OpenSSL configuration is missing', async t => {
  const { root, owner, caller, processes } = await setup(t);
  await owner.close();
  const options = { env: { PATH: path.dirname(process.execPath), OPENSSL_CONF: path.join(root, '不存在的 OpenSSL 配置.cnf') } };
  const restarted = await openMcp(path.join(root, 'owner.json'), options); processes.push(restarted);
  const invite = await restarted.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  assert.ok(invite.invitation.startsWith('sub2sub:'));
  const identityPath = path.join(root, 'owner/sharing/identity.json');
  const identity = await fs.readFile(identityPath, 'utf8');
  const paired = await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'owner', allowTaskFiles: true });
  assert.equal(paired.status, 'paired');
  await restarted.close();
  const reused = await openMcp(path.join(root, 'owner.json'), options); processes.push(reused);
  assert.ok((await reused.tool('create_pairing')).invitation.startsWith('sub2sub:'));
  assert.equal(await fs.readFile(identityPath, 'utf8'), identity);
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'available');
  assert.deepEqual((await fs.readdir(path.join(root, 'owner/sharing'))).filter(n => n.startsWith('identity-')), []);
});

test('certificate generation failure releases the listener and can be retried', async t => {
  const { root, owner, processes } = await setup(t);
  await owner.close();
  const sharing = new Sharing(new Config(path.join(root, 'owner.json')), path.join(root, 'owner'));
  processes.push(sharing);
  const generate = t.mock.method(selfsigned, 'generate', async () => { throw new Error('certificate test failure'); });
  await assert.rejects(sharing.manage('pair', { address: '127.0.0.1', port: 0 }), /bundled generator: certificate test failure/);
  assert.equal(sharing.status().status, 'stopped');
  assert.deepEqual(await fs.readdir(path.join(root, 'owner/sharing')), []);
  generate.mock.restore();
  assert.ok((await sharing.manage('pair', { address: '127.0.0.1', port: 0 })).invitation.startsWith('sub2sub:'));
});

test('caller and provider ordinary settings are separate and persist across plugin processes', async t => {
  const { root, caller, owner, processes } = await setup(t);
  assert.equal((await owner.tool('provider_settings')).allowedModels, 'all');
  assert.deepEqual((await caller.tool('caller_settings')).execution, { model: 'gpt-5.6-luna', reasoningEffort: 'max' });
  await caller.tool('caller_settings', { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  await owner.tool('provider_settings', { allowedModels: ['gpt-5.6-luna'] });
  const reopened = await openMcp(path.join(root, 'caller.json')); processes.push(reopened);
  assert.deepEqual((await reopened.tool('caller_settings')).execution, { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  assert.equal((await caller.tool('provider_settings')).allowedModels, 'all');
  assert.deepEqual((await owner.tool('provider_settings')).allowedModels, ['gpt-5.6-luna']);
});

test('caller choice executes, unsupported choices send no files, and old tasks keep their settings', async t => {
  const { owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  await caller.tool('caller_settings', { model: 'not-available', reasoningEffort: 'high' });
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution' }), /not-available.*available|not-available.*choose/i);
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
  await caller.tool('caller_settings', { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  const first = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution' });
  assert.deepEqual(JSON.parse(first.response), { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  await caller.tool('caller_settings', { model: 'gpt-5.6-luna', reasoningEffort: 'max' });
  const next = await caller.tool('continue_task', { taskId: first.taskId, prompt: 'report-execution' });
  assert.equal(next.threadId, first.threadId);
  assert.deepEqual(JSON.parse(next.response), { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  await owner.tool('provider_settings', { allowedModels: ['gpt-5.6-luna'] });
  await assert.rejects(caller.tool('continue_task', { taskId: first.taskId, prompt: 'report-execution' }), /choose|allowed/);
  const changed = await caller.tool('continue_task', { taskId: first.taskId, prompt: 'report-execution', model: 'gpt-5.6-luna', reasoningEffort: 'low' });
  assert.equal(changed.threadId, first.threadId);
  assert.deepEqual(JSON.parse(changed.response), { model: 'gpt-5.6-luna', reasoningEffort: 'low' });
});

test('all models follows the live catalog, invalid effort uploads nothing, and legacy restrictions survive', async t => {
  const { root, owner, caller, source } = await setup(t);
  await owner.tool('configure_model', { model: 'gpt-5.6-luna' });
  assert.deepEqual((await owner.tool('provider_settings')).allowedModels, ['gpt-5.6-luna']);
  await owner.tool('provider_settings', { allModels: true });
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution', reasoningEffort: 'ultra' }), /Choose from/);
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
  const catalog = path.join(root, 'owner/sharing/model-list.json');
  await fs.writeFile(catalog, JSON.stringify([{ model: 'new-model', displayName: 'New model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }]));
  assert.deepEqual((await caller.tool('list_models', { peer: 'owner' })).models.map(m => m.model), ['new-model']);
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution', model: 'new-model', reasoningEffort: 'high' });
  assert.deepEqual(JSON.parse(task.response), { model: 'new-model', reasoningEffort: 'high' });
  await fs.writeFile(catalog, JSON.stringify([{ model: 'new-model' }]));
  await assert.rejects(caller.tool('list_models', { peer: 'owner' }), /Invalid model capabilities/);
});

test('advanced limits apply to both endpoints and raised limits permit an actual larger round trip', { timeout: 90000 }, async t => {
  const { owner, caller, source } = await setup(t, { timeoutMs: 60000 });
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  await fs.writeFile(path.join(source, 'large.bin'), Buffer.alloc(21 * 1024 * 1024, 65));
  await caller.tool('caller_settings', { inputBytes: 24 * 1024 * 1024, resultBytes: 24 * 1024 * 1024 });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['large.bin'] });
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'large-result' }), /limit|exceeds/i);
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
  await owner.tool('provider_settings', { inputBytes: 24 * 1024 * 1024, resultBytes: 24 * 1024 * 1024 });
  assert.equal((await owner.tool('provider_settings')).allowedModels, 'all');
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'large-result' });
  await owner.tool('provider_settings', { resultBytes: 1024 });
  await caller.tool('caller_settings', { resultBytes: 1024 });
  const result = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal((await fs.stat(path.join(result.resultDirectory, 'files/large-output.bin'))).size, 21 * 1024 * 1024);
  assert.equal((await caller.tool('caller_settings')).advanced.resultBytes, 1024);
  await assert.rejects(caller.tool('caller_settings', { inputBytes: -1 }), /inputBytes/);
});

test('incremental collection maintains a complete independent copy including deletion and restored input', async t => {
  const { owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'sync-add' });
  const first = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(first.workCopyDirectory, 'input.txt'), 'utf8'), 'changed input');
  assert.equal(await fs.readFile(path.join(first.workCopyDirectory, 'temporary.txt'), 'utf8'), 'new file');
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).savedRevision, 1);
  await caller.tool('continue_task', { taskId: task.taskId, prompt: 'sync-restore' });
  const second = await caller.tool('collect_result', { taskId: task.taskId });
  assert.ok(second.changed.includes('input.txt'));
  assert.deepEqual(second.removed, ['temporary.txt']);
  assert.equal(await fs.readFile(path.join(second.workCopyDirectory, 'input.txt'), 'utf8'), '任务输入');
  await assert.rejects(fs.stat(path.join(second.workCopyDirectory, 'temporary.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(first.workCopyDirectory, 'temporary.txt'), 'utf8'), 'new file');
  assert.equal(await fs.readFile(path.join(source, 'input.txt'), 'utf8'), '任务输入');
  const unchanged = await caller.tool('collect_result', { taskId: task.taskId });
  assert.deepEqual(unchanged.changed, []);
  assert.deepEqual(unchanged.removed, []);
  assert.equal(unchanged.workCopyDirectory, second.workCopyDirectory);
  await fs.symlink(source, path.join(unchanged.workCopyDirectory, 'linked-source'));
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /link or special file/);
});

test('interrupted downloads and lost save confirmations retry without rerunning the task', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  let dropResult = true, dropAck = true;
  await interceptPeer(t, root, input => {
    if (input.action === 'result' && dropResult) { dropResult = false; return 'disconnect'; }
    if (input.action === 'ack' && dropAck) { dropAck = false; return 'disconnect'; }
  });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'sync-add' });
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /connection|response/i);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).savedRevision, 0);
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /Saved locally.*confirmation failed/);
  const result = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(result.workCopyDirectory, 'temporary.txt'), 'utf8'), 'new file');
  const status = await caller.tool('task_status', { taskId: task.taskId });
  assert.equal(status.revision, 1);
  assert.equal(status.savedRevision, 1);
  assert.equal(status.threadId, task.threadId);
  await caller.tool('continue_task', { taskId: task.taskId, prompt: 'report-execution' });
  dropAck = true;
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /confirmation failed/);
  const retried = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(retried.workCopyDirectory, result.workCopyDirectory);
  assert.equal(JSON.parse(await fs.readFile(retried.responseFile, 'utf8')).reasoningEffort, 'max');
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).savedRevision, 2);
});

test('task times and saved text results remain usable locally after release and disconnection', async t => {
  const { root, owner, caller, source, processes } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution' });
  const firstEntry = (await caller.tool('list_tasks')).tasks[0];
  assert.ok(Number.isFinite(Date.parse(firstEntry.createdAt)));
  assert.equal(firstEntry.endedAt, first.endedAt);
  assert.equal(firstEntry.deliveryPending, true);
  const saved = await caller.tool('collect_result', { taskId: first.taskId });
  assert.equal(JSON.parse(await fs.readFile(saved.responseFile, 'utf8')).reasoningEffort, 'max');
  assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'input.txt'), 'utf8'), '任务输入');
  const second = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution' });
  assert.deepEqual((await caller.tool('list_tasks')).tasks.map(t => t.taskId), [second.taskId, first.taskId]);
  const continued = await caller.tool('continue_task', { taskId: first.taskId, prompt: 'report-execution', reasoningEffort: 'low' });
  const pending = (await caller.tool('list_tasks')).tasks[0];
  assert.equal(pending.taskId, first.taskId);
  assert.equal(pending.endedAt, continued.endedAt);
  assert.equal(pending.createdAt, firstEntry.createdAt);
  assert.equal(pending.deliveryPending, true);
  assert.equal(pending.responseFile, saved.responseFile);
  const latest = await caller.tool('collect_result', { taskId: first.taskId });
  assert.equal(latest.workCopyDirectory, saved.workCopyDirectory);
  assert.equal(JSON.parse(await fs.readFile(latest.responseFile, 'utf8')).reasoningEffort, 'low');
  assert.equal(JSON.parse(await fs.readFile(saved.responseFile, 'utf8')).reasoningEffort, 'max');
  assert.equal((await caller.tool('task_status', { taskId: first.taskId })).savedRevision, 2);
  const shared = (await owner.tool('list_shared_tasks')).tasks;
  assert.deepEqual(shared.map(t => t.taskId), [first.taskId, second.taskId]);
  assert.ok(Number.isFinite(Date.parse(shared[0].createdAt)));
  assert.equal(shared[0].endedAt, continued.endedAt);
  await caller.tool('finish_task', { taskId: first.taskId, cleanup: 'workcopy' });
  await owner.close();
  const reopened = await openMcp(path.join(root, 'caller.json')); processes.push(reopened);
  const local = (await reopened.tool('list_tasks')).tasks[0];
  assert.equal(local.deliveryPending, false);
  assert.equal(local.cleanupStatus, 'released');
  assert.equal(local.savedRevision, 2);
  assert.ok(Number.isFinite(Date.parse(local.savedAt)));
  assert.equal(local.workCopyDirectory, latest.workCopyDirectory);
  assert.equal(local.responseFile, latest.responseFile);
  assert.equal(JSON.parse(await fs.readFile(local.responseFile, 'utf8')).reasoningEffort, 'low');
});

test('incremental updates refuse replaced local directories and out-of-scope deletion lists', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  let corrupt = false;
  await interceptPeer(t, root, (input, result) => { if (input.action === 'result' && corrupt) result.changes.removed = ['../outside.txt']; });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'sync-add' });
  const first = await caller.tool('collect_result', { taskId: task.taskId });
  await caller.tool('continue_task', { taskId: task.taskId, prompt: 'sync-restore' });
  const parent = path.dirname(first.workCopyDirectory), outside = path.join(root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'outside.txt'), 'untouched');
  await fs.rename(parent, parent + '-held'); await fs.symlink(outside, parent);
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /regular directory/);
  await fs.unlink(parent); await fs.rename(parent + '-held', parent);
  corrupt = true;
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /Invalid relative file path/);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).savedRevision, 1);
  assert.equal(await fs.readFile(path.join(outside, 'outside.txt'), 'utf8'), 'untouched');
  assert.deepEqual(await fs.readdir(outside), ['outside.txt']);
  corrupt = false;
  assert.ok((await caller.tool('collect_result', { taskId: task.taskId })).removed.includes('temporary.txt'));
});

test('older local records retain saved result access without invented times or freshness', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
  const saved = await caller.tool('collect_result', { taskId: task.taskId });
  const recordPath = path.join(root, 'caller/tasks', task.taskId + '.json');
  const old = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  for (const field of ['createdAt', 'endedAt', 'savedAt', 'deliveryPending', 'retentionDays', 'expiresAt']) delete old[field];
  await fs.writeFile(recordPath, JSON.stringify(old));
  const newer = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'second' });
  const tasks = (await caller.tool('list_tasks')).tasks;
  assert.deepEqual(tasks.map(t => t.taskId), [newer.taskId, task.taskId]);
  assert.equal(tasks[1].createdAt, undefined);
  assert.equal(tasks[1].endedAt, undefined);
  assert.equal(tasks[1].savedAt, undefined);
  assert.equal(tasks[1].deliveryPending, undefined);
  assert.equal(tasks[1].responseFile, saved.responseFile);
  assert.equal(await fs.readFile(tasks[1].responseFile, 'utf8'), '已完成：first');
  const kept = await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'keep' });
  assert.equal(kept.retentionDays, undefined);
  assert.equal(kept.expiresAt, undefined);
});

test('another local plugin reads actual sharing state and closing that reader preserves the owner', async t => {
  const { root, owner, caller, processes } = await setup(t);
  const active = await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  const observer = await openMcp(path.join(root, 'owner.json'));
  processes.push(observer);
  const status = await observer.tool('sharing_status');
  assert.equal(status.status, 'sharing');
  assert.notEqual(status.ownerPid, owner.child.pid);
  await observer.close();
  assert.equal((await owner.tool('sharing_status')).status, 'sharing');
  const second = await openMcp(path.join(root, 'owner.json')); processes.push(second);
  await second.tool('stop_sharing');
  assert.equal((await owner.tool('sharing_status')).status, 'stopped');
  const invitation = await second.tool('create_pairing');
  assert.equal((await owner.tool('sharing_status')).ownerPid, status.ownerPid);
  await caller.tool('pair_peer', { invitation: invitation.invitation, peer: 'owner', allowTaskFiles: true });
  assert.equal((await caller.tool('list_peers')).peers[0].status, 'available');
});

test('connections can be renamed and deleted after outstanding results are handled', async t => {
  const { owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
  await caller.tool('edit_peer', { peer: 'owner', name: '远程Mac' });
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).status, 'completed');
  await assert.rejects(caller.tool('delete_peer', { peer: '远程Mac' }), /uncollected|not saved/);
  await caller.tool('continue_task', { taskId: task.taskId, prompt: 'renamed continuation' });
  const result = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(result.workCopyDirectory, 'answer.txt'), 'utf8'), 'renamed continuation');
  const deleted = await caller.tool('delete_peer', { peer: '远程Mac' });
  assert.equal(deleted.status, 'deleted');
  assert.match(deleted.note, /same device again.*does not restore/);
  assert.deepEqual((await caller.tool('list_peers')).peers, []);
  assert.equal((await owner.tool('list_pairings')).pairings.length, 1);
  assert.equal((await owner.tool('list_shared_tasks')).tasks.length, 1);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: '远程Mac', allowTaskFiles: true });
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'old task' }), /does not restore continuation/);
  const local = (await caller.tool('list_tasks')).tasks[0];
  assert.equal(local.connectionPresent, false);
  assert.equal(local.responseFile, result.responseFile);
});

test('work copy cleanup requires saved results and restores the same native task with complete files', async t => {
  const { root, owner, caller, source } = await setup(t);
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'sync-add' });
  await assert.rejects(caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' }), /Collect|saved/);
  const local = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal((await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' })).status, 'released');
  const directory = path.join(root, 'owner/sharing/tasks', pair.pairId, task.taskId);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId, details: true })).inspection.workCopyExists, false);
  assert.equal(await fs.readFile(path.join(local.workCopyDirectory, 'temporary.txt'), 'utf8'), 'new file');
  await caller.tool('caller_settings', { inputBytes: 2 });
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'sync-restore' }), /limit|exceeds/i);
  await assert.rejects(fs.stat(path.join(directory, 'work')), { code: 'ENOENT' });
  await caller.tool('caller_settings', { inputBytes: 1024 });
  const resumed = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'sync-restore' });
  assert.equal(resumed.threadId, task.threadId);
  assert.equal(resumed.revision, 2);
  assert.equal((await caller.tool('collect_result', { taskId: task.taskId })).removed[0], 'temporary.txt');
});

for (const scenario of ['initial', 'follow-up', 'save failure']) test(`execution deadline saves partial delivery without rerunning: ${scenario}`, async t => {
  const { root, owner, caller, source } = await setup(t, { deadline: true });
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  let previous;
  if (scenario === 'follow-up') {
    previous = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first delivery' });
    await caller.tool('collect_result', { taskId: previous.taskId });
  }
  if (scenario === 'save failure') {
    let failOnce = true;
    await interceptPeer(t, root, input => {
      if (input.action === 'result' && failOnce) { failOnce = false; return 'disconnect'; }
    });
  }
  const running = previous
    ? caller.tool('continue_task', { taskId: previous.taskId, prompt: 'partial-wait' })
    : caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'partial-wait' });
  running.catch(() => {});
  let task;
  for (let attempts = 0; attempts < 100; attempts++) {
    [task] = (await caller.tool('list_tasks')).tasks;
    if (task) {
      try { await fs.stat(path.join(root, 'owner/sharing/tasks', pair.pairId, task.taskId, 'work/partial.txt')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await fs.writeFile(path.join(root, 'deadline'), 'expire');
  let saved;
  if (scenario === 'save failure') {
    await assert.rejects(running, /saving stage results failed.*Retry collect_result/);
    assert.equal((await caller.tool('list_tasks')).tasks[0].deliveryPending, true);
    saved = await caller.tool('collect_result', { taskId: task.taskId });
  } else saved = await running;
  assert.equal(saved.status, 'interrupted');
  assert.equal(saved.stopReason, 'time_limit');
  assert.equal(saved.deliveryPending, false);
  assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'partial.txt'), 'utf8'), 'Stage one is on disk; further work remains.');
  assert.match(await fs.readFile(saved.responseFile, 'utf8'), /30 minutes/);
  const stopped = await caller.tool('task_status', { taskId: task.taskId });
  assert.equal(stopped.executionActive, false);
  assert.equal(stopped.revision, previous ? 2 : 1);
  assert.equal(stopped.savedRevision, stopped.revision);
  if (previous) assert.equal(stopped.threadId, previous.threadId);
  await fs.unlink(path.join(root, 'deadline'));
  const resumed = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'complete the remaining work' });
  assert.equal(resumed.threadId, stopped.threadId);
  assert.equal(resumed.stopReason, undefined);
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.revision, stopped.revision + 1);
});

test('idle expiry catches up after restart and preserves unsaved tasks and existing retention choices', async t => {
  const { root, owner, caller, source, processes, clockFile, initialTime, ownerOptions } = await setup(t, { clock: true });
  assert.equal((await owner.tool('provider_settings')).advanced.retentionDays, 7);
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const saved = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'saved' });
  await fs.writeFile(path.join(root, 'owner/sharing/tasks', pair.pairId, saved.taskId, 'work/.sub2sub/cache'), 'disposable');
  await caller.tool('collect_result', { taskId: saved.taskId });
  await owner.tool('provider_settings', { retentionDays: 1 });
  const kept = await caller.tool('finish_task', { taskId: saved.taskId, cleanup: 'keep' });
  assert.equal(kept.retentionDays, 7);
  assert.equal(kept.expiresAt, saved.expiresAt);
  assert.match(kept.note, /not.*extend|unchanged/i);
  const pending = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'unsaved' });
  await owner.close();
  await fs.writeFile(clockFile, String(initialTime + 8 * 86400000));
  const reopened = await openMcp(path.join(root, 'owner.json'), ownerOptions); processes.push(reopened);
  const tasks = (await reopened.tool('list_shared_tasks')).tasks;
  assert.equal(tasks.find(t => t.taskId === saved.taskId).status, 'released');
  assert.equal(tasks.find(t => t.taskId === saved.taskId).inspection.workCopyExists, false);
  assert.equal(tasks.find(t => t.taskId === pending.taskId).inspection.workCopyExists, true);
  assert.match(tasks.find(t => t.taskId === pending.taskId).cleanup.reason, /saved|confirmation/);
  await reopened.tool('start_sharing');
  const resumed = await caller.tool('continue_task', { taskId: saved.taskId, prompt: 'resumed' });
  assert.equal(resumed.threadId, saved.threadId);
  assert.equal(resumed.retentionDays, 7);
  assert.equal(Date.parse(resumed.expiresAt), initialTime + 15 * 86400000);
  const before = resumed.expiresAt;
  await caller.tool('collect_result', { taskId: saved.taskId });
  assert.equal((await caller.tool('task_status', { taskId: saved.taskId })).expiresAt, before);
});

test('provider cleanup is limited to one stopped task and requires explicit abandonment of unsaved output', async t => {
  const { owner, caller, source } = await setup(t);
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
  const other = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'other' });
  await assert.rejects(owner.tool('cleanup_shared_task', { pairId: pair.pairId, taskId: first.taskId, cleanup: 'workcopy' }), /not.*saved|discardUncollected/);
  await owner.tool('cleanup_shared_task', { pairId: pair.pairId, taskId: first.taskId, cleanup: 'workcopy', discardUncollected: true });
  assert.equal((await caller.tool('task_status', { taskId: first.taskId })).inspection.workCopyExists, false);
  assert.equal((await caller.tool('task_status', { taskId: other.taskId })).inspection.workCopyExists, true);
  assert.equal((await owner.tool('list_pairings')).pairings.length, 1);
});

test('incompatible capabilities stop upload and restoration cannot select arbitrary native ownership', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  let incompatible = true;
  await interceptPeer(t, root, (input, result) => { if (input.action === 'models' && incompatible) delete result.protocol; });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' }), /Upgrade both/);
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
  incompatible = false;
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
  await caller.tool('collect_result', { taskId: task.taskId });
  await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' });
  const config = JSON.parse(await fs.readFile(path.join(root, 'caller.json'), 'utf8'));
  await assert.rejects(connect(config.peers.owner, { action: 'restore', protocol: 2, taskId: task.taskId, threadId: 'another-thread', workspace: '/another/task', prompt: 'test' }), /Unknown provider request field/);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).inspection.workCopyExists, false);
});

test('Codex cannot silently substitute a different model after capability selection', async t => {
  const { root, owner, caller, source } = await setup(t);
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  await fs.writeFile(path.join(root, 'owner/sharing/model-list.json'), JSON.stringify([{ model: 'fixture-reroute', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }]));
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first', model: 'fixture-reroute', reasoningEffort: 'high' }), /selected.*instead of/);
  const task = (await caller.tool('list_tasks')).tasks[0];
  await assert.rejects(fs.stat(path.join(root, 'owner/sharing/tasks', pair.pairId, task.taskId, 'work/answer.txt')), { code: 'ENOENT' });
});

test('paired MCP peers delegate and resume over encrypted LAN, collect and clean up', { timeout: 30000 }, async t => {
  const { owner, caller, source } = await setup(t);
  const sharing = await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  assert.equal(sharing.status, 'sharing');
  const invite = await owner.tool('create_pairing');
  const paired = await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'owner', allowTaskFiles: true });
  assert.equal(paired.transport, 'lan');
  const check = await caller.tool('check_peer', { peer: 'owner' });
  assert.equal(check.status, 'available');
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: '第一轮' });
  const second = await caller.tool('continue_task', { taskId: first.taskId, prompt: '第二轮' });
  assert.equal(second.threadId, first.threadId);
  const result = await caller.tool('collect_result', { taskId: first.taskId });
  assert.equal(await fs.readFile(path.join(result.resultDirectory, 'files/answer.txt'), 'utf8'), '第二轮');
  assert.equal((await caller.tool('finish_task', { cleanup: 'records', taskId: first.taskId })).status, 'records_deleted');
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
});

test('cleanup requires an explicit choice; keep can resume and records removes the provider task', async t => {
  const { root, owner, caller, source } = await setup(t);
  const invite = await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  const paired = await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'cleanup input' });
  const collected = await caller.tool('collect_result', { taskId: first.taskId });
  await assert.rejects(caller.tool('finish_task', { taskId: first.taskId }), /cleanup/);
  await assert.rejects(caller.tool('finish_task', { taskId: first.taskId, cleanup: 'typo' }), /cleanup/);
  assert.equal((await caller.tool('finish_task', { taskId: first.taskId, cleanup: 'keep' })).status, 'retained');
  const next = await caller.tool('continue_task', { taskId: first.taskId, prompt: 'keep and continue' });
  assert.equal(next.threadId, first.threadId);
  await assert.rejects(caller.tool('finish_task', { taskId: first.taskId, cleanup: 'records' }), /latest result/);
  await caller.tool('collect_result', { taskId: first.taskId });
  assert.equal((await caller.tool('finish_task', { taskId: first.taskId, cleanup: 'records' })).status, 'records_deleted');
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
  await assert.rejects(fs.stat(path.join(root, 'owner/sharing/tasks', paired.pairId, first.taskId)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(source, 'input.txt'), 'utf8'), '任务输入');
  assert.equal(await fs.readFile(path.join(collected.resultDirectory, 'files/answer.txt'), 'utf8'), 'cleanup input');
  assert.equal((await caller.tool('finish_task', { taskId: first.taskId, cleanup: 'records' })).status, 'records_deleted');
  await assert.rejects(caller.tool('continue_task', { taskId: first.taskId, prompt: 'too late' }), /cleaned|finished/);
});

test('all cleanup removes native root and descendants after records cleanup, preserving other tasks', async t => {
  const { root, owner, caller, source } = await setup(t);
  const paired = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'cleanup-child' });
  const other = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'unrelated' });
  const history = path.join(root, 'owner/sharing/tasks', paired.pairId, '.fake-codex');
  await caller.tool('collect_result', { taskId: task.taskId });
  await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'records' });
  assert.ok(await fs.stat(path.join(history, task.threadId + '.json')));
  const native = JSON.parse(await fs.readFile(path.join(history, task.threadId + '.json'), 'utf8'));
  await fs.writeFile(path.join(history, 'independent.json'), JSON.stringify({ ...native, id: 'independent', threadSource: null }));
  await fs.writeFile(path.join(history, 'manual-fork.json'), JSON.stringify({ ...native, id: 'manual-fork', forkedFromId: task.threadId }));
  const localTask = JSON.parse(await fs.readFile(path.join(root, 'caller/tasks', task.taskId + '.json'), 'utf8'));
  await fs.rename(localTask.resultDirectory, localTask.resultDirectory + '-moved');
  const cleared = await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' });
  assert.equal(cleared.status, 'all_deleted');
  await assert.rejects(fs.stat(path.join(history, task.threadId + '.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(history, 'child-' + task.threadId + '.json')), { code: 'ENOENT' });
  assert.ok(await fs.stat(path.join(history, other.threadId + '.json')));
  assert.ok(await fs.stat(path.join(history, 'independent.json')));
  assert.ok(await fs.stat(path.join(history, 'manual-fork.json')));
  assert.equal((await caller.tool('task_status', { taskId: other.taskId })).status, 'completed');
  assert.equal((await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' })).status, 'all_deleted');
});

test('provider can disconnect and purge a caller, including history from already cleared tasks', async t => {
  const { root, owner, caller, source, device } = await setup(t);
  await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  const paired = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const second = await device('second');
  const otherPair = await second.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const old = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'cleanup-archived' });
  await caller.tool('collect_result', { taskId: old.taskId });
  await caller.tool('finish_task', { taskId: old.taskId, cleanup: 'records' });
  await assert.rejects(owner.tool('cleanup_shared_tasks', { pairId: paired.pairId, cleanup: 'all' }), /Disconnect/);
  const otherCopy = await second.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const other = await second.tool('start_task', { peer: 'owner', snapshotId: otherCopy.snapshotId, prompt: 'other caller' });
  const outcome = caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'hang' }).catch(error => error);
  for (let i = 0; i < 100 && !(await owner.tool('sharing_status')).activeTask; i++) await new Promise(r => setTimeout(r, 20));
  const disconnected = await owner.tool('revoke_pairing', { pairId: paired.pairId, cleanup: 'all' });
  assert.equal(disconnected.status, 'revoked');
  assert.equal(disconnected.cleanup.status, 'all_deleted');
  assert.ok(await outcome instanceof Error);
  await assert.rejects(caller.tool('check_peer', { peer: 'owner' }), /revoked|not paired/);
  const shared = (await owner.tool('list_shared_tasks')).tasks;
  assert.ok(shared.every(t => t.pairId === otherPair.pairId));
  assert.equal(shared[0].taskId, other.taskId);
  const nativeRoot = path.join(root, 'owner/sharing/tasks', paired.pairId, '.fake-codex');
  assert.deepEqual(await fs.readdir(nativeRoot), []);
  assert.equal((await owner.tool('cleanup_shared_tasks', { pairId: paired.pairId, cleanup: 'all' })).status, 'all_deleted');
});

test('failed native deletion is explicit and retryable, and archived history is cleared', async t => {
  const { root, owner, caller, source } = await setup(t);
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'cleanup-delete-failure' });
  await caller.tool('collect_result', { taskId: task.taskId });
  await assert.rejects(caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' }), /native deletion failed/);
  assert.ok(await fs.stat(path.join(root, 'owner/sharing/tasks', pair.pairId, task.taskId, 'work/input.txt')));
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).status, 'finishing');
  assert.equal((await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' })).status, 'all_deleted');
  const archived = await caller.tool('start_task', { peer: 'owner', snapshotId: (await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] })).snapshotId, prompt: 'cleanup-archived' });
  await caller.tool('collect_result', { taskId: archived.taskId });
  assert.equal((await caller.tool('finish_task', { taskId: archived.taskId, cleanup: 'all' })).status, 'all_deleted');
  await assert.rejects(fs.stat(path.join(root, 'owner/sharing/tasks', pair.pairId, '.fake-codex', archived.threadId + '.json')), { code: 'ENOENT' });
});

test('first-use invitation starts sharing directly and pairing returns connection details', async t => {
  const { owner, caller } = await setup(t);
  const invite = await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  assert.ok(invite.invitation.startsWith('sub2sub:'));
  assert.equal((await owner.tool('sharing_status')).status, 'sharing');
  const paired = await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'owner', allowTaskFiles: true });
  assert.equal(paired.status, 'paired');
  assert.equal(paired.provider, 'owner');
});

test('legacy provider model setting restricts new turns without silently replacing task choices', async t => {
  const { owner, caller, source } = await setup(t);
  const invite = await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  assert.equal(invite.model, 'gpt-5.6-luna');
  assert.equal(invite.reasoningEffort, 'max');
  const paired = await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'owner', allowTaskFiles: true });
  assert.equal(paired.model, 'gpt-5.6-luna');
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'report-execution' });
  assert.equal(first.model, 'gpt-5.6-luna');
  assert.equal(first.reasoningEffort, 'max');
  assert.deepEqual(JSON.parse(first.response), { model: 'gpt-5.6-luna', reasoningEffort: 'max' });
  await owner.tool('configure_model', { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  await assert.rejects(caller.tool('continue_task', { taskId: first.taskId, prompt: 'report-execution' }), /Choose from/);
  const next = await caller.tool('continue_task', { taskId: first.taskId, prompt: 'report-execution', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  assert.equal(next.threadId, first.threadId);
  assert.equal(next.model, 'gpt-5.6-sol');
  assert.equal(next.reasoningEffort, 'high');
  assert.deepEqual(JSON.parse(next.response), { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  assert.equal((await caller.tool('task_status', { taskId: first.taskId })).reasoningEffort, 'high');
  const collected = await caller.tool('collect_result', { taskId: first.taskId });
  assert.equal(collected.model, 'gpt-5.6-sol');
  assert.equal(collected.reasoningEffort, 'high');
  assert.equal(JSON.parse(await fs.readFile(path.join(collected.resultDirectory, 'changes.json'), 'utf8')).model, 'gpt-5.6-sol');
  await owner.tool('configure_model', { model: 'gpt-5.6-luna', reasoningEffort: 'low' });
  await assert.rejects(caller.tool('continue_task', { taskId: first.taskId, prompt: 'failure', model: 'gpt-5.6-luna', reasoningEffort: 'low' }), /failed/);
  const failed = await caller.tool('task_status', { taskId: first.taskId });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.model, 'gpt-5.6-luna');
  assert.equal(failed.reasoningEffort, 'low');
  await assert.rejects(owner.tool('configure_model', { reasoningEffort: 'typo' }), /reasoningEffort/);
});

test('task-file consent is explicit, survives reconnect, appears with a preview and can be withdrawn', async t => {
  const { root, owner, caller, source, processes } = await setup(t);
  const invite = await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  const paired = await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'owner' });
  assert.equal(paired.transferAuthorization.scope, 'none');
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'], peer: 'owner' });
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'not yet authorized' }), /authorize_peer/);
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
  await caller.tool('authorize_peer', { peer: 'owner', allowTaskFiles: true });
  await caller.close();
  const restarted = await openMcp(path.join(root, 'caller.json')); processes.push(restarted);
  const preview = await restarted.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'], peer: 'owner' });
  assert.equal(preview.transferAuthorization.scope, 'task-files');
  assert.equal(preview.destination.peer, 'owner');
  const first = await restarted.tool('start_task', { peer: 'owner', snapshotId: preview.snapshotId, prompt: 'authorized task' });
  await restarted.tool('authorize_peer', { peer: 'owner', allowTaskFiles: false });
  await assert.rejects(restarted.tool('continue_task', { taskId: first.taskId, prompt: 'no longer authorized' }), /authorize_peer/);
  assert.equal((await restarted.tool('collect_result', { taskId: first.taskId })).status, 'completed');
  assert.equal((await restarted.tool('finish_task', { cleanup: 'records', taskId: first.taskId })).status, 'records_deleted');
});

test('pairing checks provider identity before sending secrets and invitations are single-use', { timeout: 30000 }, async t => {
  const { owner, caller, device } = await setup(t);
  await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  const first = await owner.tool('create_pairing');
  const latest = await owner.tool('create_pairing');
  await assert.rejects(caller.tool('pair_peer', { invitation: first.invitation, peer: 'owner' }), /expired or already used/);
  const changed = JSON.parse(Buffer.from(latest.invitation.slice(8), 'base64url').toString());
  changed.fingerprint = '0'.repeat(64);
  const wrong = 'sub2sub:' + Buffer.from(JSON.stringify(changed)).toString('base64url');
  await assert.rejects(caller.tool('pair_peer', { invitation: wrong, peer: 'owner' }), /certificate does not match/);
  const paired = await caller.tool('pair_peer', { invitation: latest.invitation, peer: 'owner', allowTaskFiles: true });
  const stranger = await device('stranger');
  await assert.rejects(stranger.tool('pair_peer', { invitation: latest.invitation, peer: 'owner' }), /expired or already used/);
  const list = await owner.tool('list_pairings');
  assert.equal(list.pairings.length, 1);
  assert.equal(list.pairings[0].pairId, paired.pairId);
  assert.equal(list.pairings[0].name, 'caller');
  assert.ok(!JSON.stringify(list).includes('token'));
});

test('callers cannot access another pairing tasks or choose execution paths', { timeout: 30000 }, async t => {
  const { root, owner, caller, source, device } = await setup(t);
  await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const stranger = await device('stranger');
  await stranger.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'private result' });
  // A caller controls its own configuration and can send arbitrary wire requests.
  const connection = JSON.parse(await fs.readFile(path.join(root, 'stranger.json'), 'utf8')).peers.owner;
  await assert.rejects(connect(connection, { action: 'result', taskId: task.taskId }), /ENOENT/);
  await assert.rejects(connect(connection, { action: 'run', taskId: task.taskId, prompt: 'escape', root: '/tmp/escape' }), /Unknown provider request field/);
  await assert.rejects(connect({ ...connection, token: 'x'.repeat(43) }, { action: 'check' }), /not paired|revoked/);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).status, 'completed');
});

test('new pinned certificates tolerate small clock skew but not expiry or large skew', { timeout: 30000 }, async t => {
  const { root, owner, caller } = await setup(t);
  await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const peer = JSON.parse(await fs.readFile(path.join(root, 'caller.json'), 'utf8')).peers.owner;
  const identity = JSON.parse(await fs.readFile(path.join(root, 'owner/sharing/identity.json'), 'utf8'));
  const cert = new X509Certificate(identity.cert);
  const clock = t.mock.method(Date, 'now', () => Date.parse(cert.validFrom) - 1000);
  assert.equal((await connect(peer, { action: 'check' })).status, 'available');
  clock.mock.mockImplementation(() => Date.parse(cert.validFrom) - 6 * 60 * 1000);
  await assert.rejects(connect(peer, { action: 'check' }), /not currently valid/);
  clock.mock.mockImplementation(() => Date.parse(cert.validTo) + 1000);
  await assert.rejects(connect(peer, { action: 'check' }), /not currently valid/);
  clock.mock.restore();
});

test('node admits four independent tasks and applies a lower live limit without cancelling work', { timeout: 30000 }, async t => {
  const { owner, caller, source, root } = await setup(t);
  assert.equal((await owner.tool('provider_settings')).maxConcurrent, 4);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const failures = [];
  const running = Array.from({ length: 4 }, () => caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'partial-wait' }).catch(error => { failures.push(error.message); return error; }));
  let status;
  for (let i = 0; i < 200; i++) {
    status = await owner.tool('sharing_status');
    if (status.activeTasks.length === 4) {
      const ready = await Promise.all(status.activeTasks.map(task => fs.stat(path.join(root, 'owner/sharing/tasks', task.pairId, task.taskId, 'work/partial.txt')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })));
      if (ready.every(Boolean)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status.occupiedSlots, 4, failures.join("\n"));
  for (const task of status.activeTasks) assert.equal(await fs.readFile(path.join(root, 'owner/sharing/tasks', task.pairId, task.taskId, 'work/partial.txt'), 'utf8'), 'Stage one is on disk; further work remains.');
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'busy');
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'overflow' }), /busy|capacity/i);
  const peer = JSON.parse(await fs.readFile(path.join(root, 'caller.json'), 'utf8')).peers.owner;
  await assert.rejects(connect(peer, { action: 'run', protocol: 2, taskId: status.activeTasks[0].taskId, model: 'gpt-5.6-luna', reasoningEffort: 'max', prompt: 'duplicate' }), /already.*running|active turn/i);
  const pid = status.ownerPid;
  await owner.tool('provider_settings', { maxConcurrent: 2 });
  assert.equal((await owner.tool('sharing_status')).occupiedSlots, 4);
  assert.equal((await owner.tool('sharing_status')).ownerPid, pid);
  await assert.rejects(owner.tool('provider_settings', { harness: 'claude' }), /finish|cancel/i);
  await assert.rejects(owner.tool('exit_sharing'), /active/i);
  for (const task of status.activeTasks.slice(0, 2)) await owner.tool('cancel_shared_task', task);
  for (let i = 0; i < 100 && (await owner.tool('sharing_status')).occupiedSlots !== 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'busy');
  await owner.tool('cancel_shared_task', status.activeTasks[2]);
  for (let i = 0; i < 100 && (await owner.tool('sharing_status')).occupiedSlots !== 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'available');
  const extra = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'after capacity released' });
  assert.equal(extra.status, 'completed');
  await owner.tool('stop_sharing');
  assert.equal((await owner.tool('sharing_status')).occupiedSlots, 1);
  await owner.tool('cancel_shared_task', status.activeTasks[3]);
  await Promise.all(running);
  assert.equal((await owner.tool('sharing_status')).occupiedSlots, 0);
  assert.equal((await caller.tool('collect_result', { taskId: status.activeTasks[3].taskId })).status, 'interrupted');
});

test('simultaneous provider settings preserve each explicit change', async t => {
  const { owner } = await setup(t);
  await Promise.all([owner.tool('provider_settings', { maxConcurrent: 2 }), owner.tool('provider_settings', { allModels: true })]);
  const settings = await owner.tool('provider_settings');
  assert.equal(settings.maxConcurrent, 2);
  assert.equal(settings.allowedModels, 'all');
});

test('revoking a caller interrupts all its turns while another caller keeps executing', { timeout: 30000 }, async t => {
  const { owner, caller, source, root, device } = await setup(t);
  const other = await device('other');
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  await other.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const otherCopy = await other.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const runs = [caller, caller, other].map((client, i) => client.tool('start_task', { peer: 'owner', snapshotId: i === 2 ? otherCopy.snapshotId : copy.snapshotId, prompt: 'partial-wait' }).catch(error => error));
  let active;
  for (let i = 0; i < 200; i++) {
    active = (await owner.tool('sharing_status')).activeTasks;
    if (active.length === 3) {
      const files = await Promise.all(active.map(task => fs.stat(path.join(root, 'owner/sharing/tasks', task.pairId, task.taskId, 'work/partial.txt')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })));
      if (files.every(Boolean)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(active.length, 3);
  await owner.tool('revoke_pairing', { pairId: pair.pairId });
  assert.ok(await runs[0] instanceof Error);
  assert.ok(await runs[1] instanceof Error);
  const remaining = (await owner.tool('sharing_status')).activeTasks;
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].pairId, pair.pairId);
  assert.equal((await other.tool('task_status', { taskId: remaining[0].taskId })).executionActive, true);
  await owner.tool('cancel_shared_task', remaining[0]);
  await runs[2];
  const saved = await other.tool('collect_result', { taskId: remaining[0].taskId });
  assert.equal(await fs.readFile(path.join(saved.resultDirectory, 'files/partial.txt'), 'utf8'), 'Stage one is on disk; further work remains.');
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(owner.tool('provider_settings', { maxConcurrent: invalid }), /integer|minimum|maximum/i);
  assert.equal((await owner.tool('provider_settings')).maxConcurrent, 4);
});

test('provider busy state and revocation stop unauthorized ongoing use', { timeout: 30000 }, async t => {
  const { owner, caller, source } = await setup(t);
  await owner.tool('provider_settings', { maxConcurrent: 1 });
  await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  const paired = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const running = caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'hang' });
  const outcome = running.then(value => ({ value }), error => ({ error }));
  let active;
  for (let i = 0; i < 100; i++) {
    active = (await owner.tool('sharing_status')).activeTask;
    if (active) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(active);
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'busy');
  assert.match((await caller.tool('list_peers')).nextStep, /busy.*wait/i);
  await assert.rejects(caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'second job' }), /busy/);
  await owner.tool('revoke_pairing', { pairId: paired.pairId });
  assert.ok((await outcome).error, 'revocation must close the existing caller stream');
  await assert.rejects(caller.tool('check_peer', { peer: 'owner' }), /not paired|revoked/);
});

test('pairing survives provider restart and stopping sharing preserves result delivery', { timeout: 30000 }, async t => {
  const { root, owner, caller, source, processes } = await setup(t);
  await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'before restart' });
  await owner.tool('exit_sharing');
  await owner.close();
  await assert.rejects(caller.tool('check_peer', { peer: 'owner' }), /connection failed/);
  assert.match((await caller.tool('list_peers')).nextStep, /check the network/i);
  const restarted = await openMcp(path.join(root, 'owner.json')); processes.push(restarted);
  assert.equal((await restarted.tool('sharing_status')).status, 'stopped');
  await restarted.tool('start_sharing');
  const second = await caller.tool('continue_task', { taskId: first.taskId, prompt: 'after restart' });
  assert.equal(second.threadId, first.threadId);
  await restarted.tool('stop_sharing');
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'stopped');
  assert.match((await caller.tool('list_peers')).nextStep, /start sharing/i);
  await assert.rejects(caller.tool('continue_task', { taskId: first.taskId, prompt: 'must not start' }), /Sharing is stopped/);
  const result = await caller.tool('collect_result', { taskId: first.taskId });
  assert.equal(await fs.readFile(path.join(result.resultDirectory, 'files/answer.txt'), 'utf8'), 'after restart');
  assert.equal((await caller.tool('finish_task', { cleanup: 'records', taskId: first.taskId })).status, 'records_deleted');
});

test('caller disconnection keeps the same provider task recoverable and cancellable', { timeout: 30000 }, async t => {
  const { root, owner, caller, source, processes } = await setup(t);
  await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing')).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const outcome = caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'hang' }).catch(error => error);
  let active;
  for (let i = 0; i < 100; i++) {
    active = (await owner.tool('sharing_status')).activeTask;
    if (active) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(active);
  await caller.close(); await outcome;
  const resumed = await openMcp(path.join(root, 'caller.json')); processes.push(resumed);
  assert.equal((await resumed.tool('list_tasks')).tasks.length, 1);
  let state;
  for (let i = 0; i < 100; i++) {
    state = await resumed.tool('task_status', { taskId: active.taskId });
    if (state.progress?.includes('Waiting')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state.status, 'running');
  assert.match(state.progress, /Waiting/);
  await resumed.tool('cancel_task', { taskId: active.taskId });
  for (let i = 0; i < 100; i++) {
    state = await resumed.tool('task_status', { taskId: active.taskId });
    if (state.status !== 'running' && !state.executionActive) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state.status, 'interrupted');
  assert.equal(state.executionActive, false);
  await resumed.tool('collect_result', { taskId: active.taskId });
  await resumed.tool('finish_task', { cleanup: 'keep', taskId: active.taskId });
});

test('status keeps its running ownership snapshot when cancellation finishes during work-copy inspection', { timeout: 30000 }, async t => {
  const { root, owner, caller, source, processes } = await setup(t);
  await owner.close();
  const sharing = new Sharing(new Config(path.join(root, 'owner.json')), path.join(root, 'owner'));
  processes.push(sharing);
  const paired = await caller.tool('pair_peer', { invitation: (await sharing.manage('pair', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const outcome = caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'hang' }).then(value => ({ value }), error => ({ error }));
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    const active = sharing.status().activeTask;
    if (active) {
      state = await caller.tool('task_status', { taskId: active.taskId });
      if (state.progress?.includes('Waiting')) break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state.status, 'running');
  assert.match(state.progress, /Waiting/);
  const work = await fs.realpath(path.join(root, 'owner/sharing/tasks', paired.pairId, state.taskId, 'work'));
  const originalLstat = fs.lstat.bind(fs);
  let entered, release, blocked = false;
  const inspecting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'lstat', async (...args) => {
    if (!blocked && args[0] === work) {
      blocked = true;
      entered();
      await gate;
    }
    return originalLstat(...args);
  });
  const checking = caller.tool('task_status', { taskId: state.taskId });
  let timer;
  try {
    await Promise.race([inspecting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Status did not reach work-copy inspection.')), 5000); })]);
    await caller.tool('cancel_task', { taskId: state.taskId });
    assert.equal((await outcome).value.status, 'interrupted');
  } finally { clearTimeout(timer); release(); }
  const snapshot = await checking;
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.executionActive, true);
  const settled = await caller.tool('task_status', { taskId: state.taskId });
  assert.equal(settled.status, 'interrupted');
  assert.equal(settled.executionActive, false);
  const recordPath = path.join(work, '..', 'state.json');
  const record = await fs.readFile(recordPath, 'utf8');
  await fs.writeFile(recordPath, JSON.stringify({ ...JSON.parse(record), status: 'running' }));
  try {
    const orphan = await caller.tool('task_status', { taskId: state.taskId });
    assert.equal(orphan.status, 'unknown');
    assert.equal(orphan.executionActive, false);
  } finally { await fs.writeFile(recordPath, record); }
});

test('malformed configuration reports its error and becomes usable after repair', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-setup-test-'));
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, '{broken');
  const client = await openMcp(file);
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(client.tool('list_peers'), /Cannot read sub2sub configuration/);
  await fs.writeFile(file, JSON.stringify({ peers: {} }));
  assert.deepEqual((await client.tool('list_peers')).peers, []);
});

test('later sharing controls win while an earlier request discovers the listener', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-start-order-'));
  const store = new Config(path.join(root, 'config.json'));
  await store.update(config => { config.provider = { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) }; });
  const sharing = new Sharing(store, root);
  t.after(async () => { await sharing.close(); await fs.rm(root, { recursive: true, force: true }); });
  for (const [first, last] of [['start', 'stop'], ['pair', 'stop'], ['stop', 'start']]) {
    let releaseLookup;
    const lookup = new Promise(resolve => { releaseLookup = resolve; });
    let calls = 0;
    const mock = t.mock.method(sharing, 'runtime', () => ++calls === 1 ? lookup : Promise.resolve(null));
    const earlier = sharing.manage(first, { address: '127.0.0.1', port: 0 });
    try { await sharing.manage(last, { address: '127.0.0.1', port: 0 }); }
    finally { releaseLookup(null); }
    if (first === 'pair') await assert.rejects(earlier, /superseded/);
    else await earlier;
    assert.equal(sharing.status().status, last === 'start' ? 'sharing' : 'stopped');
    mock.mock.restore();
  }
  assert.ok((await sharing.manage('pair')).invitation.startsWith('sub2sub:'));
});

test('a second plugin does not forward sharing controls superseded during discovery', async t => {
  const { root, owner } = await setup(t);
  await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  const observer = new Sharing(new Config(path.join(root, 'owner.json')), path.join(root, 'owner'));
  const runtime = await observer.runtime();
  for (const [first, last] of [['start', 'stop'], ['stop', 'start']]) {
    let releaseLookup;
    const lookup = new Promise(resolve => { releaseLookup = resolve; });
    let calls = 0;
    const mock = t.mock.method(observer, 'runtime', () => ++calls === 1 ? lookup : Promise.resolve(runtime));
    const earlier = observer.manage(first);
    try { await observer.manage(last); }
    finally { releaseLookup(runtime); }
    await earlier;
    assert.equal((await owner.tool('sharing_status')).status, last === 'start' ? 'sharing' : 'stopped');
    mock.mock.restore();
  }
});

test('stopping sharing during startup remains stopped when initialization completes', async t => {
  const { owner } = await setup(t);
  const starting = owner.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  assert.equal((await owner.tool('stop_sharing')).status, 'stopped');
  await starting;
  assert.equal((await owner.tool('sharing_status')).status, 'stopped');
  const invitation = await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 });
  assert.ok(invitation.invitation.startsWith('sub2sub:'), 'An explicit new invitation request enables sharing again.');
});

test('configuration updates recover a lock left by a stopped process', async t => {
  const { root, owner } = await setup(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise(resolve => child.once('close', resolve));
  const lock = path.join(root, 'owner.json.lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid }));
  assert.equal((await owner.tool('start_sharing', { address: '127.0.0.1', port: 0 })).status, 'sharing');
});


test('save confirmation can be retried after the provider releases the work copy', async t => {
  const { root, owner, caller, source } = await setup(t);
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  let drop = true;
  await interceptPeer(t, root, input => { if (input.action === 'ack' && drop) { drop = false; return 'disconnect'; } });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'sync-add' });
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /confirmation failed/);
  await owner.tool('cleanup_shared_task', { pairId: pair.pairId, taskId: task.taskId, cleanup: 'workcopy' });
  const restored = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'sync-restore' });
  assert.equal(restored.threadId, task.threadId);
  assert.equal(restored.revision, 2);
});

test('missing necessary local files prevent save confirmation and caller cleanup', async t => {
  const { owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
  const first = await caller.tool('collect_result', { taskId: task.taskId });
  await fs.unlink(path.join(first.workCopyDirectory, 'input.txt'));
  await assert.rejects(caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' }), /ENOENT|incomplete/);
  await caller.tool('continue_task', { taskId: task.taskId, prompt: 'second' });
  await assert.rejects(caller.tool('collect_result', { taskId: task.taskId }), /ENOENT|incomplete/);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).savedRevision, 1);
  await fs.writeFile(path.join(first.workCopyDirectory, 'input.txt'), '任务输入');
  assert.equal(await fs.readFile(path.join((await caller.tool('collect_result', { taskId: task.taskId })).workCopyDirectory, 'input.txt'), 'utf8'), '任务输入');
});

test('a second provider process revokes and stops the active task', async t => {
  const { root, owner, caller, source, processes } = await setup(t);
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const observer = await openMcp(path.join(root, 'owner.json')); processes.push(observer);
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  let ended = false;
  const running = caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'hang' }).catch(error => error).finally(() => { ended = true; });
  let active;
  for (let n = 0; n < 100; n++) { active = (await observer.tool('sharing_status')).activeTask; if (active) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(active);
  await observer.tool('revoke_pairing', { pairId: pair.pairId, cleanup: 'keep' });
  try {
    assert.equal((await observer.tool('sharing_status')).activeTask, null);
    await running;
    assert.ok(ended);
  } finally { if (!ended) { await observer.tool('cancel_shared_task', { pairId: pair.pairId, taskId: active.taskId }); await running; } }
});

test('connection deletion rechecks tasks registered before its config update', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const store = new Config(path.join(root, 'caller.json'));
  const client = new Client(await store.read(), path.join(root, 'caller'), store);
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const update = store.update.bind(store);
  store.update = async fn => {
    await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
    return update(fn);
  };
  await assert.rejects(client.editConnection('delete_peer', { peer: 'owner' }), /uncollected|not saved/);
  assert.ok((await store.read()).peers.owner);
});

test('renaming a legacy connection preserves concurrent collection fields', async t => {
  const { root, owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
  const target = path.join(root, 'caller/tasks', task.taskId + '.json');
  const old = JSON.parse(await fs.readFile(target)); delete old.peerId; await fs.writeFile(target, JSON.stringify(old));
  const store = new Config(path.join(root, 'caller.json'));
  const client = new Client(await store.read(), path.join(root, 'caller'), store);
  const update = store.update.bind(store);
  store.update = async fn => { await caller.tool('collect_result', { taskId: task.taskId }); return update(fn); };
  await client.editConnection('edit_peer', { peer: 'owner', name: 'renamed' });
  const saved = JSON.parse(await fs.readFile(target));
  assert.equal(saved.savedRevision, 1);
  assert.ok(saved.workCopyRoot);
  assert.equal(await fs.readFile(path.join(saved.workCopyRoot, 'files/input.txt'), 'utf8'), '任务输入');
});


test('small incremental build outputs can accumulate beyond the restoration input limit', async t => {
  const { owner, caller, source } = await setup(t);
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  await caller.tool('caller_settings', { inputBytes: 1024, resultBytes: 1024 });
  await owner.tool('provider_settings', { inputBytes: 1024, resultBytes: 1024 });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'accum-1' });
  await caller.tool('collect_result', { taskId: task.taskId });
  await caller.tool('continue_task', { taskId: task.taskId, prompt: 'accum-2' });
  const second = await caller.tool('collect_result', { taskId: task.taskId });
  assert.ok(second.changed.includes('dist/accum-2.txt'));
  assert.ok(!second.changed.includes('dist/accum-1.txt'));
  await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' });
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'check-accumulated' }), /limit|exceeds/i);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).inspection.workCopyExists, false);
  await caller.tool('caller_settings', { inputBytes: 4096 });
  await owner.tool('provider_settings', { inputBytes: 4096 });
  const restored = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'check-accumulated' });
  assert.equal(restored.status, 'completed');
  assert.equal(restored.threadId, task.threadId);
});

test('expiry leaves an active turn intact and cancellation starts a fresh retention period', async t => {
  const { owner, caller, source, clockFile, initialTime } = await setup(t, { clock: true });
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'first' });
  await caller.tool('collect_result', { taskId: task.taskId });
  await fs.writeFile(clockFile, String(initialTime + 6 * 86400000));
  assert.equal((await owner.tool('list_shared_tasks')).tasks[0].inspection.workCopyExists, true);
  const running = caller.tool('continue_task', { taskId: task.taskId, prompt: 'hang' }).catch(error => error);
  for (let n = 0; n < 100; n++) { const current = await caller.tool('task_status', { taskId: task.taskId }); if (current.status === 'running' && current.revision === 2) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  try {
    await fs.writeFile(clockFile, String(initialTime + 8 * 86400000));
    const current = (await owner.tool('list_shared_tasks')).tasks[0];
    assert.equal(current.status, 'running');
    assert.equal(current.inspection.workCopyExists, true);
    assert.match(current.cleanup.reason, /running/);
  } finally { await owner.tool('cancel_shared_task', { pairId: pair.pairId, taskId: task.taskId }); await running; }
  assert.equal(Date.parse((await caller.tool('task_status', { taskId: task.taskId })).expiresAt), initialTime + 15 * 86400000);
});

test('task listing reports a missing record without hiding malformed records', async t => {
  const { root, owner, caller } = await setup(t);
  const paired = await caller.tool('pair_peer', { peer: 'owner', invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation });
  const id = '00000000-0000-4000-8000-000000000001';
  const directory = path.join(root, 'owner/sharing/tasks', paired.pairId, id);
  // Materialization exposes its directory before the first state write.
  await fs.mkdir(directory, { recursive: true });
  const pending = (await owner.tool('list_shared_tasks')).tasks[0];
  assert.equal(pending.taskId, id); assert.equal(pending.status, 'unknown');
  assert.equal(pending.harness, undefined); assert.match(pending.error, /not available|initializ/i);
  await fs.writeFile(path.join(directory, 'state.json'), '{broken');
  await assert.rejects(owner.tool('list_shared_tasks'), /JSON|property|position/i);
  await fs.writeFile(path.join(directory, 'state.json'), 'null');
  await assert.rejects(owner.tool('list_shared_tasks'), /null/i);
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ taskId: id, status: 'ready' }));
  const ready = (await owner.tool('list_shared_tasks')).tasks[0];
  assert.equal(ready.status, 'ready'); assert.equal(ready.harness, 'codex');
});
