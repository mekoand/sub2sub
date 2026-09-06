// Real subscription validation using synthetic files and isolated plugin state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openMcp } from '../test/helpers/mcp.mjs';

const remote = process.argv[3] ? JSON.parse(await fs.readFile(process.argv[3], 'utf8')) : null;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-lifecycle-smoke-'));
const source = path.join(root, 'source');
await fs.mkdir(source);
await fs.writeFile(path.join(source, 'input.txt'), 'synthetic input must remain unchanged\n');
const executable = process.argv[2] || '/Applications/ChatGPT.app/Contents/Resources/codex';
const ownerConfig = path.join(root, 'owner.json'), callerConfig = path.join(root, 'caller.json');
await fs.writeFile(ownerConfig, JSON.stringify({ stateRoot: path.join(root, 'owner'), provider: { codexPath: executable } }));
await fs.writeFile(callerConfig, JSON.stringify({ stateRoot: path.join(root, 'caller') }));
const owner = await openMcp(ownerConfig, { timeoutMs: 180000, ...(remote ? {
  command: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', remote.host,
    `SUB2SUB_CONFIG=${quote(remote.root + '/owner.json')} ${quote(remote.nodePath)} ${quote(remote.runtime + '/bin/mcp.mjs')}`]
} : {}) });
const caller = await openMcp(callerConfig, { timeoutMs: 180000 });
console.log(JSON.stringify({ root, runtime: fileURLToPath(new URL('../', import.meta.url)) }));
let task;
try {
  const paired = await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: remote?.address || '127.0.0.1', port: 0 })).invitation, peer: 'test-provider', allowTaskFiles: true });
  const models = await caller.tool('list_models', { peer: 'test-provider' });
  assert.ok(models.models.some(m => m.model === 'gpt-5.6-luna' && m.reasoningEfforts.includes('max')));
  await caller.tool('caller_settings', { model: 'gpt-5.6-luna', reasoningEffort: 'max' });
  assert.equal((await owner.tool('provider_settings')).allowedModels, 'all');
  assert.equal((await caller.tool('list_peers')).peers[0].status, 'available');
  const copy = await caller.tool('prepare_work_copy', { peer: 'test-provider', workspace: source, paths: ['input.txt'] });
  task = await caller.tool('start_task', { peer: 'test-provider', snapshotId: copy.snapshotId, prompt: 'Synthetic integration test. In this directory only, create answer.txt containing exactly FIRST followed by a newline. Leave input.txt unchanged. Remember the test marker maple-owl-73 in this conversation; do not put the marker in any file. Reply done. Do not inspect other directories, use network, or request extra permissions.' });
  assert.equal(task.status, 'completed');
  console.log(JSON.stringify({ stage: 'first-turn', taskId: task.taskId, threadId: task.threadId, model: task.model, reasoningEffort: task.reasoningEffort }));
  const first = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(first.workCopyDirectory, 'answer.txt'), 'utf8'), 'FIRST\n');
  assert.equal((await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'workcopy' })).status, 'released');
  const taskDirectory = path.join(root, 'owner/sharing/tasks', paired.pairId, task.taskId);
  if (!remote) assert.deepEqual(await fs.readdir(taskDirectory), ['state.json']);
  assert.equal((await caller.tool('task_status', { taskId: task.taskId, details: true })).inspection.workCopyExists, false);
  const second = await caller.tool('continue_task', { taskId: task.taskId, reasoningEffort: 'high', prompt: 'Continue the same synthetic test after restoring its files. Recall the test marker from my first message. Replace answer.txt with exactly SECOND, a space, that marker, then a newline. Leave input.txt unchanged. Reply done. Work only in this directory with no network or additional permissions.' });
  assert.equal(second.threadId, task.threadId);
  assert.equal(second.status, 'completed');
  assert.equal(second.model, 'gpt-5.6-luna');
  assert.equal(second.reasoningEffort, 'high');
  await caller.tool('edit_peer', { peer: 'test-provider', name: 'tested-provider' });
  const result = await caller.tool('collect_result', { taskId: task.taskId });
  assert.equal(await fs.readFile(path.join(result.workCopyDirectory, 'answer.txt'), 'utf8'), 'SECOND maple-owl-73\n');
  assert.equal(await fs.readFile(path.join(result.workCopyDirectory, 'input.txt'), 'utf8'), 'synthetic input must remain unchanged\n');
  assert.equal(await fs.readFile(path.join(source, 'input.txt'), 'utf8'), 'synthetic input must remain unchanged\n');
  const cleanup = await caller.tool('finish_task', { taskId: task.taskId, cleanup: 'all' });
  assert.equal(cleanup.status, 'all_deleted');
  if (!remote) await assert.rejects(fs.stat(taskDirectory), { code: 'ENOENT' });
  assert.equal((await owner.tool('list_shared_tasks', { details: true })).tasks.length, 0);
  await caller.tool('delete_peer', { peer: 'tested-provider' });
  assert.deepEqual((await caller.tool('list_peers')).peers, []);
  await owner.tool('revoke_pairing', { pairId: paired.pairId, cleanup: 'keep' });
  const report = { passed: true, transport: remote ? 'two-Mac LAN' : 'loopback LAN', taskId: task.taskId, threadId: task.threadId, model: second.model, reasoningEffort: second.reasoningEffort, resumedRevision: second.revision, resultDirectory: result.resultDirectory, workCopyDirectory: result.workCopyDirectory, cleanup: cleanup.status };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({ passed: false, root, taskId: task?.taskId, error: error.message }));
  process.exitCode = 1;
} finally { await caller.close(); await owner.close(); }
