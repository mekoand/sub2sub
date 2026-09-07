#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('2.1.263 (Claude Code)'); process.exit(0); }
const arg = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const session = arg('--resume') || arg('--session-id');
const model = arg('--model');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const lines = createInterface({ input: process.stdin });
let current;
lines.on('line', async line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'interrupt' && current?.message.content === 'background-ignore-interrupt') return;
    if (message.request.subtype === 'stop_task') await fs.writeFile(path.join(process.cwd(), 'answer.txt'), 'background-stopped');
    const response = message.request.subtype === 'initialize' ? {
      account: { subscriptionType: 'pro', apiProvider: 'firstParty', tokenSource: 'claudeAi', apiKeySource: 'none' },
      models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] }]
    } : {};
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
    if (message.request.subtype === 'interrupt' && current) send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Interrupted'], session_id: session, user_message_uuid: current.uuid });
  } else if (message.type === 'user') {
    current = message;
    const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(project, { recursive: true });
    await fs.appendFile(path.join(project, session + '.jsonl'), JSON.stringify({ type: 'user', sessionId: session, cwd: process.cwd(), uuid: message.uuid, parentUuid: null, isSidechain: false, message: message.message, timestamp: new Date().toISOString() }) + '\n');
    send({ type: 'system', subtype: 'init', session_id: session, model: model === 'sonnet' ? 'claude-sonnet-5' : model, tools: ['Bash'], mcp_servers: [], plugins: [], skills: [], permissionMode: 'acceptEdits' });
    await fs.writeFile(path.join(process.cwd(), 'answer.txt'), message.message.content);
    if (message.message.content === 'background-ignore-interrupt') {
      send({ type: 'system', subtype: 'task_started', session_id: session, task_id: 'background-fixture' });
      return;
    }
    if (['hang', 'partial-wait'].includes(message.message.content)) return;
    if (message.message.content === 'background-complete') send({ type: 'system', subtype: 'task_started', session_id: session, task_id: 'background-fixture' });
    send({ type: 'result', subtype: 'success', is_error: false, session_id: session, user_message_uuid: message.uuid, result: 'Created answer.txt' });
  }
});
