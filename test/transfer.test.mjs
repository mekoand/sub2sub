import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../lib/client.mjs';
import { Config } from '../lib/config.mjs';

test('caller settings default to unlimited and preserve explicit limits until reset', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-transfer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Config(path.join(root, 'config.json'));
  await store.update(c => { c.onboarding = { status: 'confirmed' }; });
  const client = new Client(await store.read(), path.join(root, 'state'), store);
  assert.deepEqual((await client.call('caller_settings', {})).advanced,
    { inputBytes: null, inputFiles: null, resultBytes: null, resultFiles: null });
  let settings = await client.call('caller_settings', { inputBytes: 1024 ** 3, inputFiles: 20001 });
  assert.equal(settings.advanced.inputBytes, 1024 ** 3);
  settings = await client.call('caller_settings', { resultFiles: 3 });
  assert.equal(settings.advanced.inputFiles, 20001);
  settings = await client.call('caller_settings', { inputBytes: null, inputFiles: null });
  assert.equal(settings.advanced.inputBytes, null);
  assert.equal(settings.advanced.resultFiles, 3);
});

test('large input is frozen on disk and can be prepared above the old hard limit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-large-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const handle = await fs.open(path.join(source, 'large.bin'), 'w');
  await handle.truncate(65 * 1024 * 1024); await handle.close();
  const client = new Client({}, path.join(root, 'state'));
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['large.bin'] });
  assert.equal(copy.bytes, 65 * 1024 * 1024);
  assert.match(copy.warning, /非局域网/);
  const snapshotPath = path.join(root, 'state/snapshots', copy.snapshotId + '.json');
  assert.ok((await fs.stat(snapshotPath)).isDirectory(), 'large snapshots keep metadata and file content separately');
  await fs.writeFile(path.join(source, 'large.bin'), 'source changed');
  const { readJson } = await import('../lib/files.mjs');
  const frozen = await readJson(snapshotPath);
  assert.equal((await fs.stat(frozen.files[0].source)).size, 65 * 1024 * 1024);
});

test('large files and more than 10,000 paths survive upload, collection, deletion and restoration', { timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-roundtrip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const handle = await fs.open(path.join(source, 'large.bin'), 'w');
  await handle.truncate(65 * 1024 * 1024); await handle.close();
  for (let i = 0; i < 10001; i++) await fs.writeFile(path.join(source, `small-${i}.txt`), 'x');
  const fixture = new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname;
  const client = new Client({ peers: { demo: { transport: 'local', taskRoot: path.join(root, 'provider'), codexPath: fixture } } }, path.join(root, 'state'));
  const copy = await client.call('prepare_work_copy', { workspace: source, paths: ['large.bin', ...Array.from({ length: 10001 }, (_, i) => `small-${i}.txt`)] });
  assert.equal(copy.fileCount, 10002);
  const progress = [];
  const task = await client.call('start_task', { peer: 'demo', snapshotId: copy.snapshotId, prompt: 'large round trip' }, text => progress.push(text));
  assert.ok(progress.some(text => /非局域网/.test(text)));
  const work = path.join(root, 'provider', task.taskId, 'work');
  for (let i = 0; i < 10001; i++) await fs.writeFile(path.join(work, `small-${i}.txt`), 'changed');
  await fs.copyFile(path.join(source, 'large.bin'), path.join(work, 'large-output.bin'));
  const output = await client.call('collect_result', { taskId: task.taskId }, text => progress.push(text));
  assert.ok(output.changed.length > 10000);
  assert.equal((await fs.stat(path.join(output.workCopyDirectory, 'large-output.bin'))).size, 65 * 1024 * 1024);
  await client.call('finish_task', { taskId: task.taskId, cleanup: 'workcopy' });
  await client.call('continue_task', { taskId: task.taskId, prompt: 'restored follow-up' });
  for (let i = 0; i < 10001; i++) await fs.rm(path.join(work, `small-${i}.txt`));
  const removed = await client.call('collect_result', { taskId: task.taskId });
  assert.equal(removed.removed.length, 10001);
  assert.equal((await fs.stat(path.join(removed.workCopyDirectory, 'large-output.bin'))).size, 65 * 1024 * 1024);
  await client.call('finish_task', { taskId: task.taskId, cleanup: 'records' });
});

test('stream framing rejects truncation, changed content and remote disk references', async t => {
  const { PassThrough, Readable } = await import('node:stream');
  const { writeMessage, readMessages, releaseReceived } = await import('../lib/transfer.mjs');
  const { createHash } = await import('node:crypto');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-wire-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'payload'); await fs.writeFile(source, '文件内容');
  const file = { path: '中文.txt', source, size: 12, hash: createHash('sha256').update('文件内容').digest('hex'), executable: false };
  const io = new PassThrough(); const chunks = [];
  const collecting = (async () => { for await (const chunk of io) chunks.push(chunk); })();
  await writeMessage(io, { snapshot: { files: [file] } }); io.end(); await collecting;
  const wire = Buffer.concat(chunks).toString();
  assert.ok(!wire.includes(source), 'sender disk location is private');
  const decode = async text => { const out = []; for await (const value of readMessages(Readable.from([text]))) out.push(value); return out; };
  const [result] = await decode(wire);
  assert.equal(await fs.readFile(result.snapshot.files[0].source, 'utf8'), '文件内容');
  await releaseReceived(result);
  await assert.rejects(decode(wire.replace('["fileEnd"]\n', '')), /Incomplete/);
  await assert.rejects(decode(wire.replace(Buffer.from('文件内容').toString('base64'), Buffer.from('错误内容').toString('base64'))), /corrupt/);
  const fake = '["message"]\n["object"]\n["key","path"]\n["value","escape"]\n["key","source"]\n["value","/private/secret"]\n["end"]\n["messageEnd"]\n';
  await assert.rejects(decode(fake), /Remote file references/);
  await assert.rejects(async () => { for await (const value of readMessages(Readable.from([wire]), { maxBytes: 11 })) await releaseReceived(value); }, /limit/);
});

test('64 MiB is a strict notice threshold and unlimited never overrides a finite peer limit', async () => {
  const { transferWarning, effectiveLimits } = await import('../lib/limits.mjs');
  assert.equal(transferWarning(67108863), undefined);
  assert.equal(transferWarning(67108864), undefined);
  assert.match(transferWarning(67108865), /Continuing automatically/);
  assert.equal(effectiveLimits({ inputBytes: null }, { inputBytes: 7 }).inputBytes, 7);
  assert.equal(effectiveLimits({ inputBytes: 7 }, { inputBytes: null }).inputBytes, 7);
  assert.equal(effectiveLimits({ inputBytes: 7 }, { inputBytes: 9 }).inputBytes, 7);
});

test('legacy inline snapshots stream in bounded chunks and closed writers reject', async () => {
  const { PassThrough, Writable } = await import('node:stream');
  const { writeMessage, readMessages, releaseReceived } = await import('../lib/transfer.mjs');
  const content = Buffer.alloc(1024 * 1024, 42);
  const io = new PassThrough();
  const receive = (async () => {
    for await (const result of readMessages(io)) {
      try { assert.deepEqual(await fs.readFile(result.files[0].source), content); }
      finally { await releaseReceived(result); }
    }
  })();
  try { await writeMessage(io, { files: [{ path: 'old.bin', content: content.toString('base64'), executable: false }] }); }
  finally { io.end(); await receive.catch(() => {}); }
  await receive;
  const closing = new Writable({ highWaterMark: 1, write() { setImmediate(() => this.destroy()); } });
  await assert.rejects(Promise.race([
    writeMessage(closing, { files: [] }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Writer hung')), 500); timer.unref(); }),
  ]), /connection closed/);
  assert.equal(closing.listenerCount('drain'), 0);
});

test('small unauthenticated request endpoints refuse streaming bodies and oversized JSON', async () => {
  const { Readable } = await import('node:stream');
  const { readRequest } = await import('../lib/transfer.mjs');
  const framed = '["message"]\n["object"]\n["end"]\n["messageEnd"]\n';
  await assert.rejects(readRequest(Readable.from([framed]), { streaming: false, legacyBytes: 2048 }), /protocol/);
  await assert.rejects(readRequest(Readable.from([JSON.stringify({ secret: 'x'.repeat(2048) })]), { streaming: false, legacyBytes: 2048 }), /too large/);
});

test('old prepared snapshots remain usable and restoring retains the accepted input limit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-legacy-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { randomUUID } = await import('node:crypto');
  const { writeJson } = await import('../lib/files.mjs');
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const content = Buffer.alloc(1024 * 1024, 42); await fs.writeFile(path.join(source, 'input.bin'), content);
  const snapshotId = randomUUID();
  await fs.mkdir(path.join(root, 'state/snapshots'), { recursive: true });
  await writeJson(path.join(root, 'state/snapshots', snapshotId + '.json'), { root: source, files: [{ path: 'input.bin', content: content.toString('base64'), executable: false }] });
  const config = { caller: { inputBytes: content.length }, peers: { demo: { transport: 'local', taskRoot: path.join(root, 'provider'), codexPath: new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname } } };
  const client = new Client(config, path.join(root, 'state'));
  const task = await client.call('start_task', { peer: 'demo', snapshotId, prompt: 'legacy input' });
  assert.deepEqual(await fs.readFile(path.join(root, 'provider', task.taskId, 'work/input.bin')), content);
  await client.call('collect_result', { taskId: task.taskId });
  await client.call('finish_task', { taskId: task.taskId, cleanup: 'workcopy' });
  config.caller.inputBytes = null;
  await assert.rejects(client.call('continue_task', { taskId: task.taskId, prompt: 'must not run' }), /limit/);
  const { providerRequest } = await import('../lib/provider.mjs');
  await assert.rejects(providerRequest({ action: 'restore', protocol: 3, taskId: task.taskId, revision: 1, prompt: 'must not run',
    snapshot: { files: [{ path: 'input.bin', content: Buffer.alloc(content.length + 1).toString('base64'), executable: false }] }, limits: {} },
    { root: path.join(root, 'provider') }), /limit/);
});

test('failed scans remove only their own frozen files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-scan-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { collectChanges } = await import('../lib/files.mjs');
  const work = path.join(root, 'work'), storage = path.join(root, 'scan');
  await fs.mkdir(work); await fs.mkdir(storage);
  await fs.writeFile(path.join(work, 'result'), 'large output');
  await fs.writeFile(path.join(storage, 'pending-owned'), 'keep');
  for (let i = 0; i < 2; i++) await assert.rejects(collectChanges(work, [], { storage, maxBytes: 1 }), /limit/);
  assert.deepEqual(await fs.readdir(storage), ['pending-owned']);
});
