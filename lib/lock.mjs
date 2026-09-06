import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './files.mjs';

// A populated directory is claimed atomically; an exiting process cannot leave
// a newly acquired lock without its owner record.
export async function processLock(directory) {
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const candidate = await fs.mkdtemp(`${directory}.candidate-`);
  let acquired = false;
  try {
    await writeJson(path.join(candidate, `${randomUUID()}.json`), { pid: process.pid });
    try { await fs.rename(candidate, directory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) && !(process.platform === 'win32' && error.code === 'EPERM')) throw error;
      const files = await fs.readdir(directory);
      if (files.length !== 1 || !files[0].endsWith('.json')) throw new Error(`Incomplete process lock at ${directory}. Check the previous process before removing it.`);
      const file = path.join(directory, files[0]);
      const owner = await readJson(file);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Invalid process lock owner at ${directory}.`);
      try { process.kill(owner.pid, 0); throw new Error(`Another sub2sub process (${owner.pid}) owns ${directory}. Manage sharing in that Codex task, or retry after its update finishes.`); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
      // Only remove the observed owner's unique record. A concurrent recovery
      // cannot delete the new owner's record or replace a populated lock.
      await fs.unlink(file);
      if (process.platform === 'win32') await fs.rmdir(directory);
      await fs.rename(candidate, directory);
    }
    acquired = true;
    return async () => {
      await fs.rename(directory, candidate);
      await fs.rm(candidate, { recursive: true });
    };
  } finally {
    if (!acquired) await fs.rm(candidate, { recursive: true, force: true });
  }
}
