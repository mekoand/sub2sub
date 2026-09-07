#!/usr/bin/env node
import { Config } from '../lib/config.mjs';
import { Sharing } from '../lib/lan.mjs';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../lib/files.mjs';

const startupFile = process.argv[2] === '--startup-file' ? process.argv[3] : undefined;
const { configFile, stateRoot, input } = startupFile ? await readJson(startupFile)
  : { configFile: process.argv[2], stateRoot: process.argv[3], input: JSON.parse(process.argv[4]) };
if (startupFile) process.on('uncaughtExceptionMonitor', error => appendFileSync(path.join(stateRoot, 'sharing', 'node.log'), `${new Date().toISOString()} ${error.stack}\n`));
const sharing = new Sharing(new Config(configFile), stateRoot);
let stopping;
const shutdown = () => stopping ||= sharing.close().catch(error => {
  process.stderr.write(`sub2sub node shutdown failed: ${error.message}\n`);
  process.exitCode = 1;
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
const reply = async message => {
  if (startupFile) await writeJson(startupFile, message);
  if (process.connected) process.send(message, error => {
    if (error) process.stderr.write(`sub2sub startup notification failed: ${error.message}\n`);
    if (process.connected) process.disconnect();
  });
};
try {
  const until = performance.now() + 5000;
  for (;;) {
    try { await reply({ result: await sharing.manage('start', input) }); break; }
    catch (error) {
      // Another manager can be starting the same node before its endpoint exists.
      if (error.code !== 'LOCK_BUSY' || performance.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
} catch (error) {
  await shutdown();
  process.exitCode = 1;
  await reply({ error: error.message });
}
