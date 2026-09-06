import { Client } from '../lib/client.mjs';
import { codexExecutable } from '../lib/config.mjs';

try {
  const client = await Client.load();
  const status = await client.call('setup_status', {});
  const codexPath = await codexExecutable(client.config);
  process.stdout.write(JSON.stringify({ ...status, nodePath: process.execPath, codexPath, nextStep: 'Activate the local sub2sub plugin in Codex, then ask to start sharing or pair with a provider. This check does not install or change Codex configuration.' }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`sub2sub setup: ${error.message}\n`);
  process.exitCode = 1;
}
