// Uses the local signed-in Codex subscription. No SSH or account sharing.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '../lib/client.mjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-smoke-'));
const source = path.join(root, 'source');
await fs.mkdir(source);
await fs.writeFile(path.join(source, 'input.txt'), 'source must stay unchanged\n');
const config = { peers: { local: { transport: 'local', taskRoot: path.join(root, 'provider'), codexPath: process.argv[2] || 'codex', model: process.argv[3] || 'gpt-5.6-luna' } } };
const client = new Client(config, path.join(root, 'consumer'));
console.log(JSON.stringify({ smokeRoot: root }));
try {
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await client.call('start_task', { peer: 'local', snapshotId: copy.snapshotId, prompt: 'This is a minimal local integration test. In this working directory only, create answer.txt containing exactly FIRST followed by a newline. Leave input.txt unchanged. Do not access the network, inspect credentials, or edit any other files. Reply done.' }, console.log);
  assert.equal(first.status, 'completed');
  const second = await client.call('continue_task', { taskId: first.taskId, prompt: 'Continue the same integration test. Replace answer.txt with exactly SECOND followed by a newline. Leave input.txt unchanged and reply done.' }, console.log);
  assert.equal(second.threadId, first.threadId);
  const downloaded = await client.call('collect_result', { taskId: first.taskId });
  assert.equal(await fs.readFile(path.join(downloaded.resultDirectory, 'files/answer.txt'), 'utf8'), 'SECOND\n');
  assert.equal(await fs.readFile(path.join(source, 'input.txt'), 'utf8'), 'source must stay unchanged\n');
  await assert.rejects(fs.stat(path.join(source, 'answer.txt')), { code: 'ENOENT' });
  const finished = await client.call('finish_task', { cleanup: 'records', taskId: first.taskId });
  await assert.rejects(fs.stat(path.join(root, 'provider', first.taskId, 'work')), { code: 'ENOENT' });
  console.log(JSON.stringify({ passed: true, taskId: first.taskId, threadId: first.threadId, finished: finished.status, resultDirectory: downloaded.resultDirectory }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, smokeRoot: root, error: error.message }));
  process.exitCode = 1;
}
