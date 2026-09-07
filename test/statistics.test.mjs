import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../lib/client.mjs';
import { measuredRounds, summarizeTasks } from '../lib/statistics.mjs';

test('statistics use measured turns, exact start-time windows and retained records', () => {
  const now = Date.parse('2026-09-08T00:00:00Z');
  const round = (revision, age, status = 'completed', elapsedMs = 1000) => ({ revision, startedAt: new Date(now - age * 86400000).toISOString(), status, elapsedMs });
  const tasks = [
    { peer: 'office', pairId: 'caller-1', harness: 'codex', revision: 4, rounds: [round(1, 8), round(2, 7), round(3, 1, 'failed'), round(4, 0, 'interrupted')] },
    { peer: 'office', pairId: 'caller-1', harness: 'claude', rounds: [round(1, 0, 'running', undefined)] },
    { peer: 'old', revision: 6 },
    { peer: 'released', cleanupStatus: 'released', rounds: [round(1, 1)] },
    { peer: 'deleted', finished: true, rounds: [round(1, 1)] },
    { peer: 'future', rounds: [round(1, -1)] }
  ];
  delete tasks[1].rounds[0].elapsedMs;
  const result = summarizeTasks(tasks, { now });
  assert.deepEqual(result.totals, { tasks: 3, rounds: 5, elapsedMs: 4000, timedRounds: 4 });
  assert.equal(result.unmeasuredTasks, 1);
  assert.deepEqual(result.resources[0].outcomes, { completed: 1, failed: 1, interrupted: 1 });
  assert.equal(summarizeTasks(tasks, { now, days: 30 }).totals.rounds, 6);
  assert.equal(summarizeTasks(tasks, { now, role: 'provider' }).resources[0].resource, 'caller-1');
  assert.throws(() => measuredRounds([round(1, 1), round(1, 2)]), /measurement/);
  assert.throws(() => measuredRounds([{ ...round(1, 1), elapsedMs: -1 }]), /measurement/);
  assert.throws(() => measuredRounds([{ ...round(1, 1), status: '__proto__' }]), /measurement/);
  assert.throws(() => summarizeTasks([], { days: 8 }), /7\/30/);
});

test('execution and failed follow-up count once; repeated collection and work-copy release preserve measurements', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-statistics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'brief.txt'), 'Synthetic input');
  const config = { peers: { demo: { transport: 'local', taskRoot: path.join(root, 'provider'), codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } } };
  const client = new Client(config, path.join(root, 'caller'));
  t.after(() => client.close());
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['brief.txt'] });
  const task = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'Synthetic answer' });
  assert.equal(task.rounds.length, 1);
  assert.equal(task.rounds[0].status, 'completed');
  assert.ok(task.rounds[0].elapsedMs > 0);
  await client.call('collect_result', { taskId: task.taskId });
  await client.call('collect_result', { taskId: task.taskId });
  const first = await client.call('resource_statistics', {});
  assert.equal(first.totals.rounds, 1);
  await assert.rejects(client.call('continue_task', { taskId: task.taskId, prompt: 'failure' }), /fixture failure/);
  const saved = await client.call('collect_result', { taskId: task.taskId });
  const second = await client.call('resource_statistics', {});
  assert.equal(second.totals.rounds, 2);
  assert.deepEqual(second.resources[0].outcomes, { completed: 1, failed: 1 });
  await client.call('finish_task', { taskId: task.taskId, cleanup: 'workcopy' });
  assert.deepEqual((await client.call('resource_statistics', {})).totals, second.totals);
  const stateFile = path.join(root, 'provider', task.taskId, 'state.json');
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).rounds.length, 2);
  // Upgrade a legacy task: only subsequent turns are measured, no fabricated history.
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); delete state.rounds;
  await fs.writeFile(stateFile, JSON.stringify(state));
  await client.call('continue_task', { taskId: task.taskId, prompt: 'After upgrade' });
  await client.call('collect_result', { taskId: task.taskId });
  const legacy = await client.call('resource_statistics', {});
  assert.equal(legacy.totals.rounds, 1); assert.equal(legacy.unmeasuredTasks, 1);
  await client.call('finish_task', { taskId: task.taskId, cleanup: 'records' });
  assert.equal((await client.call('resource_statistics', {})).totals.rounds, 0);
  await fs.stat(path.join(saved.resultDirectory, 'response.md'));
});
