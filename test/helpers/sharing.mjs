import fs from 'node:fs/promises';
import path from 'node:path';

// Only stop the worker recorded inside this test's temporary state directory.
export async function stopTestSharing(stateRoot) {
  const file = path.join(stateRoot, 'sharing/runtime.json');
  let runtime;
  try { runtime = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try { process.kill(runtime.pid, 'SIGTERM'); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  const until = performance.now() + 8000;
  for (;;) {
    try { await fs.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (performance.now() >= until) throw new Error(`Test sharing node ${runtime.pid} did not stop.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
