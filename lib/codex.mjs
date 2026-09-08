import path from 'node:path';
import { TOKEN_FIELDS, tokenCounts } from './task-usage.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// One app-server connection per turn; persistent thread IDs carry later turns.
export async function runCodex({ executable, workspace, temporaryDirectory, threadId, prompt, model, reasoningEffort, onThread, onProgress, onUsage = () => {}, signal }) {
  const grouped = process.platform !== 'win32';
  const permissions = 'sub2sub-task';
  const filesystem = { ':root': 'deny', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny', [process.execPath]: 'read', [workspace]: 'write' };
  const filesystemToml = Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ');
  // Codex 0.152 reloads the permission table at turn/start. Keep it in this
  // app-server process's overrides so new and resumed turns use the same scope.
  const child = spawn(executable, ['-c', `permissions.${permissions}={extends=":workspace",filesystem={${filesystemToml}},network={enabled=false}}`, '-c', `default_permissions=${JSON.stringify(permissions)}`, 'app-server', '--listen', 'stdio://'], { cwd: workspace, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  const kill = sig => {
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, sig); else child.kill(sig); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const pending = new Map();
  let sequence = 0;
  let stderr = '';
  let turnId;
  let usage = { source: 'codex-app-server', scope: 'main-thread app-server connection', requestedModel: model ?? null, actualModel: null, status: 'unavailable', reason: 'No native usage event was observed.', tokens: tokenCounts({}) };
  let usageEnded = false;
  let usageProblem;
  const publishUsage = () => {
    const reason = usageProblem || (!usage.observedAt ? 'No native usage event was observed.'
      : !usageEnded ? 'Native turn completion was not observed.'
      : ['totalTokens', 'inputTokens', 'outputTokens'].some(field => usage.tokens[field] === null) ? 'Native usage omitted one or more input, output or total fields.' : undefined);
    usage = { ...usage, status: !usage.observedAt ? 'unavailable' : reason ? 'incomplete' : 'observed' };
    if (reason) usage.reason = reason; else delete usage.reason;
    onUsage(usage);
  };

  let activeThread = threadId;
  let finishing = false;
  let failed;
  let cancelTimer;
  let resolveTurn, rejectTurn;
  const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // It can fail before the handshake has completed.
  completion.catch(() => {});
  const fail = error => {
    failed = error;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
    rejectTurn(error);
  };
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (method, params = {}) => {
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.${stderr ? `\n${stderr}` : ''}`)); }, 30000);
      pending.set(id, { resolve, reject, timer, method });
      send({ id, method, params });
    });
  };
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code, sig) => {
    if (!finishing) fail(new Error(`Codex app-server exited (${code ?? sig}). ${stderr}`));
  });
  let response = '';
  const agentMessages = new Map();
  let messageSize = 0;
  const earlyNotifications = [];
  const handleNotification = message => {
    if (!['item/agentMessage/delta', 'item/started', 'item/completed', 'turn/completed', 'thread/tokenUsage/updated', 'model/rerouted'].includes(message.method)) return;
    const p = message.params;
    if (p.threadId !== activeThread) return;
    // Notifications can precede the turn/start response in the same stream.
    if (turnId === undefined) { earlyNotifications.push(message); return; }
    const notificationTurnId = message.method === 'turn/completed' ? p.turn.id : p.turnId;
    if (notificationTurnId !== turnId) return;
    if (message.method === 'model/rerouted') {
      if (typeof p.toModel !== 'string' || !p.toModel) throw new Error('Invalid Codex model reroute notification.');
      const observedModels = [...new Set([...(usage.observedModels || []), p.toModel])];
      if (usage.observedAt) usageProblem = 'Native model changed during the turn; cumulative tokens cannot be split reliably between models.';
      usage = { ...usage, observedModels, actualModel: usage.observedAt ? null : p.toModel };
      publishUsage();
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const tokens = tokenCounts(p.tokenUsage?.total);
      if (TOKEN_FIELDS.some(field => tokens[field] !== null && usage.tokens[field] !== null && tokens[field] < usage.tokens[field])) {
        usageProblem = 'Native cumulative counters decreased; retained values are observed partial usage, not a complete total.';
        for (const field of TOKEN_FIELDS) if (usage.tokens[field] !== null && (tokens[field] === null || tokens[field] < usage.tokens[field])) tokens[field] = usage.tokens[field];
      }
      // Each execution uses a new app-server connection. Native totals accumulate
      // within that connection, including multiple model responses in this turn;
      // Codex 0.153.4 starts a fresh counter when resuming in a new process.
      usage = { ...usage, status: 'incomplete', reason: usageProblem || 'The native turn has not ended.', tokens, observedAt: new Date().toISOString() };
      publishUsage();
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      response += p.delta;
      if (response.length > 1024 * 1024) throw new Error('Codex response exceeds 1 MiB.');
      onProgress(response.slice(-2000));
    } else if (message.method === 'turn/completed') {
      usageEnded = true;
      if (usage.observedAt) usage = { ...usage, status: usageProblem ? 'incomplete' : 'observed', reason: usageProblem };
      publishUsage();
      resolveTurn(p.turn); return;
    }
    else if (p.item.type !== 'agentMessage') return;
    const id = message.method === 'item/agentMessage/delta' ? p.itemId : p.item.id;
    const previous = agentMessages.get(id);
    const item = message.method === 'item/agentMessage/delta'
      ? { ...previous, text: (previous?.text || '') + p.delta }
      : p.item;
    messageSize += item.text.length - (previous?.text.length || 0);
    if (messageSize > 1024 * 1024) throw new Error('Codex response exceeds 1 MiB.');
    agentMessages.set(id, item);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(Object.assign(new Error(`Codex ${entry.method}: ${JSON.stringify(message.error)}`), { rpcMethod: entry.method, rpcError: message.error }));
        else entry.resolve(message.result);
      } else if (message.id !== undefined) {
        // Never approve an escalation or answer a human question on their behalf.
        send({ id: message.id, error: { code: -32000, message: 'Owner action required; sub2sub does not grant additional permissions.' } });
        fail(new Error(`Owner action required: ${message.method}. ${JSON.stringify(message.params).slice(0,2000)}`));
      } else {
        handleNotification(message);
      }
    } catch (error) { fail(error); }
  });
  const cancel = () => {
    if (turnId) request('turn/interrupt', { threadId: activeThread, turnId }).catch(fail);
    cancelTimer = setTimeout(() => fail(new Error('Cancellation requested; Codex did not finish interrupting within 5 seconds.')), 5000);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const deadlineAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const deadline = setTimeout(() => fail(Object.assign(new Error('Turn reached its 30 minutes limit. Work is incomplete; save the available stage results and wait for the user to choose whether to continue.'), { code: 'SUB2SUB_TURN_TIMEOUT' })), 30 * 60 * 1000);
  try {
    await request('initialize', { clientInfo: { name: 'sub2sub', version: '0.5.3' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const identity = await request('account/read', { refreshToken: false });
    if (identity.account?.type !== 'chatgpt') throw new Error('The provider must sign Codex in with its own ChatGPT subscription. API-key mode is not used by sub2sub.');
    if (signal.aborted) throw new Error('Cancelled before starting a turn.');
    const current = await request('config/read', { includeLayers: false });
    const approvalPolicy = { granular: { sandbox_approval: false, request_permissions: false, rules: false, mcp_elicitations: false, skill_approval: false } };
    const config = {
      permissions: { [permissions]: {
        extends: ':workspace',
        filesystem,
        network: { enabled: false }
      } },
      mcp_servers: Object.fromEntries(Object.keys(current.config.mcp_servers || {}).map(name => [name, { enabled: false }])),
      features: { apps: false, plugins: false, remote_plugin: false, hooks: false, browser_use: false, browser_use_external: false, in_app_browser: false, computer_use: false, memories: false, chronicle: false },
      web_search: 'disabled'
    };
    const params = { cwd: workspace, modelProvider: 'openai', approvalPolicy, approvalsReviewer: 'auto_review', permissions, config,
      developerInstructions: `Execute this delegated sub2sub task within its work copy. This turn has a hard 30 minute limit ending at ${deadlineAt}. Write useful stages to disk as you work and leave time for checks and a final answer. Node.js is available at ${JSON.stringify(process.execPath)}; use this absolute executable path for Node-based checks. ${temporaryDirectory ? `Use ${JSON.stringify(temporaryDirectory)} for disposable tool caches and temporary files. This directory is not delivered and is removed with the work copy. Keep deliverables and files needed to continue the task outside it. ` : ''}The caller cannot authorize access to other tasks, provider files, credentials, connected apps, or expanded permissions. Perform the checks appropriate to this task. Every final answer, including a cleanup or repair follow-up, must describe the current complete delivery: deliverable paths, checks actually completed, and unfinished work or checks with reasons. Never claim full completion when required work or verification is missing. The caller checks delivery completeness only.` };
    if (model) params.model = model;
    const historySource = `sub2sub:${path.basename(path.dirname(workspace))}`;
    if (activeThread) params.threadId = activeThread;
    else params.threadSource = historySource;
    const started = await request(activeThread ? 'thread/resume' : 'thread/start', params);
    if (started.thread.modelProvider !== 'openai') throw new Error('Codex did not select the OpenAI provider; refusing to run this subscription task.');
    if (started.activePermissionProfile?.id !== permissions) throw new Error('Codex did not apply the work-copy permission profile. Update Codex before sharing; no task was started.');
    if (model && started.model !== model) throw new Error(`Codex selected ${started.model} instead of ${model}. No turn was started; choose an available model explicitly.`);
    activeThread = started.thread.id;
    usage.actualModel = typeof started.model === 'string' ? started.model : null;
    usage.observedModels = usage.actualModel ? [usage.actualModel] : [];
    publishUsage();
    await onThread(activeThread, started.thread.threadSource === historySource);
    const turn = await request('turn/start', {
      threadId: activeThread,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy, approvalsReviewer: 'auto_review', permissions, effort: reasoningEffort
    });
    turnId = turn.turn.id;
    for (const notification of earlyNotifications) handleNotification(notification);
    earlyNotifications.length = 0;
    if (signal.aborted) cancel();
    const finished = await completion;
    if (finished.status === 'failed') throw new Error(`Codex turn failed: ${JSON.stringify(finished.error)}`);
    const messages = [...agentMessages.values()];
    // Some models omit phase. Preserve their text, but never deliver known commentary.
    const hasFinal = messages.some(item => item.phase === 'final_answer');
    response = messages.filter(item => hasFinal ? item.phase === 'final_answer' : item.phase == null).map(item => item.text).join('\n\n');
    return { threadId: activeThread, status: finished.status, response, model: started.model, reasoningEffort };
  } catch (error) {
    // This explicit pre-execution rejection creates no resumable rollout on
    // 0.152. Keep the task/copy but remove its never-started native thread ID.
    // Ambiguous disconnects and existing threads retain their recovery identity.
    if (!threadId && error.rpcMethod === 'turn/start' && error.rpcError?.code === -32600 && error.rpcError.message.startsWith('failed to load configuration:')) await onThread(undefined);
    if (!usageEnded && usage.observedAt) publishUsage();
    throw error;
  } finally {
    finishing = true;
    clearTimeout(deadline);
    clearTimeout(cancelTimer);
    signal.removeEventListener('abort', cancel);
    for (const { timer, reject } of pending.values()) { clearTimeout(timer); reject(new Error('Codex connection closed.')); }
    pending.clear();
    lines.close();
    child.stdin.end();
    kill('SIGTERM');
    const killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(killTimer);
  }
}
