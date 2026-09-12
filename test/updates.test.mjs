import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../lib/client.mjs';

async function fixture(t) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-update-'));
  const environment = { ...process.env }, fetch = globalThis.fetch;
  t.after(async () => { process.env = environment; globalThis.fetch = fetch; await fs.rm(work, { recursive: true, force: true }); });
  process.env.SUB2SUB_CONFIG = path.join(work, 'config.json');
  process.env.SUB2SUB_INSTALL_HOST = 'codex';
  process.env.SUB2SUB_INSTALL_DIR = path.join(work, 'program');
  process.env.SUB2SUB_CODEX = path.join(work, 'codex');
  process.env.SUB2SUB_TEST_CATALOG = path.join(work, 'catalog.json');
  await fs.writeFile(process.env.SUB2SUB_CONFIG, JSON.stringify({ stateRoot: path.join(work, 'state'), peers: {} }));
  await fs.writeFile(process.env.SUB2SUB_TEST_CATALOG, JSON.stringify({ marketplaces: [{ name: 'sub2sub', root: process.env.SUB2SUB_INSTALL_DIR }], installed: [{ pluginId: 'sub2sub@sub2sub', installed: true, enabled: true, version: '0.5.2+codex.123' }] }));
  await fs.writeFile(process.env.SUB2SUB_CODEX, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
if (!process.argv.includes('list')) throw Error('Check must not mutate host registration');
console.log(fs.readFileSync(process.env.SUB2SUB_TEST_CATALOG, 'utf8'));
`, { mode: 0o755 });
  globalThis.fetch = async url => { assert.equal(url, 'https://api.github.com/repos/mekoand/sub2sub/releases/latest'); return new Response(JSON.stringify({ tag_name: 'v0.8.1', draft: false, prerelease: false, html_url: 'https://github.com/mekoand/sub2sub/releases/tag/v0.8.1' })); };
  const client = await Client.load(); await client.initialize(); t.after(() => client.close());
  return { work, client };
}

test('check reports session, registered installation, node and stable release without writing', async t => {
  const { client, work } = await fixture(t);
  const config = await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8');
  const catalog = await fs.readFile(process.env.SUB2SUB_TEST_CATALOG, 'utf8');
  const result = await client.call('update_plugin', { action: 'check' });
  assert.equal(result.status, 'update_available');
  assert.equal(result.sessionVersion, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version);
  assert.equal(result.installed.version, '0.5.2+codex.123');
  assert.equal(result.installed.host, 'codex');
  assert.equal(result.installed.root, path.join(work, 'program'));
  assert.equal(result.node.status, 'stopped');
  assert.equal(result.node.version, null);
  assert.equal(result.latest.version, '0.8.1');
  assert.equal(await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8'), config);
  assert.equal(await fs.readFile(process.env.SUB2SUB_TEST_CATALOG, 'utf8'), catalog);
  assert.deepEqual(await fs.readdir(process.env.SUB2SUB_INSTALL_DIR).catch(e => e.code), 'ENOENT');
});

test('upgrade defers for uncertain caller work and preserves its task and saved files', async t => {
  const { client } = await fixture(t);
  const taskFile = path.join(client.stateRoot, 'tasks/00000000-0000-4000-8000-000000000001.json');
  const task = JSON.stringify({ peer: 'retained', deliveryPending: true, endedAt: '2026-09-01T00:00:00Z' });
  await fs.writeFile(taskFile, task);
  const result = await client.call('update_plugin', { action: 'install' });
  assert.equal(result.status, 'deferred');
  assert.match(result.reason, /caller|collect_result/);
  assert.equal(await fs.readFile(taskFile, 'utf8'), task);
});

test('explicit upgrade uses bundled release installer for the registered host/root and verifies the host', { skip: process.platform !== 'darwin' }, async t => {
  const { client, work } = await fixture(t);
  const bin = path.join(work, 'bin'); await fs.mkdir(bin);
  // External curl/tar boundaries supply an extracted, synthetic release. The
  // bootstrap itself runs unchanged, including SHA256SUMS verification.
  await fs.writeFile(path.join(bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const args = process.argv.slice(2), target = args[args.indexOf('-o') + 1];
if (!args.some(a => a.includes('/download/v0.8.1/'))) throw Error('Unexpected release');
fs.writeFileSync(target, target.endsWith('SHA256SUMS') ? crypto.createHash('sha256').update('fixture').digest('hex') + '  sub2sub-darwin-${process.arch}.tar.gz\\n' : 'fixture');
`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'tar'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = args[args.indexOf('-C') + 1];
fs.mkdirSync(path.join(root, 'runtime/bin'), { recursive: true });
fs.mkdirSync(path.join(root, 'plugins/sub2sub/scripts'), { recursive: true });
fs.symlinkSync(process.execPath, path.join(root, 'runtime/bin/node'));
fs.writeFileSync(path.join(root, 'plugins/sub2sub/scripts/install.mjs'), \`import fs from 'node:fs';
if (process.argv[3] !== process.env.SUB2SUB_INSTALL_DIR || process.argv[4] !== 'codex') throw Error('Wrong installation');
const data = JSON.parse(fs.readFileSync(process.env.SUB2SUB_TEST_CATALOG));
data.installed[0].version = '0.8.1+codex.456';
fs.writeFileSync(process.env.SUB2SUB_TEST_CATALOG, JSON.stringify(data));
\`);
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const config = await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8');
  await fs.writeFile(path.join(client.stateRoot, 'results/keep.txt'), 'saved result');
  const result = await client.call('update_plugin', { action: 'install' });
  assert.equal(result.status, 'installed');
  assert.equal(result.installed.version, '0.8.1+codex.456');
  assert.equal(result.sessionVersion, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version);
  assert.match(result.nextStep, /fully quit.*reopen.*Codex desktop/i);
  assert.match(result.nextStep, /window.*conversation.*not sufficient/i);
  assert.equal(await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8'), config);
  assert.equal(await fs.readFile(path.join(client.stateRoot, 'results/keep.txt'), 'utf8'), 'saved result');
});

test('uncertain sharing, unknown host/root and source/newer versions never install', async t => {
  const { client } = await fixture(t);
  await fs.mkdir(path.join(client.stateRoot, 'sharing/listener'), { recursive: true });
  const uncertain = await client.call('update_plugin', { action: 'install' });
  assert.equal(uncertain.status, 'deferred');
  assert.match(uncertain.reason, /Node work is active or uncertain/);
  await fs.rm(path.join(client.stateRoot, 'sharing/listener'), { recursive: true });
  delete process.env.SUB2SUB_INSTALL_HOST;
  const unknown = await client.call('update_plugin', { action: 'install' });
  assert.equal(unknown.status, 'deferred');
  assert.match(unknown.reason, /host is unknown/);
  process.env.SUB2SUB_INSTALL_HOST = 'codex';
  await assert.rejects(client.call('update_plugin', { action: 'install', host: 'claude' }), /differs from the current session host/);
  const catalog = JSON.parse(await fs.readFile(process.env.SUB2SUB_TEST_CATALOG));
  for (const [version, expected] of [['0.8.1+codex.999', 'current'], ['0.9.0+codex.999', 'newer_installed'], ['0.9.0-rc.1', 'deferred']]) {
    catalog.installed[0].version = version;
    await fs.writeFile(process.env.SUB2SUB_TEST_CATALOG, JSON.stringify(catalog));
    assert.equal((await client.call('update_plugin', { action: 'install' })).status, expected);
  }
  process.env.SUB2SUB_INSTALL_DIR += '-another-root';
  const mismatched = await client.call('update_plugin', { action: 'install' });
  assert.equal(mismatched.status, 'deferred');
  assert.match(mismatched.reason, /registration differs/);
});

test('release/network failures never become a successful check or installation', async t => {
  const { client, work } = await fixture(t);
  globalThis.fetch = async () => new Response('rate limited', { status: 403 });
  await assert.rejects(client.call('update_plugin', { action: 'install' }), /Update check failed: GitHub HTTP 403/);
  globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: 'v0.8.1', draft: false, prerelease: true }));
  await assert.rejects(client.call('update_plugin', { action: 'install' }), /published stable release/);
  if (process.platform !== 'darwin') return;
  globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: 'v0.8.1', draft: false, prerelease: false }));
  const bin = path.join(work, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'curl'), '#!/bin/sh\necho "download fixture failed" >&2\nexit 22\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  await assert.rejects(client.call('update_plugin', { action: 'install' }), /Release download\/installation failed: download fixture failed/);
  const catalog = JSON.parse(await fs.readFile(process.env.SUB2SUB_TEST_CATALOG));
  assert.equal(catalog.installed[0].version, '0.5.2+codex.123');
});

test('a first update check/upgrade does not require caller task directories or use provider executable settings', async t => {
  const { work, client } = await fixture(t);
  await fs.rm(client.stateRoot, { recursive: true });
  client.config.provider = { codexPath: path.join(work, 'provider-codex-not-management') };
  const checked = await client.call('update_plugin', { action: 'check' });
  assert.equal(checked.installed.status, 'registered');
  if (process.platform !== 'darwin') return;
  const bin = path.join(work, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'curl'), '#!/bin/sh\necho "reached first-use release download" >&2\nexit 22\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  await assert.rejects(client.call('update_plugin', { action: 'install' }), /reached first-use release download/);
  await assert.rejects(fs.stat(client.stateRoot), { code: 'ENOENT' });
});

test('active provider records defer even when the listener is stopped', async t => {
  const { client } = await fixture(t);
  const directory = path.join(client.stateRoot, 'sharing/tasks/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002');
  await fs.mkdir(directory, { recursive: true });
  const state = JSON.stringify({ status: 'running', revision: 1 });
  await fs.writeFile(path.join(directory, 'state.json'), state);
  const result = await client.call('update_plugin', { action: 'install' });
  assert.equal(result.status, 'deferred');
  assert.match(result.reason, /Provider task .*running/);
  assert.equal(await fs.readFile(path.join(directory, 'state.json'), 'utf8'), state);
});
