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
    if (message.message.content.startsWith('claude-usage-')) {
      const assistant = (id, input, read, write, parent = null, activeSession = session) => send({ type: 'assistant', session_id: activeSession, uuid: id + '-frame', parent_tool_use_id: parent,
        message: { id, model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text: 'Synthetic progress' }], stop_reason: null,
          usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 1 } } });
      assistant('response-one', 10, 20, 30); assistant('response-one', 10, 20, 30);
      assistant('response-one', 10, undefined, undefined);
      assistant('response-two', 3, 4, 5);
      assistant('child-response', 999, 999, 999, 'child-tool');
      assistant('other-session-response', 999, 999, 999, null, 'other-session');
      if (message.message.content === 'claude-usage-partial') return;
      if (message.message.content === 'claude-usage-crash') {
        send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Synthetic crash with zeroed usage'], session_id: session, user_message_uuid: message.uuid,
          modelUsage: { 'claude-sonnet-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
        return;
      }
      if (message.message.content === 'claude-usage-failure') {
        send({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Synthetic failed execution'], session_id: session,
          modelUsage: { 'claude-sonnet-5': { inputTokens: 13, outputTokens: 50, cacheReadInputTokens: 24, cacheCreationInputTokens: 35 } } });
        return;
      }
      if (message.message.content === 'claude-usage-small') {
        send({ type: 'result', subtype: 'success', is_error: false, session_id: session, user_message_uuid: message.uuid, result: 'Created answer.txt',
          modelUsage: { 'claude-sonnet-5': { inputTokens: 3, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
        return;
      }
      if (message.message.content === 'claude-usage-missing-fields') {
        send({ type: 'result', subtype: 'success', is_error: false, session_id: session, user_message_uuid: message.uuid, result: 'Created answer.txt',
          modelUsage: { 'claude-sonnet-5': { outputTokens: 50 } } });
        return;
      }
    }
    if (message.message.content === 'claude-usage-complete') {
      send({ type: 'result', subtype: 'success', is_error: false, session_id: session, user_message_uuid: 'another-user-turn', result: 'Ignored other turn', modelUsage: {
        'other-model': { inputTokens: 999, outputTokens: 999, cacheReadInputTokens: 999, cacheCreationInputTokens: 999 }
      } });
      send({ type: 'result', subtype: 'success', is_error: false, session_id: session, user_message_uuid: message.uuid, result: 'Created answer.txt', modelUsage: {
        'claude-sonnet-5': { inputTokens: 13, outputTokens: 50, cacheReadInputTokens: 24, cacheCreationInputTokens: 35, thinkingTokens: 10 },
        'claude-haiku-4-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 1, cacheCreationInputTokens: 0 }
      } });
      return;
    }
    if (message.message.content === 'background-ignore-interrupt') {
      send({ type: 'system', subtype: 'task_started', session_id: session, task_id: 'background-fixture' });
      return;
    }
    if (['hang', 'partial-wait'].includes(message.message.content)) return;
    if (message.message.content === 'background-complete') send({ type: 'system', subtype: 'task_started', session_id: session, task_id: 'background-fixture' });
    send({ type: 'result', subtype: 'success', is_error: false, session_id: session, user_message_uuid: message.uuid, result: 'Created answer.txt' });
  }
});
