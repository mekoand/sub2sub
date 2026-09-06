// Runs two small turns on an authorized SSH peer's signed-in Codex subscription.
// Usage: node scripts/remote-smoke.mjs /absolute/path/to/config.json peer-name
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '../lib/client.mjs';
import { readJson } from '../lib/files.mjs';

const [configPath, peer] = process.argv.slice(2);
if (!configPath || !peer) throw new Error('Provide the configuration path and authorized peer name.');
const config = await readJson(configPath);
const client = new Client(config, config.stateRoot);
if (client.peer(peer).transport !== 'ssh') throw new Error('This check requires an SSH peer.');
const source = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-remote-source-'));
await fs.writeFile(path.join(source, 'input.txt'), '源文件保持不变\n');
let taskId;
console.log(JSON.stringify({ source, peer }));
try {
  await client.call('check_peer', { peer });
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await client.call('start_task', {
    peer, snapshotId: copy.snapshotId,
    prompt: 'This is an authorized minimal integration test. In this working directory only, create answer.txt containing exactly FIRST followed by a newline. Leave input.txt unchanged. Do not access the network, inspect credentials, or edit other files. Reply done.'
  }, console.log);
  taskId = first.taskId;
  assert.equal(first.status, 'completed');
  const second = await client.call('continue_task', {
    taskId,
    prompt: 'Continue the same test in this working directory only. Replace answer.txt with exactly SECOND followed by a newline. Create dist/report.txt containing exactly ARTIFACT followed by a newline. Leave input.txt unchanged. Do not access the network or edit other files. Reply done.'
  }, console.log);
  assert.equal(second.status, 'completed');
  assert.equal(second.threadId, first.threadId);
  assert.equal((await client.call('task_status', { taskId })).revision, second.revision);
  const collected = await client.call('collect_result', { taskId });
  console.log(JSON.stringify(collected));
  assert.equal(await fs.readFile(path.join(collected.resultDirectory, 'files/answer.txt'), 'utf8'), 'SECOND\n');
  assert.equal(await fs.readFile(path.join(collected.resultDirectory, 'files/dist/report.txt'), 'utf8'), 'ARTIFACT\n');
  assert.equal(await fs.readFile(path.join(source, 'input.txt'), 'utf8'), '源文件保持不变\n');
  await assert.rejects(fs.stat(path.join(source, 'answer.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(source, 'dist')), { code: 'ENOENT' });
  assert.deepEqual(collected.removed, []);
  assert.deepEqual(collected.skipped, [], 'Inspect skipped paths before authorizing their cleanup.');
  const finished = await client.call('finish_task', { cleanup: 'records', taskId });
  assert.equal(finished.status, 'records_deleted');
  console.log(JSON.stringify({ passed: true, taskId, threadId: first.threadId, resultDirectory: collected.resultDirectory, status: finished.status }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, taskId, source, error: error.message }));
  process.exitCode = 1;
}
