import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { allowedModels } from './config.mjs';
import { transferLimits } from './limits.mjs';

// Query the provider's current subscription catalog without starting a task.
export async function queryModels(executable, cwd, signal) {
  const child = spawn(executable, ['-c', 'model_provider="openai"', 'app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, failure, stderr = '', bytes = 0;
  const fail = error => {
    failure = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const exited = new Promise(resolve => child.once('close', code => { fail(new Error(`Model discovery exited (${code}). ${stderr}`)); resolve(); }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  child.stdout.on('data', data => { bytes += data.length; if (bytes > 4 * 1024 * 1024) fail(new Error('Model discovery response is too large.')); });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params) => {
    if (failure) throw failure;
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Model discovery ${method} timed out.`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) throw new Error(`Model discovery requires owner action: ${message.method}`);
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(`Model discovery: ${JSON.stringify(message.error)}`));
      else item.resolve(message.result);
    } catch (error) { fail(error); }
  });
  const abort = () => fail(new Error('Model discovery cancelled; capabilities are unconfirmed.'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    await request('initialize', { clientInfo: { name: 'sub2sub-models', version: '0.5.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const identity = await request('account/read', { refreshToken: false });
    if (identity.account?.type !== 'chatgpt') throw new Error('Sign in with the provider ChatGPT subscription before querying models.');
    const models = [], cursors = new Set();
    let cursor;
    do {
      const page = await request('model/list', { cursor, limit: 100, includeHidden: false });
      if (!Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string')) throw new Error('Invalid model catalog; capabilities are unconfirmed.');
      for (const model of page.data) {
        if (typeof model.model !== 'string' || !model.model || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.some(e => typeof e.reasoningEffort !== 'string' || !e.reasoningEffort)) throw new Error('Invalid model capabilities from Codex.');
        models.push({ model: model.model, displayName: model.displayName, reasoningEfforts: model.supportedReasoningEfforts.map(e => e.reasoningEffort) });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Model discovery returned a repeated cursor.');
      cursors.add(cursor);
      if (models.length > 2000) throw new Error('Model catalog exceeds 2000 entries.');
    } while (cursor);
    return models;
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const item of pending.values()) clearTimeout(item.timer);
    lines.close(); child.stdin.end(); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited; clearTimeout(timer);
  }
}

export function modelCapabilities(models, provider = {}) {
  const allowed = allowedModels(provider);
  return { protocol: 2, checkedAt: new Date().toISOString(), allowedModels: allowed, limits: transferLimits(provider), models: models.filter(m => allowed === 'all' || allowed.includes(m.model)) };
}

export function requireModel(settings, capabilities) {
  if (capabilities.protocol !== 2 || !Array.isArray(capabilities.models)) throw new Error('Provider model capabilities are unconfirmed or incompatible. Upgrade both endpoints before sending task files.');
  const selected = capabilities.models.find(m => m.model === settings.model);
  if (!selected || !Array.isArray(selected.reasoningEfforts) || !selected.reasoningEfforts.includes(settings.reasoningEffort)) {
    throw new Error(`${settings.model} / ${settings.reasoningEffort} is not available or allowed. Choose from: ${JSON.stringify(capabilities.models)}. No alternative was selected.`);
  }
}
