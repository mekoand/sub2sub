import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openMcp } from './helpers/mcp.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';

async function setup(t, harness = 'codex', { deadline = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-budget-'));
  const ownerFile = path.join(root, 'owner.json');
  await fs.writeFile(ownerFile, JSON.stringify({ stateRoot: path.join(root, 'owner'), provider: { harness, [`${harness}Path`]: fileURLToPath(new URL(`./fixtures/fake-${harness}.mjs`, import.meta.url)) } }));
  const callerFile = path.join(root, 'caller.json');
  await fs.writeFile(callerFile, JSON.stringify({ stateRoot: path.join(root, 'caller') }));
  const deadlineFile = path.join(root, 'deadline');
  const owner = await openMcp(ownerFile, { env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), ...(deadline ? { SUB2SUB_TEST_DEADLINE: deadlineFile } : {}) }, ...(deadline ? { args: ['--import', fileURLToPath(new URL('./fixtures/deadline.mjs', import.meta.url)), fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))] } : {}) }), caller = await openMcp(callerFile);
  t.after(async () => { await Promise.all([owner.close(), caller.close()]); await stopTestSharing(path.join(root, 'owner')); await fs.rm(root, { recursive: true, force: true }); });
  await caller.tool('onboarding', { action: 'confirm' });
  if (harness === 'claude') {
    await caller.tool('caller_settings', { harness, model: 'sonnet', reasoningEffort: 'low' });
  }
  const pair = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'brief.txt'), 'Synthetic budget task');
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['brief.txt'] });
  const budget = async () => (await owner.tool('pairing_settings', { pairId: pair.pairId })).budget;
  const start = (prompt = 'usage-complete') => caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt });
  return { root, owner, caller, pairId: pair.pairId, budget, start, deadlineFile };
}

test('connection budget counts completed turns once, blocks follow-ups, and survives deletion, disabling and restart', async t => {
  const { owner, caller, pairId, budget, start } = await setup(t);
  const before = await start();
  await caller.tool('collect_result', { taskId: before.taskId });
  await owner.tool('pairing_settings', { pairId, tokenLimit: 300 });
  assert.equal((await budget()).usedTokens, 0, 'do not backfill pre-budget history');
  await caller.tool('continue_task', { taskId: before.taskId, prompt: 'usage-resume' });
  assert.equal((await budget()).usedTokens, 180);
  await caller.tool('collect_result', { taskId: before.taskId });
  await caller.tool('collect_result', { taskId: before.taskId });
  const second = await start();
  assert.deepEqual(await budget(), { limit: 300, usedTokens: 360, remainingTokens: 0, status: 'exhausted', incomplete: false, pendingRounds: 0 });
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'budget_exhausted');
  await assert.rejects(caller.tool('continue_task', { taskId: before.taskId, prompt: 'usage-resume' }), /budget.*exhausted/i);
  await assert.rejects(start(), /budget.*exhausted/i);
  await caller.tool('collect_result', { taskId: second.taskId });
  await caller.tool('finish_task', { taskId: second.taskId, cleanup: 'all' });
  await owner.tool('pairing_settings', { pairId, tokenLimit: null });
  assert.equal((await budget()).usedTokens, 360);
  await owner.tool('pairing_settings', { pairId, tokenLimit: 400 });
  await owner.tool('exit_sharing');
  await owner.tool('start_sharing');
  assert.equal((await budget()).usedTokens, 360);
  assert.equal((await budget()).remainingTokens, 40);
  await caller.tool('finish_task', { taskId: before.taskId, cleanup: 'workcopy' });
  await caller.tool('continue_task', { taskId: before.taskId, prompt: 'usage-resume' });
  assert.equal((await budget()).usedTokens, 540, 'restoring a work copy only charges the new round');
});

test('missing final usage pauses only new work and explicit gap acceptance keeps known consumption', async t => {
  const { owner, caller, pairId, budget, start } = await setup(t);
  await owner.tool('pairing_settings', { pairId, tokenLimit: 1000 });
  const task = await start('usage-missing');
  assert.deepEqual(await budget(), { limit: 1000, usedTokens: 150, remainingTokens: 850, status: 'paused', incomplete: true, pendingRounds: 0 });
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'budget_paused');
  await assert.rejects(start(), /budget.*paused/i);
  await caller.tool('collect_result', { taskId: task.taskId });
  await owner.tool('pairing_settings', { pairId, tokenLimit: null });
  await owner.tool('pairing_settings', { pairId, tokenLimit: 1000 });
  assert.equal((await budget()).status, 'paused');
  await owner.tool('pairing_settings', { pairId, acceptUsageGap: true });
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'usage-failure' }), /fixture usage failure/);
  assert.equal((await budget()).usedTokens, 330);
  assert.equal((await budget()).status, 'available');
  assert.equal((await budget()).incomplete, true);
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'usage-disconnect' }), /exited/);
  assert.equal((await budget()).usedTokens, 510);
  assert.equal((await budget()).status, 'paused');
});

test('concurrent in-flight rounds settle after cancellation even when a lowered limit is exceeded', async t => {
  const { owner, caller, pairId, budget, start } = await setup(t);
  await owner.tool('pairing_settings', { pairId, tokenLimit: 200 });
  const running = [start('usage-wait'), start('usage-wait')];
  let tasks;
  for (let attempt = 0; attempt < 100; attempt++) {
    tasks = (await owner.tool('list_shared_tasks')).tasks;
    if (tasks.length === 2 && tasks.every(task => task.rounds?.[0]?.usage?.tokens?.totalTokens === 180)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(tasks.length, 2);
  assert.equal((await budget()).status, 'available', 'running partial measurements do not pause the connection');
  await owner.tool('pairing_settings', { pairId, tokenLimit: 1 });
  assert.equal((await owner.tool('sharing_status')).occupiedSlots, 2);
  await Promise.all(tasks.map(task => caller.tool('cancel_task', { taskId: task.taskId })));
  await Promise.all(running);
  assert.deepEqual(await budget(), { limit: 1, usedTokens: 360, remainingTokens: 0, status: 'exhausted', incomplete: false, pendingRounds: 0 });
});

test('budgeted Codex execution disables native child work outside the main-thread meter', async t => {
  const { owner, pairId, budget, start } = await setup(t);
  await owner.tool('pairing_settings', { pairId, tokenLimit: 500 });
  const task = await start('usage-budget-restricted');
  assert.equal(task.status, 'completed');
  assert.equal((await budget()).usedTokens, 180);
});

test('Claude budgets add input, cache reads, cache writes and output across native models without double counting thinking', { skip: process.platform !== 'darwin' }, async t => {
  const { owner, caller, pairId, budget, start } = await setup(t, 'claude');
  await owner.tool('pairing_settings', { pairId, tokenLimit: 200 });
  const task = await start('claude-usage-complete');
  assert.equal((await budget()).usedTokens, 129);
  await caller.tool('collect_result', { taskId: task.taskId });
  await caller.tool('continue_task', { taskId: task.taskId, prompt: 'claude-usage-missing-fields' });
  assert.equal((await budget()).usedTokens, 251);
  assert.equal((await budget()).status, 'paused');
});

test('management API uses the same budget schema and Client cannot alter Host rules', async t => {
  const { owner, caller, pairId, budget } = await setup(t);
  const url = new URL((await owner.tool('web_management')).url);
  const edit = input => fetch(`${url.origin}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify({ name: 'pairing_settings', input: { pairId, ...input } }) });
  for (const tokenLimit of [0, -1, 1.5, '500', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await edit({ tokenLimit })).status, 400);
  const response = await edit({ tokenLimit: 500 });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).budget, await budget());
  const overview = await (await fetch(`${url.origin}/api/overview?role=provider`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` } })).json();
  assert.deepEqual(overview.peers[0].budget, await budget());
  assert.deepEqual((await caller.tool('check_peer', { peer: 'owner' })).connection.budget, await budget());
  await assert.rejects(caller.tool('pairing_settings', { pairId, tokenLimit: 99999 }), /Unknown|revoked/);
});

test('a Host crash recovers observed consumption once and keeps an incomplete pause across subsequent restarts', async t => {
  const { root, owner, caller, pairId, budget, start } = await setup(t);
  await owner.tool('pairing_settings', { pairId, tokenLimit: 500 });
  const running = start('usage-wait').then(value => ({ value }), error => ({ error }));
  let task;
  for (let attempt = 0; attempt < 100; attempt++) {
    task = (await owner.tool('list_shared_tasks')).tasks[0];
    if (task?.rounds?.[0]?.usage?.tokens?.totalTokens === 180) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(task?.rounds?.[0]?.usage?.tokens?.totalTokens, 180);
  const nodePid = (await owner.tool('sharing_status')).ownerPid;
  const native = JSON.parse(await fs.readFile(path.join(root, 'owner/sharing/tasks', pairId, task.taskId, 'process.json')));
  // These PIDs come only from the test's temporary node and synthetic harness.
  process.kill(nodePid, 'SIGKILL');
  try { process.kill(native.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  assert.ok((await running).error);
  await owner.tool('start_sharing');
  assert.deepEqual(await budget(), { limit: 500, usedTokens: 180, remainingTokens: 320, status: 'paused', incomplete: true, pendingRounds: 0 });
  assert.equal((await caller.tool('task_status', { taskId: task.taskId })).status, 'unknown');
  await owner.tool('exit_sharing');
  await owner.tool('start_sharing');
  assert.equal((await budget()).usedTokens, 180);
  await assert.rejects(start(), /budget.*paused/i);
});

test('the execution deadline settles observed usage without refunding timed-out work', async t => {
  const { owner, caller, pairId, budget, start, deadlineFile } = await setup(t, 'codex', { deadline: true });
  await owner.tool('pairing_settings', { pairId, tokenLimit: 1000 });
  const running = start('usage-wait');
  let task;
  for (let attempt = 0; attempt < 100; attempt++) {
    task = (await owner.tool('list_shared_tasks')).tasks[0];
    if (task?.rounds?.[0]?.usage?.tokens?.totalTokens === 180) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(task?.rounds?.[0]?.usage?.tokens?.totalTokens, 180);
  await fs.writeFile(deadlineFile, 'stop');
  const stopped = await running;
  assert.equal(stopped.stopReason, 'time_limit');
  assert.equal((await budget()).usedTokens, 180);
  assert.equal((await budget()).status, 'paused');
  await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal((await budget()).usedTokens, 180);
});

test('failed accounting is recovered before deleting the only remaining task usage record', async t => {
  const { root, owner, caller, pairId, budget, start } = await setup(t);
  await owner.tool('pairing_settings', { pairId, tokenLimit: 500 });
  const running = start('usage-wait').then(value => ({ value }), error => ({ error }));
  let task;
  for (let attempt = 0; attempt < 100; attempt++) {
    task = (await owner.tool('list_shared_tasks')).tasks[0];
    if (task?.rounds?.[0]?.usage?.tokens?.totalTokens === 180) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(task?.rounds?.[0]?.usage?.tokens?.totalTokens, 180);
  // Hold the test config's filesystem lock to make the final accounting write
  // fail at the storage boundary, without mocking the budget implementation.
  const lock = path.join(root, 'owner.json.lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, `${randomUUID()}.json`), JSON.stringify({ pid: process.pid }));
  try {
    await caller.tool('cancel_task', { taskId: task.taskId });
    assert.match((await running).error.message, /Another sub2sub process/);
  } finally { await fs.rm(lock, { recursive: true, force: true }); }
  await caller.tool('collect_result', { taskId: task.taskId });
  await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' });
  assert.equal((await budget()).usedTokens, 180);
  assert.equal((await budget()).pendingRounds, 0);
  await owner.tool('start_sharing');
  assert.equal((await budget()).usedTokens, 180);
});
