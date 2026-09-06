import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export async function openMcp(configPath, options = {}) {
  const child = spawn(options.command || process.execPath, options.args || [fileURLToPath(new URL('../../bin/mcp.mjs', import.meta.url))], {
    env: { ...process.env, ...options.env, SUB2SUB_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let sequence = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', code => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`MCP exited (${code}): ${stderr}`)); }
    pending.clear(); resolve(code);
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line), item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method} ${params?.name || ''}`)); }, options.timeoutMs || 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  await call('initialize', options.initialize || { protocolVersion: '2024-11-05' });
  return {
    child, request: call,
    async tool(name, args = {}) {
      const result = await call('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      const code = await exited;
      clearTimeout(timer); lines.close();
      if (code !== 0) throw new Error(`MCP shutdown failed (${code}): ${stderr}`);
    }
  };
}
