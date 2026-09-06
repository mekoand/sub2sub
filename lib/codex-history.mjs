import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// The provider derives the directory from its authenticated pairing. Never
// accept a caller-supplied native thread ID or an arbitrary deletion path.
export async function manageTaskHistory({ executable, root, taskId, threadId, retain = false, signal }) {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, stderr = '', closed = false, failure;
  const deleted = new Set();
  const fail = error => {
    failure = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const exited = new Promise(resolve => child.once('close', code => {
    closed = true;
    fail(new Error(`Codex history connection closed (${code}). ${stderr}`));
    resolve();
  }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out. Cleanup may be partial; retry the same task.`)); }, 30000);
      pending.set(id, { resolve, reject, timer, method });
      send({ id, method, params });
    });
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method === 'thread/deleted') deleted.add(message.params.threadId);
      if (message.id === undefined) return;
      if (message.method) {
        send({ id: message.id, error: { code: -32000, message: 'Cleanup cannot grant extra permissions.' } });
        throw new Error(`Owner action required during cleanup: ${message.method}`);
      }
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(new Error(`Codex ${item.method}: ${JSON.stringify(message.error)}. Native cleanup is incomplete; retry after resolving this error.`));
      else item.resolve(message.result);
    } catch (error) { fail(error); }
  });
  const abort = () => fail(new Error('Cleanup connection interrupted. Retry the same cleanup to resolve any partial deletion.'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    await request('initialize', { clientInfo: { name: 'sub2sub-cleanup', version: '0.5.1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const targets = new Map();
    const marker = (id, nativeId) => `[sub2sub:${id}:${nativeId}]`;
    for (const archived of [false, true]) {
      let cursor;
      do {
        const page = await request('thread/list', { archived, cursor, limit: 100, sourceKinds: ['appServer', 'vscode', 'cli', 'exec', 'unknown'], ...(taskId ? { cwd: path.join(root, taskId, 'work') } : {}) });
        if (!Array.isArray(page.data) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('Invalid Codex thread listing; no further history deleted.');
        for (const summary of page.data) {
          const relative = path.relative(root, summary.cwd);
          const parts = relative.split(path.sep);
          if (parts.length !== 2 || parts[1] !== 'work' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(parts[0])) continue;
          if (taskId && parts[0] !== taskId) continue;
          // Codex 0.152 lists threadSource as null even when thread/read persists it.
          const { thread } = await request('thread/read', { threadId: summary.id, includeTurns: false });
          if (thread.cwd !== summary.cwd) throw new Error('Native task directory changed during cleanup. Retry after confirming its scope.');
          if (thread.threadSource === `sub2sub:${parts[0]}` && thread.forkedFromId === undefined) throw new Error('Codex did not return fork ownership metadata. Update Codex before native cleanup.');
          const owned = thread.id === threadId || (thread.threadSource === `sub2sub:${parts[0]}` && thread.forkedFromId === null) || thread.name?.endsWith(marker(parts[0], thread.id));
          if (!owned) continue;
          if (thread.status?.type === 'active') throw new Error('A native task conversation is still active. Stop it before deleting its history.');
          targets.set(thread.id, thread);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    for (const [id, thread] of targets) {
      if (retain) {
        const suffix = marker(taskId, id);
        if (!thread.name?.endsWith(suffix)) await request('thread/name/set', { threadId: id, name: `${thread.name || 'sub2sub task'} ${suffix}` });
        continue;
      }
      if (deleted.has(id)) continue;
      await request('thread/delete', { threadId: id });
      deleted.add(id);
    }
    return retain ? { nativeHistory: 'retained' } : { deletedThreads: deleted.size };
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const item of pending.values()) clearTimeout(item.timer);
    lines.close(); child.stdin.end();
    if (!closed) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000);
    await exited;
    clearTimeout(timer);
  }
}
