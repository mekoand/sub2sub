import fs from 'node:fs/promises';
import path from 'node:path';
import { safePath, excluded, materialize, validateFiles, snapshot } from './files.mjs';
import { SUPPORT_BYTES, SUPPORT_FILES } from './limits.mjs';

async function checkDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative) safePath(relative.split(path.sep).join('/'));
  let current = root;
  for (const part of ['', ...(relative ? relative.split(path.sep) : [])]) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Work copy directory is not a regular directory: ${current}`);
  }
}

// Reuse an unchanged generation or build an independent one, then save its pointer.
// A failed download or patch never modifies the last complete local generation.
export async function buildWorkCopy(stateRoot, id, previous, input, changes, expectedPaths) {
  validateFiles(changes.files, { result: true, maxBytes: SUPPORT_BYTES, maxFiles: SUPPORT_FILES });
  for (const removed of changes.removed) {
    safePath(removed);
    if (excluded(removed, { result: true })) throw new Error(`Excluded deletion path: ${removed}`);
  }
  const copies = path.join(stateRoot, 'workcopies');
  await fs.mkdir(copies, { recursive: true, mode: 0o700 });
  await checkDirectory(stateRoot, copies);
  const root = path.join(copies, id);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await checkDirectory(stateRoot, root);
  if (previous) {
    if (path.dirname(previous) !== root) throw new Error('Saved work copy is outside this task.');
    await checkDirectory(stateRoot, previous);
    if (!changes.files.length && !changes.removed.length) {
      await checkWorkCopy(stateRoot, id, previous, expectedPaths);
      for (const entry of await fs.readdir(path.join(previous, 'files'), { recursive: true, withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Work copy contains a link or special file: ${path.join(entry.parentPath, entry.name)}`);
      }
      return previous;
    }
  }
  const staging = await fs.mkdtemp(path.join(root, 'copy-'));
  const work = path.join(staging, 'files');
  try {
    if (previous) {
      await fs.cp(path.join(previous, 'files'), work, { recursive: true, errorOnExist: true, force: false, filter: async source => {
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Work copy contains a link or special file: ${source}`);
        return true;
      } });
    } else await materialize(work, input, { maxBytes: SUPPORT_BYTES, maxFiles: SUPPORT_FILES });
    for (const name of changes.removed) {
      // Missing parent directories simply mean this deletion was already applied.
      const parent = path.dirname(path.join(work, name));
      try { await checkDirectory(work, parent); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await fs.rm(path.join(work, name), { recursive: true, force: true });
    }
    for (const file of changes.files) {
      const destination = path.join(work, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await checkDirectory(work, path.dirname(destination));
      await fs.rm(destination, { recursive: true, force: true });
      await fs.writeFile(destination, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
    }
    await checkWorkCopy(stateRoot, id, staging, expectedPaths);
    return staging;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreCopy(stateRoot, id, saved, paths, limits) {
  if (!saved || path.dirname(saved) !== path.join(stateRoot, 'workcopies', id)) throw new Error('A complete local task copy is required for restoration.');
  await checkDirectory(stateRoot, path.join(saved, 'files'));
  const copy = await snapshot(path.join(saved, 'files'), paths, { ...limits, result: true, allowEmpty: true });
  if (copy.skipped.length) throw new Error(`Required restoration files were excluded: ${copy.skipped.join(', ')}.`);
  return copy;
}


export async function checkWorkCopy(stateRoot, id, saved, paths) {
  if (!saved || path.dirname(saved) !== path.join(stateRoot, 'workcopies', id)) throw new Error('A complete local task copy is required.');
  const work = path.join(saved, 'files');
  await checkDirectory(stateRoot, work);
  for (const name of paths) {
    safePath(name);
    const target = path.join(work, name);
    await checkDirectory(work, path.dirname(target));
    if (!(await fs.lstat(target)).isFile()) throw new Error(`Work copy is incomplete: ${name} is not a regular file.`);
  }
}
