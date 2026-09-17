import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { openMcp } from './helpers/mcp.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';
import { connect } from '../lib/client.mjs';
import { readRequest, writeMessage, releaseReceived, STREAM_TYPE } from '../lib/transfer.mjs';

async function setup(t, names = ['first', 'second']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-host-selection-'));
  const devices = [], servers = [], hosts = {};
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.all(devices.map(device => device.close()));
    for (const name of [...names, 'client']) await stopTestSharing(path.join(root, name));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of [...names, 'client']) {
    const file = path.join(root, `${name}.json`);
    await fs.writeFile(file, JSON.stringify({ stateRoot: path.join(root, name), deviceName: name, peers: {}, provider: { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } }));
    const device = await openMcp(file); devices.push(device); hosts[name] = device;
  }
  const client = hosts.client;
  const requests = Object.fromEntries(names.map(name => [name, []]));
  const intercepts = {};
  for (const name of names) {
    const invitation = (await hosts[name].tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation;
    await client.tool('pair_peer', { invitation, peer: name, allowTaskFiles: true });
    const file = path.join(root, 'client.json'), config = JSON.parse(await fs.readFile(file, 'utf8'));
    const peer = config.peers[name];
    const identity = JSON.parse(await fs.readFile(path.join(root, name, 'sharing/identity.json'), 'utf8'));
    const server = https.createServer(identity, async (req, res) => {
      let received, result;
      try {
        received = await readRequest(req);
        const input = received.value;
        requests[name].push({ action: input.action, taskId: input.taskId });
        const intercept = await intercepts[name]?.(input);
        if (intercept?.error) throw new Error(intercept.error);
        result = intercept?.result ?? await connect(peer, input);
        if (intercept?.disconnect) { res.destroy(); return; }
        if (received.streaming) { res.setHeader('content-type', STREAM_TYPE); await writeMessage(res, { result }); res.end(); }
        else res.end(JSON.stringify({ result }) + '\n');
      } catch (error) { res.end(JSON.stringify({ error: error.message }) + '\n'); }
      finally { await releaseReceived(received?.value); await releaseReceived(result); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    config.peers[name] = { ...peer, port: server.address().port };
    await fs.writeFile(file, JSON.stringify(config));
  }
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'input.txt'), 'task input');
  const copy = await client.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  return { root, client, hosts, source, copy, requests, intercepts };
}

test('opt-in host selection uses the first eligible candidate and explicit peer wins', async t => {
  const { client, hosts, copy } = await setup(t);
  const initial = await client.tool('caller_settings');
  assert.equal(initial.autoSelectHost, false);
  assert.deepEqual(initial.candidateHosts, []);
  await assert.rejects(client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'manual required' }), /specify.*host|choose.*host/i);
  const settings = await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['second', 'first'] });
  assert.deepEqual(settings.candidateHosts, ['second', 'first']);
  const selected = await client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'write automatic result' });
  assert.equal(selected.peer, 'second');
  assert.equal((await hosts.first.tool('list_shared_tasks')).tasks.length, 0);
  assert.equal((await hosts.second.tool('list_shared_tasks')).tasks.length, 1);
  const manual = await client.tool('start_task', { peer: 'first', snapshotId: copy.snapshotId, prompt: 'write explicit result' });
  assert.equal(manual.peer, 'first');
  assert.equal((await hosts.first.tool('list_shared_tasks')).tasks.length, 1);
});

test('selection skips unauthorized, unavailable and incompatible hosts without sending task content', async t => {
  const { client, hosts, copy, requests, intercepts } = await setup(t);
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['first', 'second'] });
  const available = await client.tool('check_peer', { peer: 'first' });
  const models = await client.tool('list_models', { peer: 'first' });
  await client.tool('authorize_peer', { peer: 'first', allowTaskFiles: false });
  requests.first.length = 0;
  assert.equal((await client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'ordinary task' })).peer, 'second');
  assert.deepEqual(requests.first, []);
  await client.tool('authorize_peer', { peer: 'first', allowTaskFiles: true });
  const cases = [
    { action: 'check', result: { ...available, status: 'busy' }, reason: /busy/ },
    { action: 'check', result: { ...available, status: 'stopped' }, reason: /stopped/ },
    { action: 'check', result: { ...available, status: 'expired' }, reason: /expired/ },
    { action: 'check', error: 'fixture connection unavailable', reason: /fixture connection unavailable/ },
    { action: 'check', result: { ...available, harness: 'claude' }, reason: /tool.*match/i },
    { action: 'models', result: { ...models, models: [{ model: 'different-model', reasoningEfforts: ['max'] }] }, reason: /not available or allowed/ },
    { action: 'models', result: { ...models, models: [{ model: 'gpt-5.6-luna', reasoningEfforts: ['low'] }] }, reason: /not available or allowed/ },
    { action: 'models', result: { ...models, limits: { ...models.limits, inputBytes: 2 } }, reason: /2 bytes limit/ },
    { action: 'models', result: { ...models, connection: { ...models.connection, budget: { limit: 100, usedTokens: 100, remainingTokens: 0, status: 'exhausted', incomplete: false, pendingRounds: 0 } } }, reason: /budget.*exhausted/i }
  ];
  for (const example of cases) {
    intercepts.first = input => input.action === example.action ? example : undefined;
    const task = await client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'ordinary task' });
    assert.equal(task.peer, 'second');
    assert.match(task.selection.skipped[0].reason, example.reason);
  }
  assert.equal(requests.first.filter(request => request.action === 'run').length, 0);
  assert.equal((await hosts.first.tool('list_shared_tasks')).tasks.length, 0);
});

test('candidate previews show consent and connection edits preserve the ordered selection settings', async t => {
  const { client, source, requests } = await setup(t);
  await client.tool('authorize_peer', { peer: 'second', allowTaskFiles: false });
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['second', 'first'] });
  const copy = await client.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  assert.deepEqual(copy.destinations.map(item => [item.peer, item.transferAuthorization.scope]), [['second', 'none'], ['first', 'task-files']]);
  assert.ok(copy.transferScope);
  const explicit = await client.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'], peer: 'first' });
  assert.equal(explicit.destination.peer, 'first');
  assert.equal(explicit.destinations, undefined);
  assert.ok(Object.values(requests).every(items => !items.some(item => item.action === 'run')));
  await client.tool('edit_peer', { peer: 'first', name: 'renamed' });
  assert.deepEqual((await client.tool('caller_settings')).candidateHosts, ['second', 'renamed']);
  await client.tool('delete_peer', { peer: 'second' });
  assert.deepEqual((await client.tool('caller_settings')).candidateHosts, ['renamed']);
  for (const candidateHosts of [['missing'], ['renamed', 'renamed'], ['']]) await assert.rejects(client.tool('caller_settings', { candidateHosts }));
  assert.deepEqual((await client.tool('caller_settings')).candidateHosts, ['renamed']);
  await client.tool('caller_settings', { autoSelectHost: false });
  await assert.rejects(client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'disabled' }), /Specify a host/);
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: [] });
  await assert.rejects(client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'empty candidates' }), /Specify a host/);
});

test('a race after selection refuses once without sending to the next host', async t => {
  const { client, hosts, copy, requests, intercepts } = await setup(t);
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['first', 'second'] });
  const models = await client.tool('list_models', { peer: 'first' });
  intercepts.first = async input => {
    if (input.action === 'models') { await hosts.first.tool('stop_sharing'); return { result: models }; }
  };
  await assert.rejects(client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'admission race' }), error => {
    assert.match(error.message, /Task [\w-]+:.*Sharing is stopped/);
    assert.match(error.message, /Selected host: first.*No automatic host retry/);
    return true;
  });
  assert.equal(requests.first.filter(request => request.action === 'run').length, 1);
  assert.equal(requests.second.filter(request => request.action === 'run').length, 0);
  const task = (await client.tool('list_tasks')).tasks[0];
  assert.equal(task.peer, 'first');
  assert.equal(task.taskId, requests.first.find(request => request.action === 'run').taskId);
});

test('another client taking the last slot after preflight cannot trigger a second host submission', async t => {
  const { client, hosts, source, copy, requests, intercepts } = await setup(t);
  await hosts.first.tool('provider_settings', { maxConcurrent: 1 });
  await hosts.second.tool('pair_peer', { peer: 'racer', allowTaskFiles: true, invitation: (await hosts.first.tool('create_pairing')).invitation });
  const racingCopy = await hosts.second.tool('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['first', 'second'] });
  const models = await client.tool('list_models', { peer: 'first' });
  let racing, racingId;
  intercepts.first = async input => {
    if (input.action !== 'models') return;
    racing = hosts.second.tool('start_task', { peer: 'racer', snapshotId: racingCopy.snapshotId, prompt: 'hang' }).catch(error => error);
    for (let attempt = 0; attempt < 100; attempt++) {
      const tasks = (await hosts.first.tool('list_shared_tasks')).tasks;
      racingId = tasks.find(task => task.status === 'running')?.taskId;
      if (racingId) return { result: models };
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Fixture did not occupy the final slot.');
  };
  try {
    await assert.rejects(client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'loses admission race' }), /busy.*capacity.*Selected host: first/s);
    assert.equal(requests.first.filter(request => request.action === 'run').length, 1);
    assert.equal(requests.second.filter(request => request.action === 'run').length, 0);
  } finally {
    if (racingId) await hosts.second.tool('cancel_task', { taskId: racingId });
    if (racing) await racing;
  }
});

test('lost execution response keeps the selected host and all subsequent operations on its original task', async t => {
  const { client, hosts, copy, requests, intercepts } = await setup(t);
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['first', 'second'] });
  intercepts.first = input => input.action === 'run' ? { disconnect: true } : undefined;
  await assert.rejects(client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'reply lost' }), /LAN connection failed.*Selected host: first/s);
  const task = (await client.tool('list_tasks')).tasks[0];
  assert.equal(task.peer, 'first');
  assert.equal(requests.first.filter(request => request.action === 'run').length, 1);
  assert.equal(requests.second.filter(request => request.action === 'run').length, 0);
  assert.equal((await hosts.first.tool('list_shared_tasks')).tasks.length, 1);
  intercepts.first = undefined;
  await client.tool('caller_settings', { candidateHosts: ['second'] });
  assert.equal((await client.tool('task_status', { taskId: task.taskId })).status, 'completed');
  const saved = await client.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'answer.txt'), 'utf8'), 'reply lost');
  await client.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' });
  await client.tool('continue_task', { taskId: task.taskId, prompt: 'continue original task after restore' });
  await client.tool('cancel_task', { taskId: task.taskId });
  assert.ok(requests.first.some(request => request.action === 'restore' && request.taskId === task.taskId));
  assert.ok(requests.first.some(request => request.action === 'cancel' && request.taskId === task.taskId));
  assert.equal(requests.second.length, 0);
});

test('no eligible host explains every skipped candidate, and explicit tool or model choices never fall back', async t => {
  const { client, hosts, copy, requests } = await setup(t);
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['first', 'second'] });
  await client.tool('authorize_peer', { peer: 'first', allowTaskFiles: false });
  await hosts.second.tool('stop_sharing');
  await assert.rejects(client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'no target' }), error => {
    assert.match(error.message, /没有符合要求的共享端.*No eligible host/);
    assert.match(error.message, /first:.*not authorized/);
    assert.match(error.message, /second:.*stopped/);
    return true;
  });
  await client.tool('authorize_peer', { peer: 'first', allowTaskFiles: true });
  await assert.rejects(client.tool('start_task', { peer: 'first', harness: 'claude', snapshotId: copy.snapshotId, prompt: 'explicit tool' }), /requested claude/);
  await assert.rejects(client.tool('start_task', { peer: 'first', model: 'unavailable-model', snapshotId: copy.snapshotId, prompt: 'explicit model' }), /not available or allowed/);
  assert.equal((await client.tool('list_tasks')).tasks.length, 0);
  assert.equal(Object.values(requests).flat().filter(request => request.action === 'run').length, 0);
});

test('management and MCP share ordered selection settings without exposing task execution', async t => {
  const { client } = await setup(t);
  const url = new URL((await client.tool('web_management')).url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const app = await (await fetch(`${url.origin}/app.js`)).text();
  assert.match(app, /自动选择共享端/);
  assert.match(app, /Automatic host selection/);
  const response = await fetch(`${url.origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'caller_settings', input: { autoSelectHost: true, candidateHosts: ['second', 'first'] } }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).candidateHosts, ['second', 'first']);
  assert.equal((await client.tool('caller_settings')).autoSelectHost, true);
  assert.deepEqual((await client.tool('onboarding')).settings.caller.candidateHosts, ['second', 'first']);
  const forbidden = await fetch(`${url.origin}/api/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'start_task', input: {} }) });
  assert.equal(forbidden.status, 400);
});

test('automatic selection respects current retention consent and budget while expiry preserves consumption', async t => {
  const { root, client, hosts, copy, requests } = await setup(t);
  await client.tool('caller_settings', { autoSelectHost: true, candidateHosts: ['first', 'second'] });
  const policy = { cleanupAllOnExpiry: true, retentionDays: 1 };
  await hosts.first.tool('provider_settings', policy);
  const config = JSON.parse(await fs.readFile(path.join(root, 'client.json'), 'utf8'));
  const pairId = config.peers.first.pairId;
  await hosts.first.tool('pairing_settings', { pairId, tokenLimit: 180 });
  const start = () => client.tool('start_task', { snapshotId: copy.snapshotId, prompt: 'usage-complete' });
  const fallback = await start();
  assert.equal(fallback.peer, 'second');
  assert.match(fallback.selection.skipped[0].reason, /retention consent/i);
  assert.equal(requests.first.filter(request => request.action === 'run').length, 0);

  await client.tool('authorize_peer', { peer: 'first', allowTaskFiles: true, retentionPolicy: policy });
  const selected = await start();
  assert.equal(selected.peer, 'first');
  assert.equal(selected.cleanupAllOnExpiry, true);
  assert.equal((await hosts.first.tool('pairing_settings', { pairId })).budget.usedTokens, 180);
  assert.equal((await start()).peer, 'second');
  assert.equal(requests.first.filter(request => request.action === 'run').length, 1);

  await hosts.first.tool('exit_sharing');
  const stateFile = path.join(root, 'first/sharing/tasks', pairId, selected.taskId, 'state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.expiresAt = new Date(Date.now() - 1).toISOString();
  await fs.writeFile(stateFile, JSON.stringify(state));
  await hosts.first.tool('start_sharing');
  const expired = (await hosts.first.tool('list_shared_tasks')).tasks.find(task => task.taskId === selected.taskId);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.cleanup.nativeHistory, 'deleted');
  const budget = (await hosts.first.tool('pairing_settings', { pairId })).budget;
  assert.equal(budget.usedTokens, 180);
  assert.equal(budget.status, 'exhausted');
});
