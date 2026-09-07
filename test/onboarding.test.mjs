import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../lib/config.mjs';
import { Client } from '../lib/client.mjs';
import { openMcp } from './helpers/mcp.mjs';

async function setup(t, saved = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-onboarding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const stateRoot = path.join(root, 'state');
  await fs.writeFile(configPath, JSON.stringify({ stateRoot, peers: {}, ...saved }));
  const store = new Config(configPath);
  const client = new Client(await store.read(), stateRoot, store);
  t.after(() => client.close());
  return { root, configPath, stateRoot, client, store };
}

test('first-use summary shows both roles and advanced defaults without requiring an execution tool', async t => {
  const { client } = await setup(t);
  const guide = await client.call('onboarding', {});
  assert.equal(guide.status, 'pending');
  assert.equal(guide.confirmationRequired, true);
  assert.deepEqual(guide.settings.caller.execution.codex, { model: 'gpt-5.6-luna', reasoningEffort: 'max' });
  assert.deepEqual(guide.settings.caller.execution.claude, { model: null, reasoningEffort: null });
  assert.equal(guide.settings.caller.modelAvailability, 'unverified');
  assert.deepEqual(guide.settings.caller.limits, { inputBytes: 20971520, inputFiles: 2000, resultBytes: 20971520, resultFiles: 2000 });
  assert.equal(guide.settings.provider.harness, 'codex');
  assert.deepEqual(guide.settings.provider.allowedModels, { codex: 'all', claude: 'all' });
  assert.equal(guide.settings.provider.retentionDays, 7);
  assert.deepEqual(guide.settings.provider.network, { address: 'auto-select', port: 47631 });
  assert.deepEqual(guide.settings.provider.limits, guide.settings.caller.limits);
  assert.deepEqual(guide.connections, []);
  assert.equal(guide.sharing.status, 'stopped');
  assert.match(guide.nextStep, /confirm/);
});

test('interrupted guide preserves changed settings and confirmation, skip and reopen survive new conversations', async t => {
  const { client, store, stateRoot } = await setup(t);
  await client.call('onboarding', {});
  await client.call('caller_settings', { model: 'gpt-5.6-sol', reasoningEffort: 'high', inputFiles: 42 });
  const resumed = new Client(await store.read(), stateRoot, store);
  t.after(() => resumed.close());
  const pending = await resumed.call('onboarding', {});
  assert.equal(pending.status, 'pending');
  assert.equal(pending.settings.caller.execution.codex.model, 'gpt-5.6-sol');
  assert.equal(pending.settings.caller.limits.inputFiles, 42);
  assert.equal((await resumed.call('onboarding', { action: 'confirm' })).status, 'confirmed');
  assert.equal((await client.call('onboarding', {})).confirmationRequired, false);
  const reopened = await client.call('onboarding', { action: 'reopen' });
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.settings.caller.execution.codex.model, 'gpt-5.6-sol');
  assert.equal((await resumed.call('onboarding', { action: 'skip' })).status, 'skipped');
  assert.equal((await client.call('onboarding', {})).status, 'skipped');
  await assert.rejects(client.call('onboarding', { action: 'invalid' }), /onboarding action/);
});

test('upgrading users with settings, connections or task and sharing records are recognized without a marker', async t => {
  for (const saved of [
    { caller: { model: 'gpt-5.6-sol' } },
    { provider: { model: 'gpt-5.6-sol' } },
    { deviceName: 'Work device' },
    { peers: { office: { transport: 'lan', token: 'DO-NOT-EXPOSE', transferAuthorization: { scope: 'task-files' } } } }
  ]) {
    const { client } = await setup(t, saved);
    const guide = await client.call('onboarding', {});
    assert.equal(guide.status, 'existing');
    assert.equal(guide.confirmationRequired, false);
    assert.doesNotMatch(JSON.stringify(guide), /DO-NOT-EXPOSE/);
  }
  for (const folder of ['tasks', 'sharing']) {
    const { client, stateRoot } = await setup(t);
    await fs.mkdir(path.join(stateRoot, folder), { recursive: true });
    await fs.writeFile(path.join(stateRoot, folder, 'old-record.json'), '{}');
    assert.equal((await client.call('onboarding', {})).status, 'existing');
  }
});

test('an explicit first request waits for confirmation and can resume with its original arguments', async t => {
  const { client, root } = await setup(t);
  const workspace = path.join(root, 'input');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'brief.txt'), 'task input');
  const request = { workspace, paths: ['brief.txt'] };
  const blocked = await client.call('prepare_work_copy', request);
  assert.equal(blocked.status, 'onboarding_required');
  assert.equal(blocked.requestedAction, 'prepare_work_copy');
  assert.equal(blocked.onboarding.confirmationRequired, true);
  assert.equal(blocked.snapshotId, undefined);
  await client.call('onboarding', { action: 'confirm' });
  const prepared = await client.call('prepare_work_copy', request);
  assert.ok(prepared.snapshotId);
});

test('the complete summary includes configured advanced values and safe connection state without credentials', async t => {
  const { client, stateRoot, configPath } = await setup(t, {
    deviceName: 'Lab', caller: { resultFiles: 99, harnesses: { claude: { model: 'claude-sonnet-4-6', reasoningEffort: 'high' } } },
    provider: { address: '100.101.102.103', port: 4444, codexPath: '/synthetic/codex', claudePath: '/synthetic/claude', harness: 'claude', retentionDays: 12, inputBytes: 123456, harnesses: { codex: { allowedModels: ['gpt-5.6-sol'] } }, pairings: { demo: { name: 'Other device', token: 'PRIVATE-PAIR-TOKEN' } } },
    peers: { office: { transport: 'lan', host: '192.168.1.2', port: 5555, token: 'PRIVATE-PEER-TOKEN', invitation: 'PRIVATE-INVITATION', transferAuthorization: { scope: 'task-files' } } }
  });
  const guide = await client.call('onboarding', { action: 'reopen' });
  assert.equal(guide.settings.deviceName, 'Lab');
  assert.equal(guide.settings.caller.limits.resultFiles, 99);
  assert.deepEqual(guide.settings.caller.execution.claude, { model: 'claude-sonnet-4-6', reasoningEffort: 'high' });
  assert.equal(guide.settings.provider.harness, 'claude');
  assert.deepEqual(guide.settings.provider.allowedModels.codex, ['gpt-5.6-sol']);
  assert.equal(guide.settings.provider.limits.inputBytes, 123456);
  assert.equal(guide.settings.provider.retentionDays, 12);
  assert.deepEqual(guide.settings.provider.network, { address: '100.101.102.103', port: 4444 });
  assert.deepEqual(guide.settings.advanced, { configPath, stateRoot, executionPaths: { codex: '/synthetic/codex', claude: '/synthetic/claude' }, supportedLimits: { bytes: 67108864, files: 10000 } });
  assert.deepEqual(JSON.parse(JSON.stringify(guide.connections)), [{ name: 'office', transport: 'lan', host: '192.168.1.2', port: 5555, status: 'unchecked', transferAuthorization: { scope: 'task-files' } }]);
  assert.equal(guide.pairings[0].name, 'Other device');
  assert.doesNotMatch(JSON.stringify(guide), /PRIVATE-/);
});

test('MCP exposes the guide and defers sharing, pairing and delegation until a recorded user decision', async t => {
  const { configPath } = await setup(t);
  const mcp = await openMcp(configPath, { env: { SUB2SUB_CODEX: '/synthetic/unavailable-codex', SUB2SUB_CLAUDE: '/synthetic/unavailable-claude' } });
  t.after(() => mcp.close());
  const catalog = await mcp.request('tools/list');
  assert.ok(catalog.tools.some(tool => tool.name === 'onboarding'));
  for (const [name, args] of [
    ['start_sharing', {}], ['create_pairing', {}],
    ['pair_peer', { peer: 'office', invitation: 'private-invalid-invitation', allowTaskFiles: true }],
    ['start_task', { peer: 'office', snapshotId: 'not-created', prompt: 'Original task' }],
    ['continue_task', { taskId: 'not-created', prompt: 'Original follow-up' }]
  ]) {
    const blocked = await mcp.tool(name, args);
    assert.equal(blocked.status, 'onboarding_required');
    assert.equal(blocked.onboarding.sharing.status, 'stopped');
    assert.doesNotMatch(JSON.stringify(blocked), /private-invalid-invitation|Original task|Original follow-up/);
  }
  await mcp.tool('caller_settings', { inputFiles: 33 });
  assert.equal((await mcp.tool('onboarding')).status, 'pending');
  assert.equal((await mcp.tool('onboarding', { action: 'skip' })).status, 'skipped');
  const peers = await mcp.tool('list_peers', { check: false });
  assert.deepEqual(peers.peers, []);
  const nextConversation = await openMcp(configPath);
  t.after(() => nextConversation.close());
  const restored = await nextConversation.tool('onboarding');
  assert.equal(restored.confirmationRequired, false);
  assert.equal(restored.settings.caller.limits.inputFiles, 33);
  await assert.rejects(nextConversation.tool('onboarding', { action: 'guess' }), /Invalid action/);
});
