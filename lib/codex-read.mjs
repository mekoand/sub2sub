import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// A short-lived, read-only App Server connection shared by catalog and quota queries.
export async function readCodex(executable, cwd, signal, read) {
  const child = spawn(executable, ['-c', 'model_provider="openai"', 'app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, failure, stderr = '', bytes = 0;
  const fail = error => {
    failure = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const exited = new Promise(resolve => child.once('close', code => { fail(new Error(`Codex read exited (${code}). ${stderr}`)); resolve(); }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  child.stdout.on('data', data => { bytes += data.length; if (bytes > 4 * 1024 * 1024) fail(new Error('Codex read response is too large.')); });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params) => {
    if (failure) throw failure;
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex read ${method} timed out.`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) throw new Error(`Codex read requires owner action: ${message.method}`);
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(Object.assign(new Error(`Codex read: ${JSON.stringify(message.error)}`), { rpcCode: message.error.code }));
      else item.resolve(message.result);
    } catch (error) { fail(error); }
  });
  const abort = () => fail(new Error('Codex read cancelled; capabilities are unconfirmed.'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    await request('initialize', { clientInfo: { name: 'sub2sub-read', version: '0.5.3' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const identity = await request('account/read', { refreshToken: false });
    if (identity.account?.type !== 'chatgpt') throw Object.assign(new Error('Sign in with the execution node ChatGPT subscription.'), { code: 'LOGIN_REQUIRED' });
    return await read(request);
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const item of pending.values()) clearTimeout(item.timer);
    lines.close(); child.stdin.end(); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited; clearTimeout(timer);
  }
}
