import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshot, collectChanges, validateFiles, safePath, excluded, copyEntry, readJson, writeJson } from './files.mjs';

const fileHash = file => file.hash || createHash('sha256').update(Buffer.from(file.content, 'base64')).digest('hex');

export function manifestDigest(files) {
  const manifest = files.map(file => ({ path: file.path, hash: fileHash(file), executable: file.executable })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function updatedFiles(original, files, removed, limits) {
  validateFiles(files, { ...limits, result: true });
  if (!Array.isArray(removed) || new Set(removed).size !== removed.length) throw new Error('List each deleted file explicitly, once.');
  const combined = new Map(original.map(file => [file.path, file]));
  for (const name of removed) {
    safePath(name);
    if (excluded(name, { result: true }) || !combined.delete(name)) throw new Error(`Deletion must name a file in the saved task copy: ${name}`);
    if (files.some(file => file.path === name)) throw new Error(`A file cannot be uploaded and deleted together: ${name}`);
  }
  for (const file of files) combined.set(file.path, file);
  return [...combined.values()];
}

export async function prepareUpload(task, prepared, removed, limits, remote) {
  if (task.deliveryPending || !task.workCopyRoot || !remote.lastSync || task.savedRevision !== remote.revision || remote.savedRevision !== remote.revision || remote.pendingSync || !remote.savedManifestDigest) throw new Error('Collect and confirm the latest result before uploading task changes.');
  const storage = await fs.mkdtemp(path.join(task.workCopyRoot, 'upload-baseline-'));
  try {
    const baseline = await snapshot(path.join(task.workCopyRoot, 'files'), task.workCopyPaths, { result: true, allowEmpty: true, storage });
    const baseDigest = manifestDigest(baseline.files);
    if (baseDigest !== remote.savedManifestDigest) throw new Error('The saved task copy differs from the confirmed host baseline. Keep edits in a separate copy; collect and reconcile the latest result before uploading.');
    const before = new Map(baseline.files.map(file => [file.path, file]));
    const files = prepared.files.filter(file => {
      const previous = before.get(file.path);
      return !previous || fileHash(file) !== fileHash(previous) || file.executable !== previous.executable;
    });
    validateFiles(updatedFiles(baseline.files, files, removed, limits), { ...limits, result: true });
    return { baseRevision: task.savedRevision, baseDigest, files, removed };
  } finally { await fs.rm(storage, { recursive: true, force: true }); }
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// The swap belongs to this one task. A stopped process leaves its old copy available.
export async function recoverUpload(directory, state) {
  const work = path.join(directory, 'work'), backup = path.join(directory, 'upload-backup');
  if (await exists(backup)) {
    await fs.rm(work, { recursive: true, force: true });
    await fs.rename(backup, work);
  }
  if (!await exists(work)) throw new Error('Interrupted input update has no recoverable work copy. Keep this task for inspection and start a new task from saved local files.');
  await fs.rm(path.join(directory, 'upload-staging'), { recursive: true, force: true });
  state.status = 'interrupted'; state.error = 'Input update was interrupted before execution; previous work was recovered. Collect the result before explicitly continuing.';
  await writeJson(path.join(directory, 'state.json'), state);
}

export async function applyUpload(directory, state, upload, limits) {
  if (!upload || Object.keys(upload).some(key => !['baseRevision', 'baseDigest', 'files', 'removed'].includes(key))) throw new Error('Invalid task file update.');
  if (!state.lastSync || state.pendingSync || state.savedRevision !== state.revision || upload.baseRevision !== state.revision || upload.baseDigest !== state.savedManifestDigest) throw new Error('Task file baseline is stale or unconfirmed. Collect the latest result before uploading.');
  const original = await readJson(path.join(directory, 'original.json'));
  if (manifestDigest(original) !== upload.baseDigest) throw new Error('Task file baseline changed. Collect the latest result before uploading.');
  const combined = updatedFiles(original, upload.files, upload.removed, limits);
  const scan = path.join(directory, 'upload-scan');
  let changes;
  try { changes = await collectChanges(path.join(directory, 'work'), original, { result: true, temporaryFiles: state.temporaryFiles === true, storage: scan }); }
  finally { await fs.rm(scan, { recursive: true, force: true }); }
  if (changes.files.length || changes.removed.length) throw new Error('Host files changed after the last confirmed save. Collect the latest result and reconcile changes in a separate local copy before uploading.');
  const work = path.join(directory, 'work');
  const changed = new Map(upload.files.map(file => [file.path, file]));
  const complete = [];
  for (const file of combined) {
    if (changed.has(file.path)) { complete.push(file); continue; }
    const stat = await fs.lstat(path.join(work, file.path));
    if (!stat.isFile()) throw new Error(`Updated path is not a regular file: ${file.path}`);
    complete.push({ path: file.path, source: path.join(work, file.path), size: stat.size, hash: fileHash(file), executable: Boolean(stat.mode & 0o111) });
  }
  validateFiles(complete, { ...limits, result: true });
  if (!upload.files.length && !upload.removed.length) return;
  const staging = path.join(directory, 'upload-staging'), backup = path.join(directory, 'upload-backup');
  const before = { ...state };
  try {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
    await fs.cp(work, staging, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    for (const name of upload.removed) await fs.unlink(path.join(staging, name));
    for (const file of upload.files) {
      const destination = path.join(staging, file.path);
      if (await exists(destination)) {
        const stat = await fs.lstat(destination);
        if (stat.isDirectory()) throw new Error(`Cannot replace a directory with a file in one upload: ${file.path}. Resolve this layout in the task and collect it first.`);
        await fs.unlink(destination);
      }
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyEntry(file, destination);
    }
    state.status = 'updating'; await writeJson(path.join(directory, 'state.json'), state);
    await fs.rename(work, backup);
    await fs.rename(staging, work);
    Object.assign(state, before); await writeJson(path.join(directory, 'state.json'), state);
  } catch (error) {
    try {
      if (state.status === 'updating' || await exists(backup)) { await recoverUpload(directory, state); }
      else await fs.rm(staging, { recursive: true, force: true });
    } catch (recoveryError) { throw new AggregateError([error, recoveryError], `${error.message}; input recovery failed: ${recoveryError.message}. No new turn started.`); }
    throw error;
  }
  await fs.rm(backup, { recursive: true, force: true });
}
