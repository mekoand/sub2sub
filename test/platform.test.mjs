import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { codexExecutable } from '../lib/config.mjs';
import { buildWorkCopy } from '../lib/sync.mjs';
import { processLock } from '../lib/lock.mjs';

test('Windows Codex discovery selects the native exe from a path containing spaces', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub Windows 工具-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const previousPath = process.env.PATH;
  t.after(async () => { Object.defineProperty(process, 'platform', platform); process.env.PATH = previousPath; await fs.rm(root, { recursive: true, force: true }); });
  const executable = path.join(root, 'codex.exe');
  await fs.writeFile(executable, '', { mode: 0o700 });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.PATH = `"${root}"`;
  assert.equal(await codexExecutable({}), executable);
  const launcher = path.join(root, 'codex.cmd');
  await fs.writeFile(launcher, '', { mode: 0o700 });
  await assert.rejects(codexExecutable({ provider: { codexPath: launcher } }), /native codex\.exe/);
});

test('native Windows separators allow creation and reuse of a nested complete work copy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub Windows 副本-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Exercise Windows relative-path output with real files on the host OS.
  if (process.platform !== 'win32') {
    const relative = path.relative, separator = path.sep;
    t.mock.method(path, 'relative', (...args) => relative(...args).replaceAll('/', '\\'));
    path.sep = '\\';
    t.after(() => { path.sep = separator; });
  }
  const id = randomUUID();
  const files = [{ path: '目录/input.txt', content: Buffer.from('输入').toString('base64'), executable: false }];
  const changes = { files: [], removed: [], skipped: [] };
  const first = await buildWorkCopy(root, id, undefined, files, changes, ['目录/input.txt']);
  assert.equal(await fs.readFile(path.join(first, 'files/目录/input.txt'), 'utf8'), '输入');
  assert.equal(await buildWorkCopy(root, id, first, undefined, changes, ['目录/input.txt']), first);
});

test('Windows package launches Node directly without requiring a Unix shell', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-package-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'sub2sub'), node = 'C:\\Program Files\\nodejs\\node.exe';
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), target, '--windows-node', node]);
  const { mcpServers } = JSON.parse(await fs.readFile(path.join(target, '.mcp.json'), 'utf8'));
  assert.equal(mcpServers.sub2sub.command, node);
  assert.deepEqual(mcpServers.sub2sub.args, ['./bin/mcp.mjs']);
  assert.ok(mcpServers.sub2sub.env_vars.includes('USERPROFILE'));
});

test('process locks recover an exited owner and remain exclusive', async t => {
  if (process.platform !== 'win32') {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform'), rename = fs.rename;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => { Object.defineProperty(process, 'platform', platform); });
    // MoveFileEx on Windows cannot replace an existing directory, even empty.
    t.mock.method(fs, 'rename', async (source, destination) => {
      let stat;
      try { stat = await fs.stat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isDirectory()) throw Object.assign(new Error('Windows directory destination exists'), { code: 'EPERM' });
      return rename(source, destination);
    });
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-lock-platform-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'lock'); await fs.mkdir(lock);
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'console.log(process.pid)']);
  await fs.writeFile(path.join(lock, `${randomUUID()}.json`), JSON.stringify({ pid: Number(stdout.trim()) }));
  const release = await processLock(lock);
  try { await assert.rejects(processLock(lock), /owns/); }
  finally { await release(); }
  assert.deepEqual(await fs.readdir(root), []);
});
