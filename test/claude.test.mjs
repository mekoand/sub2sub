import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openMcp } from './helpers/mcp.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';

test('provider switches tools independently, offers per-tool defaults, and refuses invalid switches', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-claude-'));
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, JSON.stringify({ stateRoot: root, provider: {
    codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    claudePath: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
  } }));
  const manager = await openMcp(file, { env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') } });
  t.after(async () => { await manager.close(); await stopTestSharing(root); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await manager.tool('provider_settings', { harness: 'claude' })).harness, 'claude');
  assert.equal((await manager.tool('resource_usage')).status, 'unsupported');
  const models = await manager.tool('list_models');
  assert.equal(models.harness, 'claude');
  assert.equal(models.models[0].model, 'sonnet');
  await manager.tool('caller_settings', { harness: 'claude', model: 'sonnet', reasoningEffort: 'low' });
  assert.equal((await manager.tool('caller_settings', { harness: 'codex' })).execution.model, 'gpt-5.6-luna');
  await manager.tool('start_sharing', { address: '127.0.0.1', port: 0 });
  await manager.tool('provider_settings', { harness: 'codex' });
  assert.equal((await manager.tool('sharing_status')).harness, 'codex');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  config.provider.claudePath = path.join(root, 'missing-claude');
  await fs.writeFile(file, JSON.stringify(config));
  await assert.rejects(manager.tool('provider_settings', { harness: 'claude' }), /Claude|claude/);
  assert.equal((await manager.tool('sharing_status')).harness, 'codex');
  config.provider.claudePath = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
  await fs.writeFile(file, JSON.stringify(config));
  await manager.tool('provider_settings', { harness: 'claude' });
  const callerFile = path.join(root, 'caller.json');
  await fs.writeFile(callerFile, JSON.stringify({ stateRoot: path.join(root, 'caller') }));
  const caller = await openMcp(callerFile); t.after(() => caller.close());
  await caller.tool('onboarding', { action: 'confirm' });
  const paired = await caller.tool('pair_peer', { invitation: (await manager.tool('create_pairing')).invitation, peer: 'worker', allowTaskFiles: true });
  assert.equal(paired.harness, 'claude'); assert.equal(paired.model, null);
  await fs.writeFile(path.join(root, 'input.txt'), 'fixture input');
  const copy = await caller.tool('prepare_work_copy', { workspace: root, paths: ['input.txt'] });
  assert.deepEqual((await caller.tool('caller_settings', { harness: 'claude' })).execution, { model: null, reasoningEffort: null });
  await assert.rejects(caller.tool('start_task', { peer: 'worker', snapshotId: copy.snapshotId, prompt: 'must wait for settings' }), /choose|available/i);
  assert.deepEqual((await manager.tool('list_shared_tasks')).tasks, []);
  await caller.tool('caller_settings', { harness: 'claude', model: 'sonnet', reasoningEffort: 'low' });
  const task = await caller.tool('start_task', { peer: 'worker', snapshotId: copy.snapshotId, prompt: 'first' });
  assert.equal(task.harness, 'claude');
  const saved = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'answer.txt'), 'utf8'), 'first');
  const next = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'follow-up' });
  assert.equal(next.threadId, task.threadId);
  await caller.tool('collect_result', { taskId: task.taskId });
  const background = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'background-complete' });
  assert.equal(background.status, 'completed');
  const backgroundSaved = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(backgroundSaved.workCopyDirectory, 'answer.txt'), 'utf8'), 'background-stopped');
  const project = path.join(root, 'claude-home/projects', path.join(await fs.realpath(root), 'sharing/tasks', (await manager.tool('list_pairings')).pairings[0].pairId, task.taskId, 'work').replace(/[^a-zA-Z0-9]/g, '-'));
  const unrelatedId = randomUUID(), unrelated = path.join(project, unrelatedId + '.jsonl');
  await fs.copyFile(path.join(project, task.threadId + '.jsonl'), unrelated);
  await fs.writeFile(unrelated, (await fs.readFile(unrelated, 'utf8')).split('\n').filter(line => !line.includes('"type":"tag"')).join('\n').replaceAll(task.threadId, unrelatedId));
  await fs.mkdir(path.join(project, task.threadId, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(project, task.threadId, 'subagents/agent-fixture.jsonl'), 'owned child');
  assert.equal((await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' })).status, 'released');
  const restored = await caller.tool('continue_task', { taskId: task.taskId, prompt: 'restored' });
  assert.equal(restored.threadId, task.threadId);
  await caller.tool('collect_result', { taskId: task.taskId });
  await manager.tool('provider_settings', { harness: 'codex' });
  await assert.rejects(caller.tool('continue_task', { taskId: task.taskId, prompt: 'wrong tool' }), /switch back/i);
  await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'records' });
  const childDirectory = path.join(project, task.threadId, 'subagents');
  await fs.chmod(childDirectory, 0o500);
  t.after(async () => { await fs.chmod(childDirectory, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; }); });
  await assert.rejects(caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' }), /EACCES|EPERM/);
  assert.ok((await fs.stat(path.join(project, task.threadId + '.jsonl'))).isFile());
  await fs.chmod(childDirectory, 0o700);
  const pairId = (await manager.tool('list_pairings')).pairings[0].pairId;
  assert.equal((await manager.tool('cleanup_shared_task', { pairId, taskId: task.taskId, cleanup: 'all' })).status, 'all_deleted');
  assert.equal((await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' })).status, 'all_deleted');
  await assert.rejects(fs.stat(path.join(project, task.threadId + '.jsonl')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(project, task.threadId)), { code: 'ENOENT' });
  assert.ok((await fs.stat(unrelated)).isFile());
  assert.equal((await manager.tool('caller_settings', { harness: 'claude' })).execution.reasoningEffort, 'low');
});

for (const stopping of ['cancel', 'deadline', 'background-deadline']) test(`Claude ${stopping} returns stage files and can resume its original session`, { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-claude-stop-'));
  const ownerFile = path.join(root, 'owner.json'), callerFile = path.join(root, 'caller.json');
  await fs.writeFile(ownerFile, JSON.stringify({ stateRoot: path.join(root, 'owner'), provider: { harness: 'claude', claudePath: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)) } }));
  await fs.writeFile(callerFile, JSON.stringify({ stateRoot: path.join(root, 'caller') }));
  const deadline = path.join(root, 'deadline');
  const owner = await openMcp(ownerFile, {
    args: ['--import', fileURLToPath(new URL('./fixtures/deadline.mjs', import.meta.url)), fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))],
    env: { SUB2SUB_TEST_DEADLINE: deadline, CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') }
  });
  const caller = await openMcp(callerFile);
  await caller.tool('caller_settings', { harness: 'claude', model: 'sonnet', reasoningEffort: 'low' });
  t.after(async () => { await owner.close(); await caller.close(); await stopTestSharing(path.join(root, 'owner')); await fs.rm(root, { recursive: true, force: true }); });
  await caller.tool('onboarding', { action: 'confirm' });
  const paired = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'worker', allowTaskFiles: true });
  await fs.writeFile(path.join(root, 'input.txt'), 'stage fixture');
  const copy = await caller.tool('prepare_work_copy', { workspace: root, paths: ['input.txt'] });
  const taskPrompt = stopping === 'background-deadline' ? 'background-ignore-interrupt' : 'partial-wait';
  const running = caller.tool('start_task', { peer: 'worker', snapshotId: copy.snapshotId, prompt: taskPrompt }).then(value => ({ value }), error => ({ error }));
  let state;
  for (let i = 0; i < 200; i++) {
    const task = (await owner.tool('list_shared_tasks')).tasks[0];
    if (task) {
      state = await caller.tool('task_status', { taskId: task.taskId });
      if (state.progress?.startsWith('Claude started')) break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(state.progress, /Claude started/);
  await assert.rejects(owner.tool('provider_settings', { harness: 'codex' }), /active task/);
  if (stopping !== 'cancel') await fs.writeFile(deadline, 'stop');
  else await caller.tool('cancel_task', { taskId: state.taskId });
  const outcome = await running;
  if (stopping !== 'cancel') assert.equal(outcome.value.stopReason, 'time_limit');
  else assert.ok(outcome.error);
  assert.equal((await caller.tool('task_status', { taskId: state.taskId })).status, 'interrupted');
  const saved = stopping !== 'cancel' ? outcome.value : await caller.tool('collect_result', { taskId: state.taskId });
  assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'answer.txt'), 'utf8'), taskPrompt);
  await caller.tool('finish_task', { taskId: state.taskId, cleanup: 'workcopy' });
  await fs.rm(deadline, { force: true });
  const next = await caller.tool('continue_task', { taskId: state.taskId, prompt: 'finish' });
  assert.equal(next.threadId, state.threadId);
  await caller.tool('collect_result', { taskId: state.taskId });
  await owner.tool('revoke_pairing', { pairId: paired.pairId, cleanup: 'all' });
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
});


test('a model query cannot advertise a catalog from the tool selected before an idle switch', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-model-switch-'));
  const config = path.join(root, 'config.json'), gate = path.join(root, 'gate');
  await fs.writeFile(config, JSON.stringify({ stateRoot: root, provider: {
    codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    claudePath: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
  } }));
  const manager = await openMcp(config, { env: { SUB2SUB_TEST_MODEL_GATE: gate, CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') } });
  t.after(async () => { await fs.rm(gate, { force: true }); await manager.close(); await stopTestSharing(root); await fs.rm(root, { recursive: true, force: true }); });
  await manager.tool('pair_peer', { peer: 'self', invitation: (await manager.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation });
  await fs.writeFile(gate, 'wait');
  const waiting = manager.tool('list_models', { peer: 'self' }).then(value => ({ value }), error => ({ error }));
  for (let i = 0; i < 200 && !await fs.stat(gate + '.started').catch(error => { if (error.code !== 'ENOENT') throw error; }); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await fs.stat(gate + '.started');
  await manager.tool('provider_settings', { harness: 'claude' });
  await fs.rm(gate);
  assert.match((await waiting).error.message, /changed during model discovery/);
  const current = await manager.tool('list_models', { peer: 'self' });
  assert.equal(current.harness, 'claude'); assert.equal(current.models[0].model, 'sonnet');
});

test('old Codex histories survive records cleanup and remain discoverable after adding Claude work', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-legacy-history-'));
  const config = path.join(root, 'config.json');
  await fs.writeFile(config, JSON.stringify({ stateRoot: root, provider: {
    codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    claudePath: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
  } }));
  const manager = await openMcp(config, { env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') } });
  t.after(async () => { await manager.close(); await stopTestSharing(root); await fs.rm(root, { recursive: true, force: true }); });
  const paired = await manager.tool('pair_peer', { peer: 'self', allowTaskFiles: true, invitation: (await manager.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation });
  await fs.writeFile(path.join(root, 'input.txt'), 'legacy');
  const copy = await manager.tool('prepare_work_copy', { workspace: root, paths: ['input.txt'] });
  const old = await manager.tool('start_task', { peer: 'self', snapshotId: copy.snapshotId, prompt: 'report-execution' });
  await manager.tool('collect_result', { taskId: old.taskId });
  await manager.tool('finish_task', { taskId: old.taskId, cleanup: 'records' });
  const pairRoot = path.join(root, 'sharing/tasks', paired.pairId);
  await fs.rm(path.join(pairRoot, '.harnesses.json')); // The old release has no tool marker.
  const native = path.join(pairRoot, '.fake-codex', old.threadId + '.json');
  await fs.stat(native); await fs.stat(path.join(pairRoot, '.locks'));
  await manager.tool('provider_settings', { harness: 'claude' });
  const nextCopy = await manager.tool('prepare_work_copy', { workspace: root, paths: ['input.txt'] });
  const current = await manager.tool('start_task', { peer: 'self', snapshotId: nextCopy.snapshotId, prompt: 'new Claude work', model: 'sonnet', reasoningEffort: 'low' });
  await manager.tool('collect_result', { taskId: current.taskId });
  await manager.tool('revoke_pairing', { pairId: paired.pairId, cleanup: 'all' });
  await assert.rejects(fs.stat(native), { code: 'ENOENT' });
});
