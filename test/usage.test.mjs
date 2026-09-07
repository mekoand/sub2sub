import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMcp } from './helpers/mcp.mjs';
import { stopTestSharing } from './helpers/sharing.mjs';
import { Client } from '../lib/client.mjs';

test('quota uses the execution node account, reads fresh windows, and never starts a task', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-usage-'));
  const config = path.join(root, 'config.json'), callerConfig = path.join(root, 'caller.json');
  const quotaFile = path.join(root, 'quota.json'), callsFile = path.join(root, 'reads.jsonl');
  await fs.writeFile(config, JSON.stringify({ stateRoot: path.join(root, 'owner'), provider: { codexPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) } }));
  await fs.writeFile(callerConfig, JSON.stringify({ stateRoot: path.join(root, 'caller') }));
  await fs.writeFile(quotaFile, JSON.stringify({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null } },
    extra: { primary: { usedPercent: null, windowDurationMins: null, resetsAt: null } }
  }, email: 'private@example.invalid', rateLimitResetCredits: { availableCount: 1 } }));
  const owner = await openMcp(config, { env: { SUB2SUB_TEST_QUOTA: quotaFile, SUB2SUB_TEST_READ_CALLS: callsFile } });
  const observer = await openMcp(config, { env: { SUB2SUB_TEST_QUOTA: path.join(root, 'wrong-account') } });
  const caller = await openMcp(callerConfig);
  await caller.tool('onboarding', { action: 'confirm' });
  t.after(async () => {
    await Promise.all([owner.close(), observer.close(), caller.close()]);
    await stopTestSharing(path.join(root, 'owner'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const local = await owner.tool('resource_usage');
  assert.equal(local.harness, 'codex');
  assert.equal(local.limits[0].primary.remainingPercent, 75);
  assert.equal(local.limits[0].secondary.status, 'exhausted');
  assert.equal(local.limits[1].primary.remainingPercent, null);
  assert.equal((await owner.tool('sharing_status')).status, 'stopped');
  await caller.tool('pair_peer', { invitation: (await owner.tool('create_pairing', { address: '127.0.0.1', port: 0 })).invitation, peer: 'owner' });
  for (const [mcp, args] of [[observer, {}], [caller, { peer: 'owner' }]]) {
    const data = await mcp.tool('resource_usage', args);
    assert.equal(data.limits[0].primary.remainingPercent, 75);
    assert.ok(!JSON.stringify(data).includes('private@example.invalid'));
    assert.ok(!JSON.stringify(data).includes('rateLimitResetCredits'));
  }
  await fs.writeFile(quotaFile, JSON.stringify({ rateLimits: { primary: { usedPercent: 81, resetsAt: 1 } } }));
  const refreshed = await caller.tool('resource_usage', { peer: 'owner' });
  assert.equal(refreshed.limits[0].primary.remainingPercent, 19);
  assert.equal(refreshed.limits[0].primary.status, 'stale');
  await fs.writeFile(quotaFile, JSON.stringify({ error: { code: -32601, message: 'Method not found' } }));
  assert.equal((await caller.tool('resource_usage', { peer: 'owner' })).status, 'unsupported');
  await fs.writeFile(quotaFile, JSON.stringify({ error: { code: -1, message: 'quota read failed' } }));
  const failure = await caller.tool('resource_usage', { peer: 'owner' });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.limits, undefined);
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'available');
  await owner.tool('stop_sharing');
  assert.equal((await caller.tool('resource_usage', { peer: 'owner' })).status, 'failed');
  assert.equal((await caller.tool('check_peer', { peer: 'owner' })).status, 'stopped');
  await fs.writeFile(quotaFile, JSON.stringify({ rateLimitsByLimitId: {} }));
  assert.equal((await caller.tool('resource_usage', { peer: 'owner' })).status, 'unavailable');
  await fs.writeFile(quotaFile, JSON.stringify({ rateLimits: { primary: { usedPercent: 'bad' } } }));
  assert.equal((await caller.tool('resource_usage', { peer: 'owner' })).status, 'failed');
  const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.includes('account/rateLimits/read'));
  assert.ok(calls.every(method => ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'].includes(method)));
});

test('quota reports missing login and old protocol support without starting sharing or a task', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-quota-unavailable-'));
  const executable = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, JSON.stringify({ stateRoot: root, provider: { codexPath: executable } }));
  const mcp = await openMcp(file, { env: { SUB2SUB_TEST_NO_LOGIN: '1' } });
  t.after(async () => { await mcp.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await mcp.tool('resource_usage')).status, 'unavailable');
  assert.equal((await mcp.tool('sharing_status')).status, 'stopped');
  const client = new Client({ peers: { legacy: { transport: 'local', taskRoot: path.join(root, 'legacy'), codexPath: executable } } }, root);
  assert.equal((await client.call('resource_usage', { peer: 'legacy' })).status, 'unsupported');
});
