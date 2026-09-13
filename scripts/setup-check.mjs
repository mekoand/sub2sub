import { fileURLToPath } from 'node:url';
import { verifyTailcat } from '../lib/tailcat.mjs';
import { Client } from '../lib/client.mjs';
import { codexExecutable } from '../lib/config.mjs';

try {
  const client = await Client.load();
  const status = await client.call('setup_status', {});
  const codexPath = await codexExecutable(client.config);
  let crossNetworkHelper;
  try { crossNetworkHelper = { status: 'available', ...await verifyTailcat(fileURLToPath(new URL('../bin', import.meta.url)), { platform: process.platform, arch: process.arch, execute: true }) }; }
  catch (error) { crossNetworkHelper = { status: 'unavailable', reason: error.message, nextStep: 'Install a package with the bundled helper to use cross-network connections. Private network connections remain available.' }; }
  process.stdout.write(JSON.stringify({ ...status, crossNetworkHelper, nodePath: process.execPath, codexPath, nextStep: 'Activate the local sub2sub plugin in Codex, then ask to start sharing or pair with a provider. This check does not install or change Codex configuration.' }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`sub2sub setup: ${error.message}\n`);
  process.exitCode = 1;
}
