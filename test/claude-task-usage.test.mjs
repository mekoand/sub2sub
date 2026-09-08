import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMcp } from './helpers/mcp.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';

async function setup(t, { deadline = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-claude-usage-'));
  const ownerFile = path.join(root, 'owner.json'), callerFile = path.join(root, 'caller.json');
  await fs.writeFile(ownerFile, JSON.stringify({ stateRoot: path.join(root, 'owner'), provider: { harness: 'claude', claudePath: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)) } }));
  await fs.writeFile(callerFile, JSON.stringify({ stateRoot: path.join(root, 'caller') }));
  const deadlineFile = path.join(root, 'deadline');
  const owner = await openMcp(ownerFile, { env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), ...(deadline ? { SUB2SUB_TEST_DEADLINE: deadlineFile } : {}) },
    ...(deadline ? { args: ['--import', fileURLToPath(new URL('./fixtures/deadline.mjs', import.meta.url)), fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))] } : {}) });
  const caller = await openMcp(callerFile);
  t.after(async () => { await Promise.all([owner.close(), caller.close()]); await stopTestSharing(path.join(root, 'owner')); await fs.rm(root, { recursive: true, force: true }); });
  await caller.tool('onboarding', { action: 'confirm' });
  await caller.tool('caller_settings', { harness: 'claude', model: 'sonnet', reasoningEffort: 'low' });
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner', allowTaskFiles: true });
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'brief.txt'), 'Synthetic usage task');
  const copy = await caller.tool('prepare_work_copy', { workspace: source, paths: ['brief.txt'] });
  return { owner, caller, copy, deadlineFile };
}

test('Claude native model breakdown survives collection and counts one task round across two model groups', { skip: process.platform !== 'darwin' }, async t => {
  const { owner, caller, copy } = await setup(t);
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'claude-usage-complete' });
  const usage = task.rounds[0].usage;
  assert.equal(usage?.source, 'claude-agent-sdk');
  assert.equal(usage.status, 'observed');
  assert.equal(usage.requestedModel, 'sonnet');
  assert.equal(usage.actualModel, null);
  assert.deepEqual(usage.tokens, { totalTokens: null, inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
  assert.deepEqual(usage.models, [
    { actualModel: 'claude-sonnet-5', tokens: { totalTokens: null, inputTokens: 13, cachedInputTokens: 24, cacheWriteInputTokens: 35, outputTokens: 50, reasoningOutputTokens: 10 } },
    { actualModel: 'claude-haiku-4-5', tokens: { totalTokens: null, inputTokens: 2, cachedInputTokens: 1, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: null } }
  ]);
  const saved = await caller.tool('collect_result', { taskId: task.taskId });
  assert.deepEqual(saved.rounds[0].usage, usage);
  const summary = await caller.tool('resource_statistics');
  assert.equal(summary.totals.rounds, 1);
  assert.deepEqual(summary.usageGroups.map(row => [row.actualModel, row.tokens.inputTokens]), [['claude-sonnet-5', 13], ['claude-haiku-4-5', 2]]);
  assert.deepEqual((await owner.tool('resource_statistics', { role: 'provider' })).usageDetails.map(row => row.tokens), summary.usageDetails.map(row => row.tokens));
});

test('cancelled Claude usage keeps deduplicated main-loop input and caches, with unknown output; restored rounds start fresh', { skip: process.platform !== 'darwin' }, async t => {
  const { caller, copy } = await setup(t);
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'claude-usage-complete' });
  await caller.tool('collect_result', { taskId: task.taskId });
  const running = caller.tool('continue_task', { taskId: task.taskId, prompt: 'claude-usage-partial' }).then(value => ({ value }), error => ({ error }));
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await caller.tool('task_status', { taskId: task.taskId });
    if (status.rounds?.[1]?.usage?.models?.[0]?.tokens.inputTokens === 13) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await caller.tool('cancel_task', { taskId: task.taskId });
  assert.ok((await running).error);
  const saved = await caller.tool('collect_result', { taskId: task.taskId });
  const partial = saved.rounds[1].usage;
  assert.equal(partial.status, 'incomplete');
  assert.equal(partial.scope, 'main-loop assistant input/cache only');
  assert.deepEqual(partial.tokens, { totalTokens: null, inputTokens: 13, cachedInputTokens: 24, cacheWriteInputTokens: 35, outputTokens: null, reasoningOutputTokens: null });
  assert.equal(partial.models.length, 1);
  await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' });
  const resumed = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'claude-usage-complete' });
  assert.equal(resumed.threadId, task.threadId);
  assert.deepEqual(resumed.rounds[2].usage.models, task.rounds[0].usage.models);
  await caller.tool('collect_result', { taskId: task.taskId });
  const before = (await caller.tool('resource_statistics')).usageGroups;
  await caller.tool('collect_result', { taskId: task.taskId });
  assert.deepEqual((await caller.tool('resource_statistics')).usageGroups, before);
  assert.deepEqual(before.map(row => [row.actualModel, row.tokens.inputTokens, row.tokens.outputTokens]), [['claude-sonnet-5', 39, 100], ['claude-haiku-4-5', 4, 8]]);
  await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'records' });
  assert.deepEqual((await caller.tool('resource_statistics')).usageDetails, []);
});

test('Claude failed results retain native totals while zeroed crash results cannot erase observed input', { skip: process.platform !== 'darwin' }, async t => {
  const { caller, copy } = await setup(t);
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'claude-usage-complete' });
  await caller.tool('collect_result', { taskId: task.taskId });
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'claude-usage-failure' }), /Synthetic failed execution/);
  const failed = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(failed.rounds[1].usage.status, 'observed');
  assert.equal(failed.rounds[1].usage.tokens.inputTokens, 13);
  assert.equal(failed.rounds[1].usage.tokens.outputTokens, 50);
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'claude-usage-crash' }), /Synthetic crash/);
  const crashed = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(crashed.rounds[2].usage.status, 'incomplete');
  assert.equal(crashed.rounds[2].usage.tokens.inputTokens, 13);
  assert.equal(crashed.rounds[2].usage.tokens.outputTokens, null);
  const unavailable = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'No usage in this older result' });
  assert.equal(unavailable.rounds[3].usage.status, 'unavailable');
  assert.equal(unavailable.rounds[3].usage.tokens.inputTokens, null);
});

test('Claude production deadline automatically collects observed partial usage', { skip: process.platform !== 'darwin' }, async t => {
  const { owner, caller, copy, deadlineFile } = await setup(t, { deadline: true });
  const running = caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'claude-usage-partial' });
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = (await owner.tool('list_shared_tasks')).tasks[0];
    if (task) {
      state = await caller.tool('task_status', { taskId: task.taskId });
      if (state.rounds?.[0]?.usage?.tokens.inputTokens === 13) break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state.rounds?.[0]?.usage?.tokens.inputTokens, 13);
  await fs.writeFile(deadlineFile, 'stop');
  const stopped = await running;
  assert.equal(stopped.stopReason, 'time_limit');
  assert.equal(stopped.deliveryPending, false);
  assert.equal(stopped.rounds[0].usage.status, 'incomplete');
  assert.equal(stopped.rounds[0].usage.tokens.inputTokens, 13);
  assert.equal(stopped.rounds[0].usage.tokens.outputTokens, null);
});

test('concurrent Claude tasks keep distinct native model usage on their own task records', { skip: process.platform !== 'darwin' }, async t => {
  const { caller, copy } = await setup(t);
  const [large, small] = await Promise.all(['claude-usage-complete', 'claude-usage-small'].map(prompt => caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt })));
  assert.notEqual(large.taskId, small.taskId);
  assert.notEqual(large.threadId, small.threadId);
  assert.equal(large.rounds[0].usage.models.length, 2);
  assert.equal(small.rounds[0].usage.models.length, 1);
  assert.equal(small.rounds[0].usage.tokens.inputTokens, 3);
  await caller.tool('collect_result', { taskId: large.taskId });
  await caller.tool('collect_result', { taskId: small.taskId });
  const summary = await caller.tool('resource_statistics');
  assert.equal(summary.totals.rounds, 2);
  assert.deepEqual(summary.usageDetails.filter(row => row.taskId === small.taskId).map(row => row.tokens.inputTokens), [3]);
});

test('incomplete Claude results preserve same-model observed input and caches without claiming whole-query coverage', { skip: process.platform !== 'darwin' }, async t => {
  const { caller, copy } = await setup(t);
  const task = await caller.tool('start_task', { peer: 'owner', snapshotId: copy.snapshotId, prompt: 'claude-usage-missing-fields' });
  const saved = await caller.tool('collect_result', { taskId: task.taskId });
  const usage = saved.rounds[0].usage;
  assert.deepEqual(usage.tokens, { totalTokens: null, inputTokens: 13, cachedInputTokens: 24, cacheWriteInputTokens: 35, outputTokens: 50, reasoningOutputTokens: null });
  assert.equal(usage.actualModel, 'claude-sonnet-5');
  assert.equal(usage.status, 'incomplete');
  assert.match(usage.reason, /main-loop.*partial/i);
  const summary = await caller.tool('resource_statistics');
  assert.equal(summary.usageGroups[0].tokens.inputTokens, 13);
  assert.equal(summary.usageGroups[0].incompleteRounds, 1);
});
