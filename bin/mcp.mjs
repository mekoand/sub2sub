#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Client } from '../lib/client.mjs';
import { tools, validateToolInput } from '../lib/tools.mjs';
import packageInfo from '../package.json' with { type: 'json' };

const active = new Map();
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
let clientPromise;
let startup;
let initialized = false;
let shuttingDown = false;
const lines = createInterface({ input: process.stdin });
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of active.values()) controller.abort();
  lines.close();
  process.stdin.destroy();
  try { await startup; await (await clientPromise)?.close(); }
  catch (error) { process.stderr.write(`sub2sub shutdown failed: ${error.message}\n`); process.exitCode = 1; }
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.stdout.on('error', shutdown);
lines.on('line', async line => {
  let message;
  try {
    if (shuttingDown) return;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('MCP request exceeds 1 MiB.');
    message = JSON.parse(line);
    if (message.method === 'notifications/cancelled') { active.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      startup ||= (async () => {
        const loading = clientPromise ||= Client.load();
        let client;
        try { client = await loading; }
        catch (error) { if (clientPromise === loading) clientPromise = undefined; throw error; }
        if (shuttingDown) return;
        try { await client.web.start(); }
        catch (error) { client.web.error = error.message; throw error; }
      })().catch(error => { process.stderr.write(`sub2sub management unavailable: ${error.message}\n`); });
      await startup;
      if (shuttingDown) return;
      initialized = true;
      send({ id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sub2sub', version: packageInfo.version } } });
      return;
    }
    if (startup && !initialized) await startup;
    if (shuttingDown) return;
    if (!initialized) throw new Error('Initialize the MCP connection first.');
    if (message.method === 'ping') { send({ id: message.id, result: {} }); return; }
    if (message.method === 'tools/list') { send({ id: message.id, result: { tools } }); return; }
    if (message.method !== 'tools/call') { send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    const input = validateToolInput(message.params?.name, message.params.arguments);
    const controller = new AbortController();
    active.set(message.id, controller);
    const loading = clientPromise ||= Client.load();
    let client;
    try { client = await loading; }
    catch (error) { if (clientPromise === loading) clientPromise = undefined; throw error; }
    if (shuttingDown) throw new Error('Plugin is shutting down; task was not started.');
    let progress = 0;
    const token = message.params._meta?.progressToken;
    const result = await client.call(message.params.name, input, text => {
      if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: text } });
    }, controller.signal);
    send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  } catch (error) {
    if (message?.method === 'tools/call') send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } });
    else send({ id: message?.id ?? null, error: { code: message ? -32600 : -32700, message: error.message } });
  } finally { if (message?.id !== undefined) active.delete(message.id); }
});
lines.on('close', shutdown);
