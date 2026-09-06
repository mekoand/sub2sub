import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { snapshot, validateFiles, materialize, collectChanges, MAX_BYTES, readJson } from '../lib/files.mjs';
import { Client, connect } from '../lib/client.mjs';
import { providerRequest } from '../lib/provider.mjs';
const exec = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const provider = fileURLToPath(new URL('../lib/provider.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url));

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'input.txt'), 'uncommitted work');
  await fs.writeFile(path.join(source, 'remove.txt'), 'delete this');
  const config = { stateRoot: path.join(root, 'consumer'), peers: { demo: { transport: 'local', taskRoot: path.join(root, 'provider'), codexPath: fixture } } };
  return { root, source, config, client: new Client(config, config.stateRoot) };
}

test('tracked default keeps current edits and excludes dependencies/secrets/untracked files', async t => {
  const { source } = await setup(t);
  await exec('git', ['init', '-q', source]);
  await fs.mkdir(path.join(source, 'node_modules'));
  await fs.writeFile(path.join(source, 'node_modules/large'), 'dependency');
  await fs.writeFile(path.join(source, '.env'), 'secret');
  await exec('git', ['add', '.'], { cwd: source });
  await fs.writeFile(path.join(source, 'input.txt'), '最新修改');
  await fs.writeFile(path.join(source, 'untracked.txt'), 'not implicit');
  const copy = await snapshot(source);
  assert.deepEqual(copy.files.map(f => f.path), ['input.txt', 'remove.txt']);
  assert.equal(Buffer.from(copy.files[0].content, 'base64').toString(), '最新修改');
  assert.ok(copy.skipped.includes('.env'));
  assert.deepEqual((await snapshot(source, ['untracked.txt'])).files.map(f => f.path), ['untracked.txt']);
});

test('transfer rejects traversal, symlinks, duplicate paths, malformed content, and oversize copies', async t => {
  const { root, source } = await setup(t);
  await fs.writeFile(path.join(root, 'outside'), 'secret');
  await fs.symlink(path.join(root, 'outside'), path.join(source, 'link'));
  await fs.symlink(root, path.join(source, 'directory-link'));
  await assert.rejects(snapshot(source, ['link']), /Symbolic/);
  await assert.rejects(snapshot(source, ['directory-link/outside']), /Symbolic/);
  const entry = { path: 'ok', content: '', executable: false };
  for (const bad of ['../escape', '/absolute', '.git/config', 'a/../../x', 'a\\b', '.env', '.codex/auth.json']) assert.throws(() => validateFiles([{ ...entry, path: bad }]));
  assert.throws(() => validateFiles([entry, entry]), /Duplicate/);
  assert.throws(() => validateFiles([entry, { ...entry, path: 'ok/nested' }]), /conflict/);
  assert.throws(() => validateFiles([{ ...entry, content: 'invalid%' }]), /content/);
  await fs.writeFile(path.join(source, 'large'), Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(snapshot(source, ['large']), /20971520 bytes/);
  await assert.rejects(materialize(path.join(root, 'destination'), [{ ...entry, path: '../escape' }]));
  await assert.rejects(fs.stat(path.join(root, 'escape')), { code: 'ENOENT' });
});

test('base64 validation handles large valid files up to 20 MiB without recursion', async t => {
  const { root, source, client } = await setup(t);
  const data = Buffer.alloc(4 * 1024 * 1024, 0x7a);
  await fs.writeFile(path.join(source, 'large.bin'), data);
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['large.bin'] });
  const started = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'large file' });
  const output = Buffer.alloc(data.length, 0x81);
  await fs.writeFile(path.join(root, 'provider', started.taskId, 'work/large.bin'), output);
  const collected = await client.call('collect_result', { taskId: started.taskId });
  assert.deepEqual(await fs.readFile(path.join(collected.resultDirectory, 'files/large.bin')), output);
  const entry = { path: 'boundary.bin', content: Buffer.alloc(MAX_BYTES).toString('base64'), executable: false };
  assert.equal(validateFiles([entry]), MAX_BYTES);
  assert.throws(() => validateFiles([entry, { path: 'extra', content: 'YQ==', executable: false }]), /20971520 bytes/);
  for (const content of ['A', 'AAA', 'A===', 'AA=A', 'AAAA=', 'AAAA\n', 'AAAA-___']) {
    assert.throws(() => validateFiles([{ ...entry, content }]), /Invalid file content/);
  }
});

test('failed follow-up exports its own error instead of the previous successful response', async t => {
  const { root, source, client } = await setup(t);
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const started = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'previous success' });
  await assert.rejects(client.call('continue_task', { taskId: started.taskId, prompt: 'failure' }), /fixture failure/);
  const state = await client.call('task_status', { taskId: started.taskId });
  assert.equal(state.response, '');
  const collected = await client.call('collect_result', { taskId: started.taskId });
  assert.equal(collected.status, 'failed');
  assert.match(collected.error, /fixture failure/);
  const manifest = await readJson(path.join(collected.resultDirectory, 'changes.json'));
  assert.equal(manifest.revision, 2);
  assert.match(manifest.error, /fixture failure/);
  const response = await fs.readFile(path.join(collected.resultDirectory, 'response.md'), 'utf8');
  assert.match(response, /fixture failure/);
  assert.doesNotMatch(response, /previous success/);
  await client.call('finish_task', { cleanup: 'keep', taskId: started.taskId });
  await fs.stat(path.join(root, 'provider', started.taskId, 'work'));
});

test('build deliverables download and skipped paths must be resolved before cleanup', async t => {
  const { root, source, client } = await setup(t);
  await fs.mkdir(path.join(source, 'dist'));
  await fs.writeFile(path.join(source, 'dist/stale.txt'), 'old build');
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt', 'dist'] });
  assert.deepEqual(prepared.excluded, ['dist']);
  const started = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'build' });
  const work = path.join(root, 'provider', started.taskId, 'work');
  for (const folder of ['dist', 'build', '.cache']) await fs.mkdir(path.join(work, folder));
  await fs.writeFile(path.join(work, 'dist/report.html'), '<p>deliverable</p>');
  await fs.writeFile(path.join(work, 'build/report.pdf'), Buffer.from([0, 1, 127, 255]));
  await fs.writeFile(path.join(work, '.cache/required.txt'), 'also needed');
  await fs.writeFile(path.join(work, 'dist/.env'), 'must not transfer');
  const collected = await client.call('collect_result', { taskId: started.taskId });
  assert.deepEqual(collected.changed, ['answer.txt', 'build/report.pdf', 'dist/report.html']);
  assert.deepEqual(collected.skipped, ['.cache', 'dist/.env']);
  assert.equal(await fs.readFile(path.join(collected.resultDirectory, 'files/dist/report.html'), 'utf8'), '<p>deliverable</p>');
  assert.deepEqual(await fs.readFile(path.join(collected.resultDirectory, 'files/build/report.pdf')), Buffer.from([0, 1, 127, 255]));
  await assert.rejects(fs.stat(path.join(collected.resultDirectory, 'files/dist/.env')), { code: 'ENOENT' });
  await assert.rejects(client.call('finish_task', { cleanup: 'records', taskId: started.taskId }), /skipped paths/);
  await assert.rejects(connect(client.peer('demo'), { action: 'finish', cleanup: 'records', taskId: started.taskId, revision: started.revision }), /skipped paths/);
  await fs.stat(work);
  // The model uses a follow-up to move a required output out of an excluded cache.
  await client.call('continue_task', { taskId: started.taskId, prompt: 'recover output' });
  await fs.rename(path.join(work, '.cache/required.txt'), path.join(work, 'recovered.txt'));
  const latest = await client.call('collect_result', { taskId: started.taskId });
  assert.equal(await fs.readFile(path.join(latest.resultDirectory, 'files/recovered.txt'), 'utf8'), 'also needed');
  await assert.rejects(client.call('finish_task', { cleanup: 'records', taskId: started.taskId, discardPaths: ['.cache'] }), /dist\/\.env/);
  await client.call('finish_task', { cleanup: 'records', taskId: started.taskId, discardPaths: latest.skipped });
  await assert.rejects(fs.stat(work), { code: 'ENOENT' });
  await fs.stat(path.join(latest.workCopyDirectory, 'build/report.pdf'));
});

test('cleanup honors skipped paths in an older download after result rules change', async t => {
  const { root, source, client } = await setup(t);
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const started = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'upgrade' });
  const work = path.join(root, 'provider', started.taskId, 'work');
  await fs.mkdir(path.join(work, 'dist'));
  await fs.writeFile(path.join(work, 'dist/report.txt'), 'must survive upgrade');
  const collected = await client.call('collect_result', { taskId: started.taskId });
  // Model the previous version's download: dist was omitted in this same revision.
  const manifestPath = path.join(collected.resultDirectory, 'changes.json');
  const manifest = await readJson(manifestPath);
  manifest.changed = manifest.changed.filter(file => !file.path.startsWith('dist/'));
  manifest.skipped = ['dist'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.rm(path.join(collected.resultDirectory, 'files/dist'), { recursive: true });
  await assert.rejects(client.call('finish_task', { cleanup: 'records', taskId: started.taskId }), /skipped paths.*dist/);
  await fs.stat(path.join(work, 'dist/report.txt'));
  const latest = await client.call('collect_result', { taskId: started.taskId });
  await client.call('finish_task', { cleanup: 'records', taskId: started.taskId });
  assert.equal(await fs.readFile(path.join(latest.workCopyDirectory, 'dist/report.txt'), 'utf8'), 'must survive upgrade');
});

test('all caller cleanup levels preserve changes made after the last confirmed save', async t => {
  const { root, source, client } = await setup(t);
  for (const cleanup of ['workcopy', 'records', 'all']) {
    const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
    const task = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'saved answer' });
    await client.call('collect_result', { taskId: task.taskId });
    const work = path.join(root, 'provider', task.taskId, 'work');
    await fs.writeFile(path.join(work, 'answer.txt'), 'late answer');
    await fs.writeFile(path.join(work, 'late.txt'), 'late output');
    await fs.rm(path.join(work, 'input.txt'));
    await assert.rejects(client.call('finish_task', { taskId: task.taskId, cleanup }), /changed after the last save/);
    assert.equal(await fs.readFile(path.join(work, 'late.txt'), 'utf8'), 'late output');
    // Even a downloaded packet must be acknowledged before cleanup.
    await connect(client.peer('demo'), { action: 'result', taskId: task.taskId });
    await assert.rejects(connect(client.peer('demo'), { action: 'finish', taskId: task.taskId, cleanup, revision: task.revision }), /not saved locally/);
    const saved = await client.call('collect_result', { taskId: task.taskId });
    assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'answer.txt'), 'utf8'), 'late answer');
    assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'late.txt'), 'utf8'), 'late output');
    await assert.rejects(fs.stat(path.join(saved.workCopyDirectory, 'input.txt')), { code: 'ENOENT' });
    await client.call('finish_task', { taskId: task.taskId, cleanup });
    await assert.rejects(fs.stat(work), { code: 'ENOENT' });
  }
});

test('cleanup resumes after work deletion succeeds but the remaining cleanup fails', async t => {
  const { root, source, client } = await setup(t);
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const started = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'cleanup retry' });
  const collected = await client.call('collect_result', { taskId: started.taskId });
  const taskDirectory = path.join(root, 'provider', started.taskId);
  const targetDirectory = await fs.realpath(taskDirectory);
  const remove = fs.rm;
  const interruptedCleanup = t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target === targetDirectory) {
      await remove(path.join(targetDirectory, 'work'), { recursive: true });
      throw new Error('fixture cleanup write failure');
    }
    return remove(target, ...args);
  });
  await assert.rejects(providerRequest({ action: 'finish', cleanup: 'records', taskId: started.taskId, revision: started.revision }, { root: path.join(root, 'provider') }), /fixture cleanup write failure/);
  interruptedCleanup.mock.restore();
  await assert.rejects(fs.stat(path.join(taskDirectory, 'work')), { code: 'ENOENT' });
  assert.equal((await client.call('task_status', { taskId: started.taskId })).status, 'finishing');
  await assert.rejects(client.call('continue_task', { taskId: started.taskId, prompt: 'cannot resume deleted copy' }), /cleanup has already started/);
  await assert.rejects(client.call('collect_result', { taskId: started.taskId }), /cleanup has already started/);
  assert.equal((await client.call('finish_task', { cleanup: 'records', taskId: started.taskId })).status, 'records_deleted');
  await assert.rejects(fs.stat(path.join(taskDirectory, 'original.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(collected.resultDirectory, 'files/answer.txt'), 'utf8'), 'cleanup retry');
});

test('legacy task locks prevent cleanup and legacy history stays addressable after records deletion', async t => {
  const { root, source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const task = await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'legacy task' });
  await client.call('collect_result', { taskId: task.taskId });
  const directory = path.join(root, 'provider', task.taskId);
  await fs.mkdir(path.join(directory, 'running'));
  await assert.rejects(client.call('finish_task', { taskId: task.taskId, cleanup: 'records' }), /legacy task lock/);
  assert.ok(await fs.stat(path.join(directory, 'work/input.txt')));
  await fs.rmdir(path.join(directory, 'running'));
  const stateFile = path.join(directory, 'state.json');
  const state = await readJson(stateFile); delete state.historyTagged;
  await fs.writeFile(stateFile, JSON.stringify(state));
  const nativeFile = path.join(root, 'provider/.fake-codex', task.threadId + '.json');
  const native = await readJson(nativeFile); delete native.threadSource;
  await fs.writeFile(nativeFile, JSON.stringify(native));
  await client.call('finish_task', { taskId: task.taskId, cleanup: 'records' });
  assert.ok(await fs.stat(nativeFile));
  await client.call('finish_task', { taskId: task.taskId, cleanup: 'all' });
  await assert.rejects(fs.stat(nativeFile), { code: 'ENOENT' });
});

test('round trip and follow-up preserve session; collect then finish removes only temporary copies', async t => {
  const { root, source, client } = await setup(t);
  const prepared = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt', 'remove.txt'] });
  const first = await client.call('start_task', { peer: 'demo', snapshotId: prepared.snapshotId, prompt: '第一轮' });
  assert.equal(first.status, 'completed');
  await assert.rejects(client.call('finish_task', { cleanup: 'records', taskId: first.taskId }), /Collect/);
  const initialDownload = await client.call('collect_result', { taskId: first.taskId });
  assert.deepEqual(initialDownload.changed, ['answer.txt']);
  assert.deepEqual(initialDownload.removed, ['remove.txt']);
  const second = await client.call('continue_task', { taskId: first.taskId, prompt: '第二轮' });
  assert.equal(second.threadId, first.threadId);
  await assert.rejects(client.call('finish_task', { cleanup: 'records', taskId: first.taskId }), /latest result/);
  const downloaded = await client.call('collect_result', { taskId: first.taskId });
  assert.equal(await fs.readFile(path.join(downloaded.resultDirectory, 'files/answer.txt'), 'utf8'), '第二轮');
  assert.equal(await fs.readFile(path.join(source, 'remove.txt'), 'utf8'), 'delete this');
  await assert.rejects(fs.stat(path.join(source, 'answer.txt')), { code: 'ENOENT' });
  const calls = (await fs.readFile(path.join(root, 'provider', first.taskId, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.find(c => c.method === 'thread/resume').params.threadId, first.threadId);
  const turn = calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.approvalsReviewer, 'auto_review');
  const start = calls.find(c => c.method === 'thread/start').params;
  const scope = start.config?.permissions?.[start.permissions];
  assert.equal(scope?.filesystem[':root'], 'deny');
  assert.equal(scope.filesystem[':minimal'], 'read');
  assert.equal(scope.filesystem[await fs.realpath(path.join(root, 'provider', first.taskId, 'work'))], 'write');
  assert.equal(scope.network.enabled, false);
  assert.equal(turn.permissions, start.permissions);
  assert.equal(turn.approvalPolicy.granular.sandbox_approval, false);
  assert.equal(turn.approvalPolicy.granular.request_permissions, false);
  assert.equal(start.config.features.plugins, false);
  assert.equal(start.config.features.apps, false);
  assert.equal(start.config.mcp_servers.hostTool.enabled, false);
  // The provider completed cleanup but the caller never persisted its response.
  await connect(client.peer('demo'), { action: 'finish', cleanup: 'records', taskId: first.taskId, revision: second.revision });
  const finished = await client.call('finish_task', { cleanup: 'records', taskId: first.taskId });
  assert.equal(finished.status, 'records_deleted');
  await assert.rejects(fs.stat(path.join(root, 'provider', first.taskId, 'work')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'provider', first.taskId, 'original.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'provider', first.taskId)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'consumer/snapshots', `${prepared.snapshotId}.json`)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(downloaded.resultDirectory, 'files/answer.txt'), 'utf8'), '第二轮');
  assert.equal((await client.call('finish_task', { cleanup: 'records', taskId: first.taskId })).status, 'records_deleted');
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, prompt: 'again' }), /finished/);
});

test('failure and approvals are actionable errors; copies survive for recovery', async t => {
  const { root, source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  for (const prompt of ['failure', 'approval']) {
    let error;
    try { await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt }); }
    catch (e) { error = e; }
    assert.ok(error);
    assert.match(error.message, prompt === 'failure' ? /fixture failure/ : /Owner action required/);
    const id = error.message.match(/Task ([a-f0-9-]+):/)[1];
    assert.equal((await client.call('task_status', { taskId: id })).status, 'failed');
    const result = await client.call('collect_result', { taskId: id });
    await client.call('finish_task', { cleanup: 'keep', taskId: id });
    await fs.stat(path.join(root, 'provider', id, 'work/input.txt'));
    await fs.stat(result.resultDirectory);
  }
});

test('child and stale turn notifications cannot complete or contaminate the root turn', { timeout: 5000 }, async t => {
  const { root, source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const result = await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'subagent-events' });
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'ROOT FINAL');
  assert.equal(await fs.readFile(path.join(root, 'provider', result.taskId, 'work/answer.txt'), 'utf8'), 'root completed after children');
});

for (const prompt of ['message-phases', 'unknown-message-phase']) test(`saved response excludes commentary: ${prompt}`, async t => {
  const { source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const result = await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt });
  assert.equal(result.response, 'Finished successfully.');
  const saved = await client.call('collect_result', { taskId: result.taskId });
  assert.equal((await fs.readFile(path.join(saved.resultDirectory, 'response.md'), 'utf8')).trim(), 'Finished successfully.');
});

test('root notifications arriving before turn start response are matched and retained', { timeout: 5000 }, async t => {
  const { source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const result = await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'early-completion' });
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'EARLY ROOT FINAL');
});

test('running task rejects concurrent continuation and result; cancellation stops the turn', async t => {
  const { source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  let resolveId;
  const idReady = new Promise(resolve => { resolveId = resolve; });
  const running = client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'hang' }, p => { const match = p.match(/^Created task ([a-f0-9-]+)\./); if (match) resolveId(match[1]); });
  const id = await idReady;
  for (let i = 0; i < 100; i++) {
    try { if ((await client.call('task_status', { taskId: id })).progress?.includes('Waiting')) break; }
    catch (e) { if (!e.message.includes('ENOENT')) throw e; }
    await new Promise(r => setTimeout(r, 25));
  }
  try {
    await assert.rejects(client.call('continue_task', { taskId: id, prompt: 'conflict' }), /running turn|owns/);
    await assert.rejects(client.call('collect_result', { taskId: id }), /running turn|owns/);
  } finally { await client.call('cancel_task', { taskId: id }); }
  assert.equal((await running).status, 'interrupted');
  assert.equal((await client.call('task_status', { taskId: id })).status, 'interrupted');
});

test('result refuses symlink exfiltration', async t => {
  const { root, source } = await setup(t);
  const copy = await snapshot(source, ['input.txt']);
  await fs.symlink(path.join(root, 'outside'), path.join(source, 'stolen'));
  await assert.rejects(collectChanges(source, copy.files), /Symbolic/);
});

test('provider stdin preserves Chinese characters split across byte chunks', async t => {
  const { root } = await setup(t);
  const taskRoot = path.join(root, '中文目录');
  const child = spawn(process.execPath, [provider, taskRoot, fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { output += d; });
  const closed = new Promise(resolve => child.on('close', resolve));
  const id = randomUUID();
  const payload = Buffer.from(JSON.stringify({ action: 'run', taskId: id, snapshot: { files: [{ path: '中文.txt', content: 'YQ==', executable: false }] }, prompt: '中文指令' }));
  const split = payload.indexOf(Buffer.from('中')) + 1;
  child.stdin.write(payload.subarray(0, split));
  await new Promise(r => setTimeout(r, 25));
  child.stdin.end(payload.subarray(split));
  assert.equal(await closed, 0);
  assert.equal(await fs.readFile(path.join(taskRoot, id, 'work/answer.txt'), 'utf8'), '中文指令');
  await fs.stat(path.join(taskRoot, id, 'work/中文.txt'));
  assert.ok(!output.includes('�'));
});

test('a rejected first-turn configuration retains its task but discards the unstarted native thread', async t => {
  const { root, source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  await assert.rejects(client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'configuration-failure' }), /failed to load configuration/);
  const [task] = (await client.call('list_tasks', {})).tasks;
  const failed = await client.call('task_status', { taskId: task.taskId });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.threadId, undefined);
  const resumed = await client.call('continue_task', { taskId: task.taskId, prompt: 'recovered' });
  assert.equal(resumed.status, 'completed');
  const calls = (await fs.readFile(path.join(root, 'provider', task.taskId, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 2);
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 0);
});

test('MCP first use lists no peers and explains setup without a configuration error', async () => {
  const child = spawn(process.execPath, [mcp], { env: { ...process.env, SUB2SUB_CONFIG: '/no-such-sub2sub-config.json' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  const closed = new Promise(resolve => child.on('close', resolve));
  child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  child.stdin.write(JSON.stringify({ id: 2, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ id: 3, method: 'tools/call', params: { name: 'list_peers', arguments: {} } }) + '\n');
  await new Promise(r => setTimeout(r, 150));
  child.stdin.end();
  assert.equal(await closed, 0);
  const responses = output.trim().split('\n').map(JSON.parse);
  assert.ok(responses.find(r => r.id === 2).result.tools.some(t => t.name === 'finish_task'));
  const result = responses.find(r => r.id === 3).result;
  assert.notEqual(result.isError, true);
  const state = JSON.parse(result.content[0].text);
  assert.deepEqual(state.peers, []);
  assert.equal(state.setupNeeded, true);
  assert.match(state.nextStep, /invitation/);
});

test('terminating MCP interrupts an active provider and releases its running lock', { timeout: 15000 }, async t => {
  const { root, source, config } = await setup(t);
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [mcp], { env: { ...process.env, SUB2SUB_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const responses = new Map();
  let resolveCreated;
  const created = new Promise(resolve => { resolveCreated = resolve; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) { responses.get(message.id)?.(message); responses.delete(message.id); }
    const match = message.params?.message?.match(/^Created task ([a-f0-9-]+)\./);
    if (match) resolveCreated(match[1]);
  });
  let seq = 0;
  const call = (method, params) => new Promise(resolve => {
    const id = ++seq;
    responses.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  await call('initialize', { protocolVersion: '2024-11-05' });
  const preparation = await call('tools/call', { name: 'prepare_work_copy', arguments: { workspace: source, paths: ['input.txt'] } });
  const prepared = JSON.parse(preparation.result.content[0].text);
  const run = call('tools/call', { name: 'start_task', arguments: { peer: 'demo', snapshotId: prepared.snapshotId, prompt: 'hang' }, _meta: { progressToken: 'run' } });
  const id = await created;
  const statePath = path.join(root, 'provider', id, 'state.json');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await readJson(statePath)).progress?.includes('Waiting')) { ready = true; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(ready);
  const closed = new Promise(resolve => child.on('close', resolve));
  child.kill('SIGTERM');
  assert.equal(await closed, 0);
  assert.equal((await run).result.isError, true);
  assert.equal((await readJson(statePath)).status, 'interrupted');
  await assert.rejects(fs.stat(path.join(root, 'provider', '.locks', id)), { code: 'ENOENT' });
});

test('finishing one task retains a shared input snapshot until the other task finishes', async t => {
  const { root, source, client } = await setup(t);
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['input.txt'] });
  const first = await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'one' });
  const second = await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'two' });
  await client.call('collect_result', { taskId: first.taskId });
  await client.call('finish_task', { cleanup: 'records', taskId: first.taskId });
  const snapshotPath = path.join(root, 'consumer/snapshots', `${copy.snapshotId}.json`);
  await fs.stat(snapshotPath);
  await client.call('collect_result', { taskId: second.taskId });
  await client.call('finish_task', { cleanup: 'records', taskId: second.taskId });
  await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' });
});
