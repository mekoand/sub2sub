import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '../lib/client.mjs';
import { Config } from '../lib/config.mjs';
import { writeJson } from '../lib/files.mjs';
import { processLock } from '../lib/lock.mjs';

async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-storage-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Config(path.join(root, 'config.json'));
  await store.update(c => { c.peers = {}; });
  const client = new Client(await store.read(), path.join(root, 'state'), store);
  await client.initialize(); t.after(() => client.close());
  const id = randomUUID(), snapshotId = randomUUID();
  const old = path.join(client.stateRoot, 'results', `${id}-old`), latest = path.join(client.stateRoot, 'results', `${id}-latest`);
  for (const dir of [old, latest]) { await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'response.md'), 'hello'); }
  const work = path.join(client.stateRoot, 'workcopies', id, 'copy-latest');
  await fs.mkdir(path.join(work, 'files'), { recursive: true }); await fs.writeFile(path.join(work, 'files', 'a.txt'), 'abc');
  await fs.writeFile(path.join(root, 'source.txt'), 'keep source');
  await writeJson(path.join(client.stateRoot, 'snapshots', `${snapshotId}.json`), { files: [] });
  await writeJson(path.join(client.stateRoot, 'tasks', `${id}.json`), { peer: 'offline', status: 'completed', snapshotId, resultDirectory: latest, workCopyRoot: work, workCopyPaths: ['a.txt'], savedAt: new Date().toISOString(), rounds: [] });
  return { root, client, id, snapshotId, old, latest, work };
}

async function clean(client, input) {
  const preview = await client.call('cleanup_local_files', { ...input, confirm: false });
  return client.call('cleanup_local_files', { ...input, confirm: true, previewToken: preview.previewToken });
}

test('local storage previews old files, retains latest delivery, and optionally removes the record', async t => {
  const { root, client, id, old } = await setup(t);
  const inventory = await client.call('local_storage', {});
  assert.equal(inventory.tasks.length, 1);
  assert.equal(inventory.tasks[0].oldBytes, 5);
  const preview = await client.call('cleanup_local_files', { taskId: id, scope: 'old' });
  assert.equal(preview.expectedBytes, 5);
  assert.equal(await fs.readFile(path.join(old, 'response.md'), 'utf8'), 'hello');
  const cleaned = await clean(client, { taskId: id, scope: 'old', confirm: true });
  assert.equal(cleaned.status, 'cleaned'); assert.equal(cleaned.removedBytes, 5);
  assert.equal((await client.call('list_tasks', {})).tasks[0].workCopyDirectory.endsWith('/files'), true);
  await clean(client, { taskId: id, scope: 'all', confirm: true });
  const task = (await client.call('list_tasks', {})).tasks[0];
  assert.equal(task.localFilesCleaned, true); assert.equal(task.responseFile, undefined); assert.equal(task.workCopyDirectory, undefined);
  await clean(client, { taskId: id, scope: 'all', deleteRecord: true, confirm: true });
  assert.deepEqual((await client.call('list_tasks', {})).tasks, []);
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'keep source');
});

test('shared snapshots count once and remain until the last task releases them', async t => {
  const { client, id, snapshotId } = await setup(t);
  const second = randomUUID();
  await writeJson(path.join(client.stateRoot, 'tasks', `${second}.json`), { peer: 'offline', status: 'completed', snapshotId });
  const inventory = await client.call('local_storage', {});
  const snapshot = inventory.tasks[0].entries.find(e => e.kind === 'snapshot');
  assert.equal(snapshot.references.length, 2);
  assert.equal(inventory.bytes, inventory.tasks.reduce((n, e) => n + e.bytes, 0) - snapshot.bytes);
  const result = await clean(client, { taskId: id, scope: 'all', deleteRecord: true, confirm: true });
  assert.equal(result.retainedSharedPaths.length, 1);
  assert.equal((await client.call('local_storage', {})).tasks[0].taskId, second);
  assert.equal((await client.call('local_storage', {})).tasks[0].entries.find(e => e.kind === 'snapshot').status, 'present');
  await clean(client, { taskId: second, scope: 'all', deleteRecord: true, confirm: true });
  assert.equal((await client.call('local_storage', {})).bytes, 0);
});

test('cleanup refuses active file operations and never follows symbolic links', async t => {
  const { root, client, id, old } = await setup(t);
  const release = await processLock(path.join(client.stateRoot, 'tasks', '.locks', id));
  try { await assert.rejects(clean(client, { taskId: id, scope: 'all', confirm: true }), /owns/); }
  finally { await release(); }
  await fs.symlink(path.join(root, 'source.txt'), path.join(old, 'link'));
  const inventory = await client.call('local_storage', {});
  assert.equal(inventory.bytes, null);
  await assert.rejects(clean(client, { taskId: id, scope: 'old', confirm: true }), /Link|link/);
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'keep source');
});

test('missing saved files are reported and do not prevent clearing a stale record', async t => {
  const { client, id, latest } = await setup(t);
  await fs.rm(latest, { recursive: true });
  const inventory = await client.call('local_storage', {});
  assert.equal(inventory.tasks[0].entries.find(e => e.path === latest).status, 'missing');
  const result = await clean(client, { taskId: id, scope: 'all', deleteRecord: true, confirm: true });
  assert.equal(result.status, 'cleaned');
});

test('confirmation rejects a changed preview before removing any files', async t => {
  const { client, id, old } = await setup(t);
  const preview = await client.call('cleanup_local_files', { taskId: id, scope: 'old' });
  await fs.writeFile(path.join(old, 'response.md'), 'changed after preview');
  await assert.rejects(client.call('cleanup_local_files', { taskId: id, scope: 'old', confirm: true, previewToken: preview.previewToken }), /changed|preview/i);
  assert.equal(await fs.readFile(path.join(old, 'response.md'), 'utf8'), 'changed after preview');
});

test('unmanaged pointers cannot grant deletion access to source files', async t => {
  const { client, root, id } = await setup(t);
  await writeJson(path.join(client.stateRoot, 'tasks', `${id}.json`), { status: 'completed', resultDirectory: root });
  assert.equal((await client.call('local_storage', {})).bytes, null);
  await assert.rejects(client.call('cleanup_local_files', { taskId: id, scope: 'all' }), /outside managed storage/);
  assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'keep source');
});

test('partial deletion reports the error and keeps the record without broken delivery links', async t => {
  const { client, id, old } = await setup(t);
  const originalRm = fs.rm;
  const mock = t.mock.method(fs, 'rm', async (target, options) => {
    if (target === old) throw Object.assign(new Error('Synthetic filesystem denial'), { code: 'EACCES' });
    return originalRm(target, options);
  });
  const result = await clean(client, { taskId: id, scope: 'all', deleteRecord: true });
  assert.equal(result.status, 'partial');
  assert.match(result.failures[0].reason, /Synthetic filesystem denial/);
  const task = (await client.call('list_tasks', {})).tasks[0];
  assert.equal(task.localFilesCleaned, true); assert.equal(task.responseFile, undefined);
  mock.mock.restore();
  assert.equal((await clean(client, { taskId: id, scope: 'all', deleteRecord: true })).status, 'cleaned');
});
