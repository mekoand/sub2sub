import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../lib/client.mjs';
import { readJson, writeJson } from '../lib/files.mjs';
import { providerRequest } from '../lib/provider.mjs';

async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-upload-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  for (const name of ['input.txt', 'delete.txt', 'untouched.txt', 'run.sh']) await fs.writeFile(path.join(source, name), name);
  const config = { peers: { host: { transport: 'local', taskRoot: path.join(root, 'host'), codexPath: new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname } } };
  const client = new Client(config, path.join(root, 'client'));
  const prepare = (workspace, paths) => client.call('prepare_work_copy', { workspace, paths });
  const initial = await prepare(source, await fs.readdir(source));
  const first = await client.call('start_task', { peer: 'host', snapshotId: initial.snapshotId, prompt: 'first' });
  const saved = await client.call('collect_result', { taskId: first.taskId });
  const edit = path.join(root, 'edit'); await fs.cp(saved.workCopyDirectory, edit, { recursive: true });
  const directory = path.join(root, 'host', first.taskId), work = path.join(directory, 'work'), statePath = path.join(directory, 'state.json');
  return { root, client, config, prepare, first, saved, edit, directory, work, statePath };
}

test('same-task updates send only changed selected files and explicit deletions', async t => {
  const { client, prepare, first, saved, edit, work } = await setup(t);
  await fs.writeFile(path.join(edit, 'input.txt'), 'local change');
  await fs.chmod(path.join(edit, 'run.sh'), 0o700);
  await fs.writeFile(path.join(edit, 'new.txt'), 'added');
  const copy = await prepare(edit, ['input.txt', 'run.sh', 'new.txt', 'untouched.txt']);
  let upload;
  const connect = client.connect.bind(client);
  client.connect = async (peer, request, ...rest) => { if (request.upload) upload = request.upload; return connect(peer, request, ...rest); };
  const next = await client.call('continue_task', { taskId: first.taskId, snapshotId: copy.snapshotId, deletePaths: ['delete.txt'], prompt: 'second' });
  assert.equal(next.threadId, first.threadId); assert.equal(next.revision, 2);
  assert.deepEqual(upload.files.map(f => f.path).sort(), ['input.txt', 'new.txt', 'run.sh']);
  assert.deepEqual(upload.removed, ['delete.txt']);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'local change');
  assert.equal(await fs.readFile(path.join(work, 'untouched.txt'), 'utf8'), 'untouched.txt');
  await assert.rejects(fs.stat(path.join(work, 'delete.txt')), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(work, 'run.sh'))).mode & 0o100);
  assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'input.txt'), 'utf8'), 'input.txt');
  const collected = await client.call('collect_result', { taskId: first.taskId });
  assert.equal(await fs.readFile(path.join(collected.workCopyDirectory, 'new.txt'), 'utf8'), 'added');
  assert.ok(collected.removed.includes('delete.txt'));
  await client.call('continue_task', { taskId: first.taskId, deletePaths: ['new.txt'], prompt: 'delete only' });
  assert.equal(upload.files.length, 0);
  await assert.rejects(fs.stat(path.join(work, 'new.txt')), { code: 'ENOENT' });
});

test('unconfirmed results and modified local baselines refuse file uploads', async t => {
  const { client, prepare, first, saved, edit, work } = await setup(t);
  const copy = await prepare(edit, ['input.txt']);
  await fs.writeFile(path.join(saved.workCopyDirectory, 'input.txt'), 'polluted baseline');
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, snapshotId: copy.snapshotId, prompt: 'no execution' }), /differs.*baseline/);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'input.txt');
  await fs.writeFile(path.join(saved.workCopyDirectory, 'input.txt'), 'input.txt');
  await client.call('continue_task', { taskId: first.taskId, prompt: 'ordinary continuation' });
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, snapshotId: copy.snapshotId, prompt: 'no execution' }), /Collect.*latest result/);
});

test('host changes after save are not overwritten and can be collected before reconciliation', async t => {
  const { client, prepare, first, edit, work, statePath } = await setup(t);
  await fs.writeFile(path.join(edit, 'input.txt'), 'local edit');
  const copy = await prepare(edit, ['input.txt']);
  await fs.writeFile(path.join(work, 'input.txt'), 'host edit');
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, snapshotId: copy.snapshotId, prompt: 'no execution' }), /Host files changed/);
  assert.equal((await readJson(statePath)).revision, 1);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'host edit');
  const saved = await client.call('collect_result', { taskId: first.taskId });
  assert.equal(await fs.readFile(path.join(saved.workCopyDirectory, 'input.txt'), 'utf8'), 'host edit');
  await fs.writeFile(path.join(edit, 'input.txt'), 'reconciled edit');
  const reconciled = await prepare(edit, ['input.txt']);
  await client.call('continue_task', { taskId: first.taskId, snapshotId: reconciled.snapshotId, prompt: 'after reconciliation' });
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'reconciled edit');
});

test('complete input limits include unchanged files and type conflicts are explicit', async t => {
  const { client, config, prepare, first, edit, work, statePath } = await setup(t);
  await fs.writeFile(path.join(edit, 'new.txt'), 'new');
  const copy = await prepare(edit, ['new.txt']);
  config.caller = { inputFiles: 5 };
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, snapshotId: copy.snapshotId, prompt: 'no execution' }), /file list/);
  config.caller = {};
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, deletePaths: ['missing.txt'], prompt: 'no execution' }), /Deletion must name/);
  await fs.rm(path.join(edit, 'input.txt')); await fs.mkdir(path.join(edit, 'input.txt')); await fs.writeFile(path.join(edit, 'input.txt/child'), 'child');
  const conflict = await prepare(edit, ['input.txt']);
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, snapshotId: conflict.snapshotId, prompt: 'no execution' }), /File\/directory conflict/);
  assert.equal((await readJson(statePath)).revision, 1);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'input.txt');
  await client.call('continue_task', { taskId: first.taskId, snapshotId: conflict.snapshotId, deletePaths: ['input.txt'], prompt: 'explicit file to directory' });
  assert.equal(await fs.readFile(path.join(work, 'input.txt/child'), 'utf8'), 'child');
});

test('released work restores the confirmed complete copy before applying narrow updates', async t => {
  const { client, prepare, first, edit, work } = await setup(t);
  await client.call('finish_task', { taskId: first.taskId, cleanup: 'workcopy' });
  await fs.writeFile(path.join(edit, 'input.txt'), 'after restore');
  const copy = await prepare(edit, ['input.txt']);
  const next = await client.call('continue_task', { taskId: first.taskId, snapshotId: copy.snapshotId, prompt: 'restored' });
  assert.equal(next.threadId, first.threadId);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'after restore');
  assert.equal(await fs.readFile(path.join(work, 'untouched.txt'), 'utf8'), 'untouched.txt');
});

test('old host refuses file updates before submission but accepts ordinary continuation', async t => {
  const { client, prepare, first, edit } = await setup(t);
  const copy = await prepare(edit, ['input.txt']);
  const connect = client.connect.bind(client), submitted = [];
  client.connect = async (peer, request, ...rest) => {
    if (request.action === 'run') submitted.push(request);
    const result = await connect(peer, request, ...rest);
    if (request.action === 'models') delete result.taskFileUpdates;
    return result;
  };
  await assert.rejects(client.call('continue_task', { taskId: first.taskId, snapshotId: copy.snapshotId, prompt: 'no execution' }), /does not support task file updates/);
  assert.equal(submitted.length, 0);
  await client.call('continue_task', { taskId: first.taskId, prompt: 'ordinary' });
  assert.equal(submitted.length, 1); assert.equal(submitted[0].upload, undefined);
});

test('failed work swap restores the previous copy and does not start a model round', async t => {
  const { root, first, directory, work, statePath } = await setup(t);
  const state = await readJson(statePath);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === path.join(directory, 'upload-staging')) throw Object.assign(new Error('fixture swap failure'), { code: 'EIO' });
    return rename(from, to);
  });
  const upload = { baseRevision: 1, baseDigest: state.savedManifestDigest, files: [{ path: 'input.txt', content: Buffer.from('update').toString('base64'), executable: false }], removed: [] };
  await assert.rejects(providerRequest({ action: 'run', protocol: 3, taskId: first.taskId, prompt: 'must not execute', upload }, { root: path.join(root, 'host'), executable: new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname }), /fixture swap failure/);
  assert.equal((await readJson(statePath)).revision, 1);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'input.txt');
  assert.equal((await readJson(statePath)).status, 'interrupted');
});

test('interrupted swap is recovered under the task lock without automatically executing', async t => {
  const { root, client, first, directory, work, statePath } = await setup(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const lock = path.join(root, 'host/.locks', first.taskId);
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import path from 'node:path';
    const [directory, lock] = process.argv.slice(1), work = path.join(directory, 'work');
    await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({pid:process.pid}));
    await fs.rename(work, path.join(directory, 'upload-backup'));
    await fs.mkdir(work); await fs.writeFile(path.join(work, 'partial'), 'not committed');
    const file = path.join(directory, 'state.json'), state = JSON.parse(await fs.readFile(file));
    state.status = 'updating'; await fs.writeFile(file, JSON.stringify(state));
    process.exit(0);
  `, directory, lock]);
  await assert.rejects(providerRequest({ action: 'result', taskId: first.taskId }, { root: path.join(root, 'host'), executable: new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname }), /previous work was recovered/);
  assert.equal((await readJson(statePath)).revision, 1);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'input.txt');
  await assert.rejects(fs.stat(path.join(work, 'partial')), { code: 'ENOENT' });
  await client.call('collect_result', { taskId: first.taskId });
});

test('stale updates, finite host limits and live or legacy locks cannot change work', async t => {
  const { root, first, work, statePath } = await setup(t);
  const state = await readJson(statePath), taskRoot = path.join(root, 'host');
  const request = { action: 'run', protocol: 3, taskId: first.taskId, prompt: 'must not execute', upload: { baseRevision: 0, baseDigest: state.savedManifestDigest, files: [{ path: 'extra', content: 'eA==', executable: false }], removed: [] } };
  const options = { root: taskRoot, executable: new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname };
  await assert.rejects(providerRequest(request, options), /stale or unconfirmed/);
  request.upload.baseRevision = 1;
  await assert.rejects(providerRequest(request, { ...options, limits: { inputFiles: 5 } }), /file list/);
  const lock = path.join(taskRoot, '.locks', first.taskId);
  await fs.mkdir(lock);
  await assert.rejects(providerRequest(request, options), /legacy running lock/);
  assert.deepEqual(await fs.readdir(lock), []);
  await writeJson(path.join(lock, 'owner.json'), { pid: process.pid });
  await assert.rejects(providerRequest(request, options), /already has a running turn/);
  assert.equal((await readJson(statePath)).revision, 1);
  assert.equal(await fs.readFile(path.join(work, 'input.txt'), 'utf8'), 'input.txt');
});
