import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanupPrograms, maintainInstallation } from '../lib/installation.mjs';
import { Config } from '../lib/config.mjs';
import { Sharing, lanRequest } from '../lib/lan.mjs';
import https from 'node:https';
import { openMcp } from './helpers/mcp.mjs';

const exec = promisify(execFile);
const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-upgrade-'));
  const environment = { ...process.env };
  let manager;
  t.after(async () => {
    try { if (manager && await manager.runtime()) await manager.manage('exit'); }
    finally { process.env = environment; await fs.rm(root, { recursive: true, force: true }); }
  });
  const program = path.join(root, 'program');
  await fs.mkdir(path.join(program, '.agents/plugins'), { recursive: true });
  await fs.writeFile(path.join(program, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'sub2sub', plugins: [{ source: { path: `./versions/${version}/plugins/sub2sub` } }] }));
  process.env.SUB2SUB_CODEX = path.join(root, 'codex');
  await fs.writeFile(process.env.SUB2SUB_CODEX, '#!/usr/bin/env node\nconsole.log(JSON.stringify({installed:[{pluginId:"sub2sub@sub2sub",installed:true,version:' + JSON.stringify(version) + '}]}));\n', { mode: 0o755 });
  const release = async number => {
    const directory = path.join(program, 'versions', number);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify({ version: number, platform: process.platform, arch: process.arch }));
    return directory;
  };
  await release(version);
  const store = new Config(path.join(root, 'config.json'));
  await store.update(config => { config.stateRoot = path.join(root, 'data'); config.provider = { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) }; });
  manager = new Sharing(store, path.join(root, 'data'), { independent: true });
  return { root, program, release, manager, store };
}

test('cleanup retains app registrations, live program processes and configured data, then removes only unused releases', { skip: process.platform === 'win32' }, async t => {
  const { program, release, root } = await fixture(t);
  const unused = await release('0.1.0'), occupied = await release('0.2.0'), otherApp = await release('0.3.0'), data = await release('0.4.0');
  await fs.mkdir(path.join(program, '.claude-plugin'));
  await fs.writeFile(path.join(program, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'sub2sub', plugins: [{ source: './versions/0.3.0/claude/sub2sub' }] }));
  process.env.SUB2SUB_CLAUDE = path.join(root, 'claude');
  await fs.writeFile(process.env.SUB2SUB_CLAUDE, '#!/usr/bin/env node\nconsole.log(JSON.stringify([{id:"sub2sub@sub2sub",version:"0.3.0+claude.1"}]));\n', { mode: 0o755 });
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)', occupied], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('exit', resolve));
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await fs.writeFile(path.join(data, 'saved.txt'), 'saved work');
  const result = await cleanupPrograms(program, version, [data]);
  assert.deepEqual(result.removed, ['0.1.0']); assert.deepEqual(result.failed, []);
  assert.equal(result.kept.length, 4);
  await assert.rejects(fs.stat(unused), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(data, 'saved.txt'), 'utf8'), 'saved work');
  await fs.access(otherApp); await fs.access(occupied);
  child.kill(); await closed;
  assert.deepEqual((await cleanupPrograms(program, version, [data])).removed, ['0.2.0']);
});

test('unknown app references and deletion failures retain the release and are reported for retry', { skip: process.platform === 'win32' }, async t => {
  const { program, release } = await fixture(t);
  const old = await release('0.1.0');
  await fs.writeFile(process.env.SUB2SUB_CODEX, '#!/usr/bin/env node\nconsole.log("invalid registration");\n');
  const unknown = await cleanupPrograms(program, version);
  assert.deepEqual(unknown.removed, []); assert.equal(unknown.failed.length, 1); await fs.access(old);
  await fs.writeFile(process.env.SUB2SUB_CODEX, '#!/usr/bin/env node\nconsole.log(JSON.stringify({installed:[]}));\n');
  const rm = fs.rm.bind(fs);
  const failure = t.mock.method(fs, 'rm', (file, ...options) => { if (file === old) throw new Error('fixture removal denied'); return rm(file, ...options); });
  const denied = await cleanupPrograms(program, version);
  assert.match(denied.failed[0].reason, /removal denied/); await fs.access(old);
  failure.mock.restore();
  assert.deepEqual((await cleanupPrograms(program, version)).removed, ['0.1.0']);
});

test('missing, busy and legacy nodes are not launched or stopped by installation maintenance', async t => {
  const { program, manager } = await fixture(t);
  assert.equal((await maintainInstallation(manager, program, version)).node.status, 'not_running');
  assert.equal(await manager.runtime(), null);
  await manager.manage('start', { address: '127.0.0.1', port: 0 });
  const before = await manager.machineStatus();
  const original = manager.machineStatus.bind(manager);
  for (const extra of [{ activeTask: { taskId: 'active' } }, { upgradeSafeExit: undefined }]) {
    const mock = t.mock.method(manager, 'machineStatus', async () => ({ ...await original(), ...extra }));
    assert.equal((await maintainInstallation(manager, program, version)).node.status, 'deferred');
    mock.mock.restore();
    assert.equal((await original()).ownerPid, before.ownerPid);
  }
});

for (const mode of ['sharing', 'paused', 'networkOnly']) test(`upgrade preserves ${mode}, packaged runtime, identity and task files`, { skip: process.platform === 'win32' }, async t => {
  const { program, manager, store } = await fixture(t);
  const directory = path.join(program, 'versions', version), plugin = path.join(directory, 'plugins/sub2sub');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await exec(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), plugin]);
  await fs.mkdir(path.join(directory, 'runtime/bin'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(directory, 'runtime/bin/node'));
  await manager.launch({ address: '127.0.0.1', port: 0, networkOnly: mode === 'networkOnly', paused: mode !== 'sharing' });
  const before = await manager.machineStatus();
  const identity = await fs.readFile(path.join(manager.root, 'identity.json'));
  const config = await fs.readFile(store.file);
  await fs.writeFile(path.join(manager.root, 'saved-fixture.txt'), 'untouched');
  const result = await maintainInstallation(manager, program, version);
  assert.equal(result.node.status, 'switched', JSON.stringify(result));
  assert.equal(result.node.node.status, mode === 'sharing' ? 'sharing' : 'stopped');
  assert.equal(result.node.node.networkOnly, mode === 'networkOnly');
  assert.notEqual(result.node.node.ownerPid, before.ownerPid);
  assert.equal(result.node.node.runtimePath, await fs.realpath(path.join(directory, 'runtime/bin/node')));
  assert.deepEqual(await fs.readFile(path.join(manager.root, 'identity.json')), identity);
  assert.deepEqual(await fs.readFile(store.file), config);
  assert.equal(await fs.readFile(path.join(manager.root, 'saved-fixture.txt'), 'utf8'), 'untouched');
  assert.equal((await maintainInstallation(manager, program, version)).node.status, 'current');
  await manager.manage('start');
  assert.equal((await manager.machineStatus()).status, 'sharing');
});

for (const route of ['remote', 'local-forward']) test(`safe exit rejects a partial ${route} upload before model admission`, async t => {
  const { manager } = await fixture(t);
  const invitation = (await manager.manage('pair', { address: '127.0.0.1', port: 0 })).invitation;
  const { invitation: decodeInvitation } = await import('../lib/lan.mjs');
  const invite = decodeInvitation(invitation);
  const pair = await lanRequest(invite, '/pair', { secret: invite.secret, name: 'fixture' });
  const peer = route === 'local-forward' ? await manager.runtime() : { ...invite, token: pair.token };
  const request = https.request({ hostname: peer.host, port: peer.port, path: route === 'local-forward' ? '/local' : '/rpc', method: 'POST', rejectUnauthorized: false, headers: { Authorization: `Bearer ${peer.token}`, 'Content-Type': 'application/json' } });
  request.on('error', () => {}); request.write('{"action":"run",');
  t.after(() => request.destroy());
  // Wait until authentication has completed by probing the idle exit gate.
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(manager.manage('exit'), /active turn or transfer/);
  assert.equal((await manager.machineStatus()).status, 'sharing');
  request.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
});


test('plugin startup cleans unreferenced programs and reports its result without starting a node', { skip: process.platform === 'win32' }, async t => {
  const { program, release, store, manager } = await fixture(t);
  const old = await release('0.1.0');
  const mcp = await openMcp(store.file, { env: { SUB2SUB_INSTALL_DIR: program } });
  try {
    const status = await mcp.tool('sharing_status');
    assert.deepEqual(status.programCleanup.removed, ['0.1.0']);
    assert.deepEqual(status.programCleanup.failed, []);
    assert.equal(status.status, 'stopped');
    assert.equal(await manager.runtime(), null);
    await assert.rejects(fs.stat(old), { code: 'ENOENT' });
  } finally { await mcp.close(); }
});

test('replacement startup failure is reported without deleting task data or starting the old node again', { skip: process.platform === 'win32' }, async t => {
  const { program, manager } = await fixture(t);
  const directory = path.join(program, 'versions', version);
  await fs.mkdir(path.join(directory, 'runtime/bin'), { recursive: true });
  await fs.mkdir(path.join(directory, 'plugins/sub2sub/bin'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(directory, 'runtime/bin/node'));
  await fs.writeFile(path.join(directory, 'plugins/sub2sub/bin/share.mjs'), 'throw new Error("fixture replacement failure");');
  await manager.manage('start', { address: '127.0.0.1', port: 0 });
  await fs.writeFile(path.join(manager.root, 'saved-fixture.txt'), 'untouched');
  const result = await maintainInstallation(manager, program, version);
  assert.equal(result.node.status, 'failed');
  assert.match(result.node.reason, /exited during startup/);
  assert.equal(await manager.runtime(), null);
  assert.equal(await fs.readFile(path.join(manager.root, 'saved-fixture.txt'), 'utf8'), 'untouched');
});
