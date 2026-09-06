// Explicitly authorized real LAN cleanup test. Deploy runtime to a NEW isolated
// remote directory first. Uses the peer's subscription and deletes only these
// synthetic test tasks. Never updates the installed plugin or Codex config.
// node scripts/cleanup-smoke.mjs user@host /absolute/isolated-root LAN_IP
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openMcp } from '../test/helpers/mcp.mjs';

const [host, remoteRoot, address, resumeRoot] = process.argv.slice(2);
if (!host || !path.isAbsolute(remoteRoot || '') || !address) throw new Error('Provide host, new isolated remote root and LAN address.');
const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const ssh = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host];
const node = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
const codex = '/Applications/ChatGPT.app/Contents/Resources/codex';
const remote = async code => JSON.parse((await exec('ssh', [...ssh, `${quote(node)} --input-type=module -e ${quote(code)}`], { timeout: 30000 })).stdout);
await fs.mkdir('.sub2sub/cleanup-smoke', { recursive: true });
const localRoot = resumeRoot || await fs.mkdtemp(path.resolve('.sub2sub/cleanup-smoke/run-'));
const evidence = resumeRoot ? JSON.parse(await fs.readFile(path.join(localRoot, 'evidence.json'), 'utf8')) : { localRoot, remoteRoot, checkpoints: [] };
assert.equal(evidence.remoteRoot, remoteRoot);
const record = async (step, detail = {}) => {
  evidence.checkpoints.push({ step, ...detail });
  await fs.writeFile(path.join(localRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ step, ...detail }));
};
const source = path.join(localRoot, 'source');
if (!resumeRoot) {
await fs.mkdir(source);
await fs.writeFile(path.join(source, 'sample.mjs'), 'export const message = "Synthetic cleanup fixture";\n');
await fs.writeFile(path.join(source, 'notes.md'), '# Synthetic cleanup input\nThis document exists only for the sub2sub cleanup test.\n');
await fs.writeFile(path.join(localRoot, 'caller.json'), JSON.stringify({ stateRoot: path.join(localRoot, 'caller'), deviceName: 'cleanup-test-caller', peers: {} }));
}
const ownerConfig = path.join(remoteRoot, 'owner.json');
if (!resumeRoot) await remote(`import fs from 'node:fs/promises'; await fs.writeFile(${JSON.stringify(ownerConfig)}, ${JSON.stringify(JSON.stringify({ stateRoot: path.join(remoteRoot, 'state'), deviceName: 'cleanup-test-provider', provider: { codexPath: codex }, peers: {} }))}, { flag: 'wx', mode: 0o600 }); console.log('{}');`);
let owner, caller, history;
const work = (pair, task) => path.join(remoteRoot, 'state/sharing/tasks', pair, task);
const exists = target => remote(`import fs from 'node:fs/promises'; try { await fs.stat(${JSON.stringify(target)}); console.log('true'); } catch (e) { if (e.code !== 'ENOENT') throw e; console.log('false'); }`);
try {
  owner = await openMcp(ownerConfig, { command: 'ssh', args: [...ssh, `SUB2SUB_CONFIG=${quote(ownerConfig)} ${quote(node)} ${quote(path.join(remoteRoot, 'runtime/bin/mcp.mjs'))}`], timeoutMs: 180000 });
  caller = await openMcp(path.join(localRoot, 'caller.json'), { timeoutMs: 180000 });
  history = await openMcp(undefined, { command: 'ssh', args: [...ssh, `${quote(codex)} app-server --listen stdio://`], initialize: { clientInfo: { name: 'sub2sub-cleanup-verification', version: '0.3.0' }, capabilities: { experimentalApi: true } }, timeoutMs: 30000 });
  let pair;
  if (resumeRoot) {
    await owner.tool('start_sharing');
    const saved = JSON.parse(await fs.readFile(path.join(localRoot, 'caller.json'), 'utf8')).peers['cleanup-test'];
    pair = { pairId: saved.pairId };
    await record('resumed-existing-test', { pairId: pair.pairId });
  } else {
    const invite = await owner.tool('create_pairing', { address, port: 0 });
    pair = await caller.tool('pair_peer', { invitation: invite.invitation, peer: 'cleanup-test', allowTaskFiles: true });
    await record('paired', { pairId: pair.pairId, model: pair.model, reasoningEffort: pair.reasoningEffort });
  }
  const prepare = () => caller.tool('prepare_work_copy', { workspace: source, peer: 'cleanup-test', paths: ['sample.mjs', 'notes.md'] });
  const previousDelivery = evidence.checkpoints.findLast(c => c.step === 'records-deleted-history-retained');
  const first = previousDelivery ? { taskId: evidence.firstTask, threadId: evidence.firstThread } : evidence.firstTask ? await caller.tool('task_status', { taskId: evidence.firstTask }) : await caller.tool('start_task', { peer: 'cleanup-test', snapshotId: (await prepare()).snapshotId, prompt: 'This is an authorized synthetic cleanup test. Read sample.mjs and notes.md. Create report.txt with one sentence summarizing both files. Leave input files unchanged. Do not use network or subagents. Reply done.' });
  evidence.firstTask = first.taskId; evidence.firstThread = first.threadId;
  const nativeBefore = evidence.firstNative || (await history.request('thread/read', { threadId: first.threadId, includeTurns: false })).thread;
  assert.equal(nativeBefore.threadSource, `sub2sub:${first.taskId}`);
  assert.equal(nativeBefore.forkedFromId, null);
  const hadNativeMetadata = Boolean(evidence.firstNative);
  evidence.firstNative = nativeBefore;
  await record(hadNativeMetadata ? 'resumed-native-metadata' : 'native-ownership-verified', { source: nativeBefore.source, threadSource: nativeBefore.threadSource, forkedFromId: nativeBefore.forkedFromId });
  assert.equal(nativeBefore.cwd, path.join(work(pair.pairId, first.taskId), 'work'));
  const listing = await history.request('thread/list', { cwd: nativeBefore.cwd, sourceKinds: ['appServer', 'vscode', 'cli', 'exec', 'unknown'], archived: false });
  if (!previousDelivery) assert.ok(listing.data.some(t => t.id === first.threadId));
  let latest = previousDelivery;
  if (!previousDelivery) {
  const downloaded = await caller.tool('collect_result', { taskId: first.taskId });
  assert.ok((await fs.readFile(path.join(downloaded.resultDirectory, 'files/report.txt'), 'utf8')).trim());
  assert.deepEqual(downloaded.skipped, []);
  assert.equal((await caller.tool('finish_task', { taskId: first.taskId, cleanup: 'keep' })).status, 'retained');
  assert.ok(await exists(path.join(work(pair.pairId, first.taskId), 'work/sample.mjs')));
  await record('retained', { taskId: first.taskId, threadId: first.threadId });
  const next = await caller.tool('continue_task', { taskId: first.taskId, prompt: 'Append a line reading SECOND TURN to report.txt. Keep the two input files unchanged. Reply done.' });
  assert.equal(next.threadId, first.threadId);
  latest = await caller.tool('collect_result', { taskId: first.taskId });
  assert.match(await fs.readFile(path.join(latest.resultDirectory, 'files/report.txt'), 'utf8'), /SECOND TURN/);
  await caller.tool('finish_task', { taskId: first.taskId, cleanup: 'records' });
  assert.equal(await exists(work(pair.pairId, first.taskId)), false);
  assert.equal((await history.request('thread/read', { threadId: first.threadId, includeTurns: false })).thread.id, first.threadId);
  await record('records-deleted-history-retained', { resultDirectory: latest.resultDirectory });
  }
  await caller.tool('finish_task', { taskId: first.taskId, cleanup: 'all' });
  for (const archived of [false, true]) assert.equal((await history.request('thread/list', { cwd: nativeBefore.cwd, sourceKinds: ['appServer', 'vscode', 'cli', 'exec', 'unknown'], archived })).data.length, 0);
  await assert.rejects(history.request('thread/read', { threadId: first.threadId, includeTurns: false }), /not found|not loaded|no rollout|not.*persisted|unable to (find|resolve)/i);
  if (nativeBefore.path) assert.equal(await exists(nativeBefore.path), false);
  await record('all-deleted', { taskDirectoryAbsent: true, nativeThreadAbsent: true, nativeHistoryFileAbsent: Boolean(nativeBefore.path) });

  const second = await caller.tool('start_task', { peer: 'cleanup-test', snapshotId: (await prepare()).snapshotId, prompt: 'Create provider-cleanup.txt containing OWNER CLEANUP TEST. Leave sample.mjs and notes.md unchanged. Reply done. This test task may be deleted by the provider before results are downloaded.' });
  evidence.secondTask = second.taskId; evidence.secondThread = second.threadId;
  const secondNative = (await history.request('thread/read', { threadId: second.threadId, includeTurns: false })).thread;
  const pending = caller.tool('continue_task', { taskId: second.taskId, prompt: 'This turn tests cancellation. Run sleep 60 in the task directory, then append FINISHED to provider-cleanup.txt. Do not access network.' }).then(value => ({ value }), error => ({ error: error.message }));
  let running = false;
  for (let i = 0; i < 50; i++) {
    const state = await caller.tool('task_status', { taskId: second.taskId });
    if (state.status === 'running' && state.revision === 2) { running = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(running);
  assert.equal((await owner.tool('revoke_pairing', { pairId: pair.pairId })).status, 'revoked');
  assert.ok((await pending).error);
  assert.equal((await owner.tool('sharing_status')).activeTask, null);
  await assert.rejects(caller.tool('check_peer', { peer: 'cleanup-test' }), /revoked|not paired/);
  assert.ok(await exists(work(pair.pairId, second.taskId)));
  assert.equal((await history.request('thread/read', { threadId: second.threadId, includeTurns: false })).thread.id, second.threadId);
  await record('provider-disconnected-active-turn', { taskId: second.taskId, threadId: second.threadId, dataRetained: true });
  assert.equal((await owner.tool('cleanup_shared_tasks', { pairId: pair.pairId, cleanup: 'all' })).status, 'all_deleted');
  assert.equal(await exists(work(pair.pairId, second.taskId)), false);
  for (const archived of [false, true]) assert.equal((await history.request('thread/list', { cwd: secondNative.cwd, sourceKinds: ['appServer', 'vscode', 'cli', 'exec', 'unknown'], archived })).data.length, 0);
  await assert.rejects(history.request('thread/read', { threadId: second.threadId, includeTurns: false }), /not found|not loaded|no rollout|not.*persisted|unable to (find|resolve)/i);
  if (secondNative.path) assert.equal(await exists(secondNative.path), false);
  assert.deepEqual((await owner.tool('list_shared_tasks')).tasks, []);
  assert.equal(await fs.readFile(path.join(source, 'sample.mjs'), 'utf8'), 'export const message = "Synthetic cleanup fixture";\n');
  assert.match(await fs.readFile(path.join(latest.resultDirectory, 'files/report.txt'), 'utf8'), /SECOND TURN/);
  await record('provider-all-deleted', { taskDirectoryAbsent: true, nativeThreadAbsent: true, localInputsAndResultsPreserved: true });
  evidence.passed = true;
  await record('passed');
} catch (error) {
  evidence.passed = false;
  await record('failed', { error: error.message });
  process.exitCode = 1;
} finally {
  for (const connection of [history, caller, owner]) if (connection) await connection.close();
}
