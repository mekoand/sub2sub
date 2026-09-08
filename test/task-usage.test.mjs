import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../lib/client.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-task-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'brief.txt'), 'Synthetic usage task');
  const config = { peers: { demo: { transport: 'local', taskRoot: path.join(root, 'provider'), codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } } };
  const client = new Client(config, path.join(root, 'caller'));
  t.after(() => client.close());
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['brief.txt'] });
  return { root, client, prepared };
}

test('submitted Codex task delivers native per-round cumulative usage once, without adding reasoning tokens', async t => {
  const {client, prepared} = await setup(t);
  const task = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'usage-complete' });
  assert.deepEqual(task.rounds[0].usage?.tokens, { totalTokens: 180, inputTokens: 150, cachedInputTokens: 35, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 8 });
  assert.equal(task.rounds[0].usage.actualModel, 'gpt-5.6-luna');
  assert.equal(task.rounds[0].usage.status, 'observed');
  const saved = await client.call('collect_result', {taskId: task.taskId});
  assert.deepEqual(saved.rounds[0].usage, task.rounds[0].usage);
});


test('resumed and failed task rounds synchronize once and remain grouped by actual model after work-copy cleanup', async t => {
  const {client, prepared} = await setup(t);
  const task = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'usage-complete' });
  await client.call('collect_result', {taskId: task.taskId});
  await client.call('continue_task', {taskId: task.taskId, prompt: 'usage-resume', model: 'gpt-5.6-sol', reasoningEffort: 'low'});
  await client.call('collect_result', {taskId: task.taskId});
  await assert.rejects(client.call('continue_task', {taskId: task.taskId, prompt: 'usage-failure'}), /fixture usage failure/);
  await client.call('collect_result', {taskId: task.taskId});
  await client.call('collect_result', {taskId: task.taskId});
  const summary = await client.call('resource_statistics', {});
  assert.equal(summary.usageDetails?.length, 3);
  assert.deepEqual(summary.usageDetails.map(row => row.tokens.totalTokens), [180, 180, 180]);
  assert.deepEqual(summary.usageDetails.map(row => row.actualModel), ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-sol']);
  assert.deepEqual(summary.usageGroups.map(row => [row.actualModel, row.tokens.totalTokens, row.tokens.outputTokens]), [['gpt-5.6-luna', 180, 30], ['gpt-5.6-sol', 360, 60]]);
  assert.equal(summary.usageDetails[2].status, 'failed');
  await client.call('finish_task', {taskId: task.taskId, cleanup: 'workcopy'});
  assert.deepEqual((await client.call('resource_statistics', {})).usageGroups, summary.usageGroups);
  await client.call('finish_task', {taskId: task.taskId, cleanup: 'records'});
  assert.deepEqual((await client.call('resource_statistics', {})).usageDetails, []);
});


test('disconnect preserves observed usage and missing source fields stay unknown in the public summary', async t => {
  const {client, prepared} = await setup(t);
  const task = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'usage-complete' });
  await client.call('collect_result', {taskId: task.taskId});
  await assert.rejects(client.call('continue_task', {taskId: task.taskId, prompt: 'usage-disconnect'}), /exited/);
  await client.call('collect_result', {taskId: task.taskId});
  await client.call('continue_task', {taskId: task.taskId, prompt: 'No usage emitted by an older version'});
  await client.call('collect_result', {taskId: task.taskId});
  const summary = await client.call('resource_statistics', {});
  assert.equal(summary.usageDetails[1].usageStatus, 'incomplete');
  assert.equal(summary.usageDetails[1].tokens.totalTokens, 180);
  assert.equal(summary.usageDetails[2].usageStatus, 'unavailable');
  assert.equal(summary.usageDetails[2].tokens.totalTokens, null);
  assert.equal(summary.usageGroups[0].tokens.totalTokens, 360);
  assert.equal(summary.usageGroups[0].knownFields.totalTokens, 2);
});

test('native rerouting and decreasing counters cannot be presented as complete usage for the requested model', async t => {
  const {client, prepared} = await setup(t);
  const task = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'usage-reroute' });
  assert.equal(task.rounds[0].usage.actualModel, null);
  assert.equal(task.rounds[0].usage.requestedModel, 'gpt-5.6-luna');
  assert.deepEqual(task.rounds[0].usage.observedModels, ['gpt-5.6-luna', 'gpt-5.6-sol']);
  assert.equal(task.rounds[0].usage.status, 'incomplete');
  await client.call('collect_result', {taskId: task.taskId});
  const resumed = await client.call('continue_task', {taskId: task.taskId, prompt: 'usage-decrease'});
  assert.equal(resumed.rounds[1].usage.status, 'incomplete');
  assert.equal(resumed.rounds[1].usage.tokens.totalTokens, 180);
});


test('cancelled execution retains the same observed native usage without extra model calls on query or recollection', async t => {
  const {client, prepared, root} = await setup(t);
  const task = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'usage-complete' });
  await client.call('collect_result', {taskId: task.taskId});
  const continuing = client.call('continue_task', {taskId: task.taskId, prompt: 'usage-wait'});
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await client.call('task_status', {taskId: task.taskId});
    if (status.rounds?.[1]?.usage?.tokens.totalTokens === 180) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.rounds?.[1]?.usage?.tokens.totalTokens, 180);
  await client.call('cancel_task', {taskId: task.taskId});
  const cancelled = await continuing;
  assert.equal(cancelled.status, 'interrupted');
  assert.equal(cancelled.rounds[1].usage.tokens.totalTokens, 180);
  const callsPath = path.join(root, 'provider', task.taskId, 'calls.jsonl');
  const calls = await fs.readFile(callsPath, 'utf8');
  await client.call('collect_result', {taskId: task.taskId});
  await client.call('collect_result', {taskId: task.taskId});
  await client.call('resource_statistics', {});
  assert.equal(await fs.readFile(callsPath, 'utf8'), calls);
  assert.equal(calls.trim().split('\n').map(line => JSON.parse(line)).filter(call => call.method === 'turn/start').length, 2);
});


test('production deadline preserves observed usage in the automatically collected stage result', async t => {
  const {client, prepared, root} = await setup(t);
  const task=await client.call('start_task',{peer:'demo',snapshotId:prepared.snapshotId,prompt:'usage-complete'});
  await client.call('collect_result',{taskId:task.taskId});
  const oldOptions=process.env.NODE_OPTIONS, oldDeadline=process.env.SUB2SUB_TEST_DEADLINE;
  t.after(()=>{
    if(oldOptions===undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=oldOptions;
    if(oldDeadline===undefined) delete process.env.SUB2SUB_TEST_DEADLINE; else process.env.SUB2SUB_TEST_DEADLINE=oldDeadline;
  });
  process.env.NODE_OPTIONS=`${oldOptions || ''} --import ${fileURLToPath(new URL('./fixtures/deadline.mjs',import.meta.url))}`;
  process.env.SUB2SUB_TEST_DEADLINE=path.join(root,'deadline');
  const continuing=client.call('continue_task',{taskId:task.taskId,prompt:'usage-wait'});
  let status;
  for(let attempt=0;attempt<100;attempt++) {
    status=await client.call('task_status',{taskId:task.taskId});
    if(status.rounds?.[1]?.usage?.tokens.totalTokens===180) break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(status.rounds?.[1]?.usage?.tokens.totalTokens,180);
  await fs.writeFile(process.env.SUB2SUB_TEST_DEADLINE,'');
  const stopped=await continuing;
  assert.equal(stopped.stopReason,'time_limit');
  assert.equal(stopped.rounds[1].usage.tokens.totalTokens,180);
  assert.equal(stopped.rounds[1].usage.status,'incomplete');
  assert.equal(stopped.deliveryPending,false);
});


test('partial native schemas and a final usage event after completion preserve explicit completeness', async t => {
  const {client, prepared}=await setup(t);
  const task=await client.call('start_task',{peer:'demo',snapshotId:prepared.snapshotId,prompt:'usage-missing'});
  assert.equal(task.rounds[0].usage.status,'incomplete');
  assert.equal(task.rounds[0].usage.tokens.totalTokens,null);
  assert.equal(task.rounds[0].usage.tokens.inputTokens,150);
  await client.call('collect_result',{taskId:task.taskId});
  const late=await client.call('continue_task',{taskId:task.taskId,prompt:'usage-late'});
  assert.equal(late.rounds[1].usage.status,'observed');
  assert.equal(late.rounds[1].usage.tokens.totalTokens,180);
});
