import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { tokenCounts } from './task-usage.mjs';
import { query, getSessionInfo, listSessions, tagSession, deleteSession } from '@anthropic-ai/claude-agent-sdk';

const exec = promisify(execFile);

export async function runClaude({ executable, workspace, temporaryDirectory, threadId, prompt, model, resolvedModel, reasoningEffort, onThread, onProgress, onUsage = () => {}, signal }) {
  const id = threadId || randomUUID(), messageId = randomUUID();
  if (threadId && !(await getSessionInfo(threadId, { dir: workspace }))) throw new Error('The original Claude session is missing. Its work files are preserved; a replacement session was not started.');
  await onThread(id, false);
  let usage = { source: 'claude-agent-sdk', scope: 'query-pipeline', requestedModel: model ?? null, actualModel: null, status: 'unavailable', reason: 'No native usage event was observed.', tokens: tokenCounts({}) };
  onUsage(usage);
  const assistantUsage = new Map();
  const publishModels = (models, scope, reason) => {
    usage = { source: 'claude-agent-sdk', scope, requestedModel: model ?? null, actualModel: models.length === 1 ? models[0].actualModel : null,
      models, observedModels: models.map(entry => entry.actualModel), tokens: models.length === 1 ? models[0].tokens : tokenCounts({}), observedAt: new Date().toISOString(),
      status: reason ? 'incomplete' : 'observed', ...(reason ? { reason } : {}) };
    onUsage(usage);
  };
  let finishInput, startInput;
  const ready = new Promise(resolve => { startInput = resolve; });
  const held = new Promise(resolve => { finishInput = resolve; });
  async function* input() {
    if (!await ready) return;
    yield { type: 'user', uuid: messageId, session_id: id, parent_tool_use_id: null, message: { role: 'user', content: prompt } };
    await held;
  }
  // One file-access path: every operation goes through Claude's Bash sandbox.
  const tools = ['Bash'];
  const session = openClaude(executable, workspace, {
    ...(threadId ? { resume: id } : { sessionId: id }), model,
    env: { ...process.env, CLAUDE_CODE_TMPDIR: temporaryDirectory || workspace, CLAUDE_CODE_TASK_LIST_ID: id },
    ...(reasoningEffort === 'none' ? {} : { effort: reasoningEffort }),
    tools, permissionMode: 'acceptEdits',
    settings: { disableAllHooks: true, autoMemoryEnabled: false, fallbackModel: [], switchModelsOnFlag: false, autoContinueAtUsageLimit: false },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [],
      filesystem: { denyRead: ['/'], allowRead: [workspace, '/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/private/etc', '/dev/null', '/dev/urandom', '/opt/homebrew', path.dirname(process.execPath)], allowWrite: [workspace] },
      network: { allowedDomains: [], strictAllowlist: true, allowUnixSockets: [], allowLocalBinding: false }
    },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: `Execute this delegated sub2sub task only within this work copy. Task network access and host integrations are unavailable. This turn has a 30 minute limit. Save useful stages to disk and leave time for task-appropriate checks. In the final answer, concisely answer this turn’s request and describe the adjustments actually made in this turn, followed by the current complete delivery: deliverable paths, checks actually completed and unfinished work with reasons. Text-only answers and turns without file changes are valid; use natural language without empty sections or invented change lists. Node is available at ${JSON.stringify(process.execPath)}. Use ${JSON.stringify(temporaryDirectory || workspace)} for disposable caches; keep deliverables outside the cache directory. The caller checks delivery completeness.` }
  }, input());
  let timedOut = false, interrupted = false, stopFailure, interrupting, response, killTimer, failure;
  const stop = () => {
    interrupted = true;
    interrupting ||= session.query.interrupt().catch(error => { stopFailure = error; session.query.close(); });
    killTimer ||= setTimeout(() => session.query.close(), 5000);
  };
  const deadline = setTimeout(() => { timedOut = true; stop(); }, 30 * 60 * 1000);
  signal.addEventListener('abort', stop, { once: true });
  const tasks = new Set();
  const messages = session.query[Symbol.asyncIterator]();
  let startup;
  try {
    if (signal.aborted) stop();
    await Promise.race([
      session.query.initializationResult(),
      new Promise((_, reject) => { startup = setTimeout(() => reject(new Error('Claude execution initialization timed out; no task message was sent. Check the provider Claude version and execution settings.')), 15000); })
    ]);
    clearTimeout(startup);
    if (interrupted) throw new Error('Claude was interrupted during initialization.');
    startInput(true);
    // Keep the SDK iterator open until background work has been stopped.
    // `for await` + break would close the query before the finally block.
    for (;;) {
      const { value: message, done } = await messages.next();
      if (done) break;
      if (message.type === 'system' && message.subtype === 'init') {
        if (message.session_id !== id || ![model, resolvedModel].includes(message.model)) throw new Error('Claude did not use the selected session and model. No alternative is accepted.');
        if (message.mcp_servers?.length || message.plugins?.length || message.tools.some(tool => !tools.includes(tool))) throw new Error('Claude loaded tools or integrations outside the task scope.');
        onProgress(`Claude started with ${message.model}.`);
      }
      if (message.session_id !== id) continue;
      if (message.type === 'system' && message.subtype === 'task_started') tasks.add(message.task_id);
      if (message.type === 'system' && message.subtype === 'task_notification') tasks.delete(message.task_id);
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        const entry = message.message;
        if (entry.usage !== undefined && entry.model !== '<synthetic>') {
          if (typeof entry.id !== 'string' || !entry.id || typeof entry.model !== 'string' || !entry.model || !entry.usage || typeof entry.usage !== 'object' || Array.isArray(entry.usage)) throw new Error('Invalid Claude assistant usage.');
          // Content blocks share an API response id. Its output count is a
          // message-start placeholder; only input/cache counts are usable here.
          const tokens = tokenCounts({ inputTokens: entry.usage.input_tokens, cachedInputTokens: entry.usage.cache_read_input_tokens, cacheWriteInputTokens: entry.usage.cache_creation_input_tokens });
          const previous = assistantUsage.get(entry.id);
          for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens']) {
            if (tokens[field] === null && previous?.actualModel === entry.model) tokens[field] = previous.tokens[field];
          }
          assistantUsage.set(entry.id, { actualModel: entry.model, tokens });
          const grouped = new Map();
          for (const item of assistantUsage.values()) {
            const counts = grouped.get(item.actualModel) || tokenCounts({});
            for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens']) {
              if (item.tokens[field] !== null) counts[field] = (counts[field] ?? 0) + item.tokens[field];
            }
            grouped.set(item.actualModel, counts);
          }
          publishModels([...grouped].map(([actualModel, counts]) => ({ actualModel, tokens: tokenCounts(counts) })), 'main-loop assistant input/cache only', 'No complete native result usage is available; these are observed main-loop input/cache tokens. Output and auxiliary usage are unknown.');
        }
        const text = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (text) onProgress(text);
      }
      if (message.type !== 'result') continue;
      const currentResult = message.user_message_uuid === messageId || message.user_message_uuids?.includes(messageId);
      // A query-level fatal error may omit the user uuid. This connection has
      // only this one submitted turn, so its nonzero usage still belongs here.
      if (!currentResult && !(message.is_error && !message.user_message_uuid && !message.user_message_uuids?.length)) continue;
      if (message.modelUsage !== undefined) {
        if (!message.modelUsage || typeof message.modelUsage !== 'object' || Array.isArray(message.modelUsage)) throw new Error('Invalid Claude per-model usage.');
        const models = Object.entries(message.modelUsage).map(([actualModel, counts]) => {
          if (!actualModel || !counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid Claude model usage entry.');
          return { actualModel, tokens: tokenCounts({ inputTokens: counts.inputTokens, cachedInputTokens: counts.cacheReadInputTokens, cacheWriteInputTokens: counts.cacheCreationInputTokens, outputTokens: counts.outputTokens, reasoningOutputTokens: counts.thinkingTokens }) };
        });
        const zeroedCrash = message.is_error && message.subtype === 'error_during_execution'
          && models.every(entry => Object.values(entry.tokens).every(count => count === null || count === 0));
        if (models.length && !zeroedCrash) {
          const missing = models.some(entry => ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'].some(field => entry.tokens[field] === null));
          let partialFallback = false;
          for (const entry of models) {
            const partial = usage.models?.find(prior => prior.actualModel === entry.actualModel);
            for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens']) {
              if (entry.tokens[field] === null && partial?.tokens[field] != null) {
                entry.tokens[field] = partial.tokens[field];
                partialFallback = true;
              }
            }
          }
          publishModels(models, 'query-pipeline', missing ? `Native result omitted one or more input, cache or output fields.${partialFallback ? ' Missing input/cache fields retain main-loop observed partial usage, not whole-query totals.' : ''}` : undefined);
        }
      }
      if (message.is_error) throw new Error(message.errors?.join('\n') || message.result || 'Claude execution failed.');
      response = message.result;
      break;
    }
    if (!interrupted && response === undefined) throw new Error('Claude ended without a result for this turn. Available files remain recoverable.');
  } catch (error) { failure = error; }
  finally {
    clearTimeout(startup); clearTimeout(deadline); clearTimeout(killTimer); signal.removeEventListener('abort', stop);
    try { for (const task of tasks) await session.query.stopTask(task); }
    catch (error) { stopFailure ||= error; }
    finally {
      startInput(false); finishInput();
      try { await session.close(); } finally { await messages.return?.(); }
      if (await getSessionInfo(id, { dir: workspace })) {
        await tagSession(id, `sub2sub:${path.basename(path.dirname(workspace))}`, { dir: workspace });
        await onThread(id, true);
      }
    }
  }
  const stopDetail = stopFailure ? ` Claude required process shutdown after its stop request failed: ${stopFailure.message}` : '';
  if (timedOut) throw Object.assign(new Error(`Claude turn reached its 30 minute limit. Available stage files are ready to collect.${stopDetail}`), { code: 'SUB2SUB_TURN_TIMEOUT' });
  if (interrupted) throw new Error(`Claude turn interrupted. Available stage files are ready to collect.${stopDetail}`);
  if (stopFailure) throw new Error(`Claude background task stop failed: ${stopFailure.message}`);
  if (failure) throw failure;
  return { threadId: id, status: 'completed', response, model, reasoningEffort };
}

export async function manageClaudeHistory({ root, taskId, threadId, retain = false }) {
  const sessions = threadId ? [await getSessionInfo(threadId, { dir: path.join(root, taskId, 'work') })].filter(Boolean)
    : (await listSessions({ includeWorktrees: false, includeProgrammatic: true })).filter(session => {
      const id = path.basename(path.dirname(session.cwd || ''));
      return session.cwd === path.join(root, id, 'work') && /^[a-f0-9-]{36}$/.test(id) && session.tag === `sub2sub:${id}` && (!taskId || taskId === id);
    });
  const deletedThreads = [];
  for (const session of sessions) {
    const id = path.basename(path.dirname(session.cwd || ''));
    if (session.cwd !== path.join(root, id, 'work') || taskId && id !== taskId) throw new Error('Claude history does not belong to this task work copy.');
    if (retain) await tagSession(session.sessionId, `sub2sub:${id}`, { dir: session.cwd });
    else {
      const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      // Find the local transcript by its metadata, not Claude's project-name
      // encoding (which also has shortened and relocated directory variants).
      const projects = path.join(home, 'projects'), directories = [];
      for (const project of await fs.readdir(projects, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        let file;
        try { file = await fs.open(path.join(projects, project.name, `${session.sessionId}.jsonl`)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try {
          for await (const line of file.readLines()) {
            if (!line) continue;
            const record = JSON.parse(line);
            if (record.sessionId === session.sessionId && typeof record.cwd === 'string') {
              if (record.cwd === session.cwd) directories.push(path.join(projects, project.name, session.sessionId));
              break;
            }
          }
        } finally { await file.close(); }
      }
      if (directories.length !== 1) throw new Error('Claude local history location is missing or ambiguous. History cleanup is incomplete; task records are preserved.');
      // Remove only paths keyed to this session; keep its transcript until last
      // so a partial cleanup can still be identified and retried through the SDK.
      await fs.rm(directories[0], { recursive: true, force: true });
      await fs.rm(path.join(home, 'file-history', session.sessionId), { recursive: true, force: true });
      await fs.rm(path.join(home, 'tasks', session.sessionId), { recursive: true, force: true });
      await fs.rm(path.join(home, 'debug', `${session.sessionId}.txt`), { force: true });
      // SDK deletion is transcript-first; the child directory is already gone.
      await deleteSession(session.sessionId, { dir: session.cwd });
      deletedThreads.push(session.sessionId);
    }
  }
  return { nativeHistory: retain ? 'retained' : 'deleted', deletedThreads: deletedThreads.length };
}

export async function queryClaudeModels(executable, cwd, signal) {
  const { stdout } = await exec(executable, ['--version'], { timeout: 10000, signal });
  const version = stdout.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!version || version[0] < 2 || version[0] === 2 && (version[1] < 1 || version[1] === 1 && version[2] < 263)) throw new Error('Claude Code 2.1.263 or later is required. Update Claude Code before selecting it as the provider.');
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  async function* input() { await held; }
  const session = openClaude(executable, cwd, { tools: [], persistSession: false }, input());
  const abort = () => session.query.close();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    if (signal?.aborted) throw new Error('Claude model query cancelled.');
    const account = await session.query.accountInfo();
    if (account.apiProvider !== 'firstParty' || !account.subscriptionType || account.apiKeySource && account.apiKeySource !== 'none') throw new Error('Sign in to Claude Code with the provider Claude subscription before selecting it. API-key execution is not selected automatically.');
    const models = await session.query.supportedModels();
    return models.map(model => {
      if (typeof model.value !== 'string' || !model.value || model.supportedEffortLevels !== undefined && !Array.isArray(model.supportedEffortLevels)) throw new Error('Invalid Claude model capabilities.');
      return { model: model.value, resolvedModel: model.resolvedModel, displayName: model.displayName, reasoningEfforts: model.supportedEffortLevels?.length ? model.supportedEffortLevels : model.supportsEffort ? [] : ['none'] };
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    finish(); await session.close();
  }
}

function openClaude(executable, cwd, options, prompt) {
  let child, exited;
  const session = query({ prompt, options: {
    pathToClaudeCodeExecutable: executable, cwd, settingSources: [], strictMcpConfig: true,
    mcpServers: {}, plugins: [], skills: [], permissionPrompts: 'none',
    stderr: text => process.stderr.write(text),
    settings: { disableAllHooks: true, autoMemoryEnabled: false, fallbackModel: [], switchModelsOnFlag: false, autoContinueAtUsageLimit: false },
    ...options,
    spawnClaudeCodeProcess: parameters => {
      child = spawn(parameters.command, parameters.args, { cwd: parameters.cwd, env: parameters.env, signal: parameters.signal, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      exited = new Promise(resolve => child.once('close', resolve));
      return child;
    }
  } });
  return { query: session, async close() {
    session.close();
    if (!child) return;
    const stop = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    stop('SIGTERM');
    const timer = setTimeout(() => stop('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); stop('SIGKILL'); }
  } };
}
