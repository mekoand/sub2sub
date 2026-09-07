import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { install } from '../scripts/install.mjs';

// Windows runs the native installer smoke test with the actual Codex executable.
test('installer supports fresh install, replacement, repeat install, path refresh and failed update', { skip: process.platform === 'win32' }, async t => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub install 空间-'));
  const environment = { ...process.env };
  t.after(async () => { process.env = environment; await fs.rm(work, { recursive: true, force: true }); });
  const payload = path.join(work, 'payload'), root = path.join(work, 'program');
  await fs.mkdir(path.join(payload, 'plugins'), { recursive: true });
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), path.join(payload, 'plugins/sub2sub')]);
  await fs.mkdir(path.join(payload, 'runtime/bin'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(payload, 'runtime/bin/node'));
  const release = { version: '0.5.0', platform: process.platform, arch: process.arch };
  await fs.writeFile(path.join(payload, 'release.json'), JSON.stringify(release));
  process.env.SUB2SUB_CONFIG = path.join(work, 'config.json');
  const originalConfig = JSON.stringify({ deviceName: 'retained', peers: { existing: { token: 'fixture-only' } }, stateRoot: path.join(work, 'state') });
  await fs.writeFile(process.env.SUB2SUB_CONFIG, originalConfig);
  process.env.SUB2SUB_TEST_CATALOG = path.join(work, 'codex.json');
  await fs.writeFile(process.env.SUB2SUB_TEST_CATALOG, JSON.stringify({ marketplaces: [], installed: [{ name: 'sub2sub', pluginId: 'sub2sub@personal', version: '0.4.3', installed: true, enabled: true }, { name: 'unrelated', pluginId: 'unrelated@personal', installed: true }] }));
  const fake = path.join(work, 'codex-a');
  await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const file = process.env.SUB2SUB_TEST_CATALOG, data = JSON.parse(fs.readFileSync(file)), args = process.argv.slice(2);
if (args.includes('--help') || args[0] === '--version') { console.log('Codex fixture'); process.exit(0); }
if (args[1] === 'marketplace' && args[2] === 'add') data.marketplaces = [{name: 'sub2sub', root: args[3]}];
if (args[1] === 'add') {
  if (process.env.SUB2SUB_TEST_FAIL_INSTALL) { console.error('installation test failure'); process.exit(1); }
  const root = data.marketplaces[0].root;
  const market = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, market.plugins[0].source.path, '.codex-plugin/plugin.json')));
  data.installed = data.installed.filter(p => p.pluginId !== args[2]);
  data.installed.push({name: 'sub2sub', pluginId: args[2], version: manifest.version, installed: true, enabled: true});
}
if (args[1] === 'remove') data.installed = data.installed.filter(p => p.pluginId !== args[2]);
fs.writeFileSync(file, JSON.stringify(data)); console.log(JSON.stringify(data));
`, { mode: 0o755 });
  process.env.SUB2SUB_CODEX = fake;
  const first = await install(payload, root, () => {});
  assert.equal(await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8'), originalConfig);
  const catalog = JSON.parse(await fs.readFile(process.env.SUB2SUB_TEST_CATALOG, 'utf8'));
  assert.deepEqual(catalog.installed.map(p => p.pluginId).sort(), ['sub2sub@sub2sub', 'unrelated@personal']);
  await install(payload, root, () => {});
  const changedPath = path.join(work, 'codex-b'); await fs.copyFile(fake, changedPath);
  process.env.SUB2SUB_CODEX = changedPath;
  const alias = path.join(work, 'payload-alias');
  await fs.symlink(payload, alias);
  await promisify(execFile)(process.execPath, [path.join(alias, 'plugins/sub2sub/scripts/install.mjs'), payload, root]);
  const mcp = JSON.parse(await fs.readFile(path.join(root, 'versions/0.5.0/plugins/sub2sub/.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.sub2sub.env.SUB2SUB_CODEX, changedPath);
  assert.equal(mcp.mcpServers.sub2sub.env.SUB2SUB_INSTALL_HOST, 'codex');
  assert.equal(mcp.mcpServers.sub2sub.env.SUB2SUB_INSTALL_DIR, root);
  assert.equal(mcp.mcpServers.sub2sub.command, first.node);
  const marketplaceFile = path.join(root, '.agents/plugins/marketplace.json');
  const previous = await fs.readFile(marketplaceFile, 'utf8');
  release.version = '0.5.1'; await fs.writeFile(path.join(payload, 'release.json'), JSON.stringify(release));
  process.env.SUB2SUB_TEST_FAIL_INSTALL = '1';
  await assert.rejects(install(payload, root, () => {}), /installation test failure/);
  assert.equal(await fs.readFile(marketplaceFile, 'utf8'), previous);
  assert.equal(await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8'), originalConfig);
  await fs.access(first.node);
  delete process.env.SUB2SUB_TEST_FAIL_INSTALL;
  assert.equal((await install(payload, root, () => {})).version, '0.5.1');
});

test('Claude installer works without local Codex and preserves existing user data', { skip: process.platform === 'win32' }, async t => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub claude 空间-'));
  const environment = { ...process.env };
  t.after(async () => { process.env = environment; await fs.rm(work, { recursive: true, force: true }); });
  const payload = path.join(work, 'payload'), root = path.join(work, 'program');
  await fs.mkdir(path.join(payload, 'plugins'), { recursive: true });
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), path.join(payload, 'plugins/sub2sub')]);
  await fs.mkdir(path.join(payload, 'runtime/bin'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(payload, 'runtime/bin/node'));
  await fs.writeFile(path.join(payload, 'release.json'), JSON.stringify({ version: '0.5.3', platform: process.platform, arch: process.arch }));
  process.env.SUB2SUB_CONFIG = path.join(work, 'config.json');
  const original = JSON.stringify({ peers: { retained: { token: 'fixture-only' } }, stateRoot: path.join(work, 'state') });
  await fs.writeFile(process.env.SUB2SUB_CONFIG, original);
  process.env.SUB2SUB_CODEX = path.join(work, 'codex-not-installed');
  process.env.SUB2SUB_TEST_CLAUDE_CATALOG = path.join(work, 'claude.json');
  await fs.writeFile(process.env.SUB2SUB_TEST_CLAUDE_CATALOG, JSON.stringify({ marketplaces: [], installed: [{ id: 'other@other', scope: 'user', enabled: true }] }));
  const executable = path.join(work, 'claude');
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const file = process.env.SUB2SUB_TEST_CLAUDE_CATALOG, data = JSON.parse(fs.readFileSync(file)), args = process.argv.slice(2);
if (args.includes('--help') || args[0] === '--version') { console.log('Claude fixture'); process.exit(0); }
if (args[1] === 'marketplace' && args[2] === 'add') data.marketplaces.push({name: 'sub2sub', source: 'directory', path: args[3], installLocation: args[3]});
if (['install', 'update'].includes(args[1])) {
  if (process.env.SUB2SUB_TEST_CLAUDE_FAIL) { console.error('Claude installation test failure'); process.exit(1); }
  const root = data.marketplaces.find(m => m.name === 'sub2sub').path;
  const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json')));
  const location = path.join(root, market.plugins[0].source);
  const manifest = JSON.parse(fs.readFileSync(path.join(location, '.claude-plugin/plugin.json')));
  const enabled = data.installed.find(p => p.id === args[2])?.enabled ?? true;
  data.installed = data.installed.filter(p => p.id !== args[2]);
  data.installed.push({id: args[2], scope: 'user', version: manifest.version, enabled, installPath: location});
}
if (args[1] === 'enable') {
  const plugin = data.installed.find(p => p.id === args[2]);
  if (plugin.enabled) { console.error('Plugin is already enabled at user scope'); process.exit(1); }
  plugin.enabled = true;
}
fs.writeFileSync(file, JSON.stringify(data)); console.log(JSON.stringify(args[1] === 'marketplace' ? data.marketplaces : data.installed));
`, { mode: 0o755 });
  process.env.SUB2SUB_CLAUDE = executable;
  await fs.mkdir(path.join(root, '.agents/plugins'), { recursive: true });
  const codexMarketplace = JSON.stringify({ name: 'sub2sub', plugins: ['codex fixture must remain unchanged'] });
  await fs.writeFile(path.join(root, '.agents/plugins/marketplace.json'), codexMarketplace);
  const coreMcp = await fs.readFile(path.join(payload, 'plugins/sub2sub/.mcp.json'), 'utf8');
  const installed = await install(payload, root, () => {}, 'claude');
  assert.equal(installed.host, 'claude');
  assert.equal(await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8'), original);
  const catalog = JSON.parse(await fs.readFile(process.env.SUB2SUB_TEST_CLAUDE_CATALOG, 'utf8'));
  assert.equal(catalog.installed.find(p => p.id === 'sub2sub@sub2sub').enabled, true);
  assert.equal(catalog.installed.find(p => p.id === 'other@other').enabled, true);
  const adapter = catalog.installed.find(p => p.id === 'sub2sub@sub2sub').installPath;
  const mcp = JSON.parse(await fs.readFile(path.join(adapter, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.sub2sub.command, installed.node);
  assert.deepEqual(mcp.mcpServers.sub2sub.args, [path.join(root, 'versions/0.5.3/plugins/sub2sub/bin/mcp.mjs')]);
  assert.equal(mcp.mcpServers.sub2sub.timeout, 1900000);
  assert.equal(mcp.mcpServers.sub2sub.env.SUB2SUB_INSTALL_HOST, 'claude');
  assert.equal(mcp.mcpServers.sub2sub.env.SUB2SUB_INSTALL_DIR, root);
  assert.equal(mcp.mcpServers.sub2sub.env.SUB2SUB_CLAUDE, executable);
  await fs.access(path.join(adapter, 'skills/sub2sub/references/work-copy.md'));
  await fs.access(path.join(adapter, 'docs/install.md'));
  await fs.access(path.join(adapter, 'README.md'));
  await fs.access(path.join(adapter, 'README.zh-CN.md'));
  await fs.access(path.join(adapter, 'CONTRIBUTING.md'));
  assert.equal(await fs.readFile(path.join(root, 'versions/0.5.3/plugins/sub2sub/.mcp.json'), 'utf8'), coreMcp);
  assert.equal(await fs.readFile(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'), codexMarketplace);
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/install.mjs', import.meta.url)), payload, root, 'claude']);
  const disabled = JSON.parse(await fs.readFile(process.env.SUB2SUB_TEST_CLAUDE_CATALOG, 'utf8'));
  disabled.installed.find(p => p.id === 'sub2sub@sub2sub').enabled = false;
  await fs.writeFile(process.env.SUB2SUB_TEST_CLAUDE_CATALOG, JSON.stringify(disabled));
  await install(payload, root, () => {}, 'claude');
  assert.equal(JSON.parse(await fs.readFile(process.env.SUB2SUB_TEST_CLAUDE_CATALOG, 'utf8')).installed.find(p => p.id === 'sub2sub@sub2sub').enabled, true);
  const marketplaceFile = path.join(root, '.claude-plugin/marketplace.json');
  const previous = await fs.readFile(marketplaceFile, 'utf8');
  await fs.writeFile(path.join(payload, 'release.json'), JSON.stringify({ version: '0.5.4', platform: process.platform, arch: process.arch }));
  process.env.SUB2SUB_TEST_CLAUDE_FAIL = '1';
  await assert.rejects(install(payload, root, () => {}, 'claude'), /Claude installation test failure/);
  assert.equal(await fs.readFile(marketplaceFile, 'utf8'), previous);
  assert.equal(await fs.readFile(process.env.SUB2SUB_CONFIG, 'utf8'), original);
  delete process.env.SUB2SUB_TEST_CLAUDE_FAIL;
  assert.equal((await install(payload, root, () => {}, 'claude')).version, '0.5.4');
  assert.equal(await fs.readFile(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'), codexMarketplace);
});
