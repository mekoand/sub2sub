#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const executing = process.argv.includes('default_permissions="sub2sub-task"');
const directory = executing ? path.dirname(process.cwd()) : process.cwd();
const history = path.join(executing ? path.dirname(directory) : directory, '.fake-codex');
await fs.mkdir(history, { recursive: true });
if (executing) await fs.writeFile(path.join(directory, 'process.json'), JSON.stringify({ args: process.argv.slice(2) }));
const lines = createInterface({ input: process.stdin });
const send = v => process.stdout.write(JSON.stringify(v) + '\n');
let threadId;
let model;
lines.on('line', async line => {
  const m = JSON.parse(line);
  if (!m.method) return;
  if (executing) await fs.appendFile(path.join(directory, 'calls.jsonl'), line + '\n');
  const reply = result => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': reply({ userAgent: 'fake-codex' }); break;
    case 'account/read': reply({ account: { type: 'chatgpt', planType: 'plus' } }); break;
    case 'model/list': {
      let models;
      try { models = JSON.parse(await fs.readFile(path.join(process.cwd(), 'model-list.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        models = ['gpt-5.6-luna', 'gpt-5.6-sol'].map(model => ({ model, displayName: model, supportedReasoningEfforts: ['low', 'high', 'max'].map(reasoningEffort => ({ reasoningEffort })) }));
      }
      reply({ data: models, nextCursor: null }); break;
    }
    case 'config/read': reply({ config: { mcp_servers: { hostTool: { command: 'provider-private-tool' } } } }); break;
    case 'thread/start':
    case 'thread/resume':
      if (m.params.modelProvider !== 'openai') { send({ id: m.id, error: { message: 'Default provider is third-party; explicitly select openai.' } }); break; }
      threadId = m.params.threadId || randomUUID();
      model = m.params.model;
      const native = m.method === 'thread/resume' ? JSON.parse(await fs.readFile(path.join(history, threadId + '.json'), 'utf8')) : { id: threadId, cwd: process.cwd(), source: 'vscode', threadSource: m.params.threadSource ?? null, archived: false, parentThreadId: null, forkedFromId: null, status: { type: 'notLoaded' } };
      await fs.writeFile(path.join(history, threadId + '.json'), JSON.stringify(native));
      reply({ thread: { ...native, modelProvider: 'openai' }, model: m.params.model === 'fixture-reroute' ? 'gpt-5.6-luna' : m.params.model, activePermissionProfile: { id: m.params.permissions } }); break;
    case 'turn/start': {
      if (!process.argv.includes('default_permissions="sub2sub-task"')) {
        send({ id: m.id, error: { message: 'failed to load configuration: default_permissions requires a `[permissions]` table' } });
        break;
      }
      const prompt = m.params.input[0].text;
      if (prompt.startsWith('cleanup-')) {
        const file = path.join(history, threadId + '.json');
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        saved.archived = prompt === 'cleanup-archived';
        saved.failDelete = prompt === 'cleanup-delete-failure';
        await fs.writeFile(file, JSON.stringify(saved));
        if (prompt === 'cleanup-child') await fs.writeFile(path.join(history, 'child-' + threadId + '.json'), JSON.stringify({ id: 'child-' + threadId, cwd: '/different/child/cwd', source: 'subAgent', archived: false, parentThreadId: threadId, status: { type: 'notLoaded' } }));
      }
      if (prompt === 'configuration-failure') {
        send({ id: m.id, error: { code: -32600, message: 'failed to load configuration: fixture setting' } });
        break;
      }
      if (prompt === 'early-completion') {
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'old-turn', delta: 'STALE EARLY' } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'old-turn', status: 'failed' } } });
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', delta: 'EARLY ROOT FINAL' } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
        setTimeout(() => reply({ turn: { id: 'turn-1', status: 'inProgress' } }), 20);
        break;
      }
      reply({ turn: { id: 'turn-1', status: 'inProgress' } });
      if (prompt === 'partial-wait') {
        await fs.writeFile('partial.txt', 'Stage one is on disk; further work remains.');
        break;
      }
      if (prompt === 'message-phases' || prompt === 'unknown-message-phase') {
        for (const [id, phase, text] of [
          ['progress-1', 'commentary', 'Still checking.'],
          ['progress-2', 'commentary', 'Checking another result.'],
          ['answer', prompt === 'message-phases' ? 'final_answer' : null, 'Finished successfully.']
        ]) {
          send({ method: 'item/started', params: { threadId, turnId: 'turn-1', item: { id, type: 'agentMessage', phase, text: '' } } });
          send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: id, delta: text } });
          send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { id, type: 'agentMessage', phase, text } } });
        }
        send({ method: 'item/completed', params: { threadId: 'child-thread', turnId: 'turn-1', item: { id: 'child', type: 'agentMessage', phase: 'final_answer', text: 'CHILD ONLY' } } });
        send({ method: 'item/completed', params: { threadId, turnId: 'old-turn', item: { id: 'stale', type: 'agentMessage', phase: 'final_answer', text: 'STALE ONLY' } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
        break;
      }
      if (prompt === 'report-execution') {
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', delta: JSON.stringify({ model, reasoningEffort: m.params.effort }) } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
        break;
      }
      if (prompt === 'hang') { send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', delta: 'Waiting for cancellation' } }); break; }
      if (prompt === 'approval') { send({ id: 'owner-approval', method: 'item/commandExecution/requestApproval', params: { command: 'touch outside-workspace' } }); break; }
      if (prompt === 'failure') { send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'failed', error: { message: 'fixture failure' } } } }); break; }
      if (prompt === 'subagent-events') {
        send({ method: 'item/agentMessage/delta', params: { threadId: 'child-thread', turnId: 'child-turn', delta: 'CHILD ONLY' } });
        send({ method: 'turn/completed', params: { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed' } } });
        send({ method: 'turn/completed', params: { threadId: 'other-child', turn: { id: 'failed-child', status: 'failed', error: { message: 'child failure' } } } });
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'old-turn', delta: 'STALE ONLY' } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'old-turn', status: 'failed', error: { message: 'stale failure' } } } });
        setTimeout(async () => {
          await fs.writeFile('answer.txt', 'root completed after children');
          send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', delta: 'ROOT FINAL' } });
          send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
        }, 100);
        break;
      }
      await fs.writeFile('answer.txt', prompt);
      if (prompt === 'sync-add') { await fs.writeFile('input.txt', 'changed input'); await fs.writeFile('temporary.txt', 'new file'); }
      if (prompt === 'sync-restore') { await fs.writeFile('input.txt', '任务输入'); await fs.rm('temporary.txt', { force: true }); }
      if (/^accum-[12]$/.test(prompt)) { await fs.mkdir('dist', { recursive: true }); await fs.writeFile(`dist/${prompt}.txt`, 'x'.repeat(800)); }
      if (prompt === 'check-accumulated') { if ((await fs.readFile('dist/accum-1.txt', 'utf8')).length !== 800 || (await fs.readFile('dist/accum-2.txt', 'utf8')).length !== 800) throw new Error('Restored build files missing.'); }
      if (prompt === 'large-result') await fs.writeFile('large-output.bin', Buffer.alloc(21 * 1024 * 1024, 66));
      if (await fs.stat('remove.txt').catch(e => { if (e.code === 'ENOENT') return false; throw e; })) await fs.unlink('remove.txt');
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', delta: `已完成：${prompt}` } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
      break;
    }
    case 'thread/read': {
      const file = path.join(history, m.params.threadId + '.json');
      try { reply({ thread: JSON.parse(await fs.readFile(file, 'utf8')) }); } catch (error) { if (error.code !== 'ENOENT') throw error; send({ id: m.id, error: { message: 'thread not found' } }); }
      break;
    }
    case 'thread/name/set': {
      const file = path.join(history, m.params.threadId + '.json');
      const thread = JSON.parse(await fs.readFile(file, 'utf8')); thread.name = m.params.name;
      await fs.writeFile(file, JSON.stringify(thread)); reply({}); break;
    }
    case 'thread/list': {
      const all = await Promise.all((await fs.readdir(history)).filter(n => n.endsWith('.json')).map(async n => JSON.parse(await fs.readFile(path.join(history, n), 'utf8'))));
      reply({ data: all.filter(t => (m.params.sourceKinds || ['appServer', 'vscode', 'cli']).includes(t.source) && t.archived === Boolean(m.params.archived) && (!m.params.cwd || t.cwd === m.params.cwd)).map(t => ({ ...t, threadSource: null })), nextCursor: null });
      break;
    }
    case 'thread/delete': {
      const file = path.join(history, m.params.threadId + '.json');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.failDelete) {
        saved.failDelete = false; await fs.writeFile(file, JSON.stringify(saved));
        send({ id: m.id, error: { message: 'fixture native deletion failed' } }); break;
      }
      for (const name of await fs.readdir(history)) {
        const item = JSON.parse(await fs.readFile(path.join(history, name), 'utf8'));
        if (item.id === m.params.threadId || item.parentThreadId === m.params.threadId) {
          await fs.unlink(path.join(history, name));
          send({ method: 'thread/deleted', params: { threadId: item.id } });
        }
      }
      reply({}); break;
    }
    case 'turn/interrupt': reply({}); send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'interrupted' } } }); break;
  }
});
