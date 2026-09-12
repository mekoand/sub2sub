import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from './files.mjs';
import { taskId } from './provider.mjs';
import { processLock } from './lock.mjs';

// Only these application-owned layouts are eligible; persisted pointers never
// grant permission to delete another location or follow a symbolic link.
async function regularPath(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path is outside managed task storage.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not managed task data: ${current}`);
  }
}
async function measure(root, target) {
  try {
    await regularPath(root, target);
    const version = createHash('sha256');
    const walk = async file => {
      const stat = await fs.lstat(file);
      version.update(JSON.stringify([file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
      if (stat.isFile()) return { bytes: stat.size, files: 1 };
      if (!stat.isDirectory()) throw new Error(`Link or special file cannot be measured: ${file}`);
      let bytes = 0, files = 0;
      for (const name of (await fs.readdir(file)).sort()) { const item = await walk(path.join(file, name)); bytes += item.bytes; files += item.files; }
      return { bytes, files };
    };
    return { status: 'present', ...await walk(target), version: version.digest('hex') };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'unavailable', bytes: error.code === 'ENOENT' ? 0 : null, files: null, reason: error.message }; }
}
async function children(root, relative) {
  const target = path.join(root, relative);
  try { await regularPath(root, target); return await fs.readdir(target); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sum = entries => entries.some(e => e.bytes === null) ? null : entries.reduce((n, e) => n + e.bytes, 0);

export async function localStorage(root) {
  const records = new Map(), entries = new Map(), errors = [];
  const add = (target, kind, owner, snapshotId) => {
    if (!entries.has(target)) entries.set(target, { path: target, kind, taskId: owner, snapshotId, references: [], current: false });
    return entries.get(target);
  };
  for (const file of await children(root, 'tasks')) {
    if (!file.endsWith('.json')) continue;
    const id = taskId(file.slice(0, -5)), target = path.join(root, 'tasks', file);
    await regularPath(root, target);
    records.set(id, await readJson(target)); add(target, 'record', id);
  }
  for (const [folder, pattern, kind] of [['results', new RegExp(`^(${uuid})-.+$`, 'i'), 'result'], ['snapshots', new RegExp(`^(${uuid})\\.json$`, 'i'), 'snapshot']]) {
    try {
      for (const file of await children(root, folder)) {
        const match = file.match(pattern);
        if (match) add(path.join(root, folder, file), kind, kind === 'result' ? match[1] : undefined, kind === 'snapshot' ? match[1] : undefined);
      }
    } catch (error) { errors.push({ path: path.join(root, folder), reason: error.message }); }
  }
  try {
    for (const id of await children(root, 'workcopies')) {
      taskId(id);
      try { for (const copy of await children(root, path.join('workcopies', id))) if (copy.startsWith('copy-')) add(path.join(root, 'workcopies', id, copy), 'workcopy', id); }
      catch (error) { errors.push({ taskId: id, path: path.join(root, 'workcopies', id), reason: error.message }); }
    }
  } catch (error) { errors.push({ path: path.join(root, 'workcopies'), reason: error.message }); }
  for (const [id, saved] of records) {
    for (const [key, kind] of [['resultDirectory', 'result'], ['workCopyRoot', 'workcopy'], ['snapshotId', 'snapshot']]) {
      if (!saved[key]) continue;
      const target = key === 'snapshotId' ? path.join(root, 'snapshots', `${taskId(saved[key])}.json`) : saved[key];
      let entry = entries.get(target);
      if (!entry && typeof target === 'string') {
        const relative = path.relative(root, target).split(path.sep).join('/');
        const pattern = kind === 'result' ? new RegExp(`^results/(${uuid})-[^/]+$`, 'i') : kind === 'workcopy' ? new RegExp(`^workcopies/(${uuid})/copy-[^/]+$`, 'i') : new RegExp(`^snapshots/(${uuid})\\.json$`, 'i');
        const match = relative.match(pattern);
        if (match) entry = add(target, kind, kind === 'snapshot' ? undefined : match[1], kind === 'snapshot' ? match[1] : undefined);
      }
      if (entry && entry.kind === kind) { entry.references.push(id); entry.current = true; }
      else {
        // Missing pointers are reported, but never accepted as deletion paths.
        errors.push({ taskId: id, path: target, reason: `Saved ${kind} is missing or outside managed storage.` });
      }
    }
  }
  for (const entry of entries.values()) Object.assign(entry, await measure(root, entry.path));
  const files = [...entries.values()];
  const ids = new Set([...records.keys(), ...files.map(e => e.taskId).filter(Boolean)]);
  const tasks = [...ids].map(id => {
    const owned = files.filter(e => e.taskId === id || e.references.includes(id));
    return { taskId: id, recordPresent: records.has(id), peer: records.get(id)?.peer, status: records.get(id)?.status, bytes: sum(owned), oldBytes: sum(owned.filter(e => !e.current && e.kind !== 'record' && !e.references.length)), entries: owned };
  });
  return { checkedAt: new Date().toISOString(), bytes: errors.length ? null : sum(files), measuredBytes: files.reduce((n, e) => n + (e.bytes ?? 0), 0), tasks, snapshots: files.filter(e => e.kind === 'snapshot' && !e.references.length), errors,
    note: 'Local caller data only. Shared paths count once in the total, but may appear under multiple tasks. Sizes are file bytes; actual disk space reclaimed depends on the filesystem. Provider work copies use the existing provider cleanup actions.' };
}

export async function cleanupLocalFiles(root, input) {
  if (!['old', 'all'].includes(input.scope)) throw new Error('Choose old or all local files.');
  if (Boolean(input.taskId) === Boolean(input.snapshotId)) throw new Error('Choose one taskId or one unused snapshotId.');
  if (input.deleteRecord && (input.scope !== 'all' || !input.taskId)) throw new Error('Deleting the record requires all local files, so no untracked files remain.');
  const id = taskId(input.taskId || input.snapshotId);
  const releaseStorage = await processLock(path.join(root, '.local-files-lock'));
  let releaseTask;
  try {
    if (input.taskId) releaseTask = await processLock(path.join(root, 'tasks', '.locks', id));
    const inventory = await localStorage(root);
    if (inventory.errors.length) throw new Error(`Cannot safely plan cleanup: ${inventory.errors.map(e => e.reason).join('; ')}`);
    const task = inventory.tasks.find(t => t.taskId === input.taskId);
    const source = input.taskId ? task?.entries : inventory.snapshots.filter(e => e.snapshotId === id);
    if (!source?.length) throw new Error('No managed task or unused snapshot found.');
    const recordPath = path.join(root, 'tasks', `${id}.json`);
    const saved = task?.recordPresent ? await readJson(recordPath) : undefined;
    if (saved && !['completed', 'failed', 'interrupted', 'released', 'records_deleted', 'all_deleted'].includes(saved.status)) throw new Error('Task execution is active or unconfirmed. Resolve its status before local cleanup.');
    if (saved?.pendingSave) throw new Error('Result save confirmation is pending. Collect the result before local cleanup.');
    const selected = source.filter(e => e.kind === 'record' ? input.deleteRecord : (!e.taskId || e.taskId === id) && !e.references.some(ref => ref !== id) && (input.scope === 'all' || !e.current));
    const unavailable = selected.filter(e => e.status === 'unavailable');
    if (unavailable.length) throw new Error(`Cannot safely clean files: ${unavailable.map(e => e.reason).join('; ')}`);
    const plan = { taskId: input.taskId, snapshotId: input.snapshotId, scope: input.scope, deleteRecord: Boolean(input.deleteRecord), expectedBytes: sum(selected), entries: selected, retainedSharedPaths: source.filter(e => e.taskId && e.taskId !== id || e.references.some(ref => ref !== id)).map(e => e.path),
      impact: input.scope === 'old' ? 'Only old local generations are removed; latest delivery and recovery files remain.' : 'Local answers, outputs and recovery copies are removed. This installation cannot continue or collect this task afterward; start a new task with original inputs if needed. Remote data and original source files are unchanged.',
      recordImpact: input.deleteRecord ? 'The task disappears from local history and its recorded usage is removed.' : 'The task record and its usage remain.' };
    const previewToken = createHash('sha256').update(JSON.stringify([id, input.scope, Boolean(input.deleteRecord), saved, source])).digest('hex');
    if (!input.confirm) return { ...plan, previewToken, status: 'preview' };
    if (input.previewToken !== previewToken) throw new Error('Local files or task state changed, or the deletion preview is missing. Review a fresh preview before confirming.');
    const failures = [], removed = [];
    // Clear selected live pointers first: interruption or partial deletion must not
    // leave a usable delivery link pointing into an incomplete generation.
    if (saved && input.scope === 'all') {
      delete saved.resultDirectory; delete saved.workCopyRoot; delete saved.workCopyPaths;
      delete saved.snapshotId; delete saved.pendingSave;
      saved.localFilesCleaned = true;
      await writeJson(recordPath, saved);
    }
    for (const entry of selected.filter(e => e.kind !== 'record')) {
      try {
        const checked = await measure(root, entry.path);
        if (checked.status === 'unavailable') throw new Error(checked.reason);
        if (checked.status !== 'missing') await fs.rm(entry.path, { recursive: true });
        removed.push({ path: entry.path, bytes: checked.bytes });
      } catch (error) { failures.push({ path: entry.path, reason: error.message }); }
    }
    if (input.deleteRecord && !failures.length && task.recordPresent) {
      try { await regularPath(root, recordPath); const stat = await fs.stat(recordPath); await fs.unlink(recordPath); removed.push({ path: recordPath, bytes: stat.size }); }
      catch (error) { failures.push({ path: recordPath, reason: error.message }); }
    }
    return { ...plan, status: failures.length ? removed.length ? 'partial' : 'failed' : 'cleaned', removedBytes: removed.reduce((n, e) => n + e.bytes, 0), removed, failures };
  } finally { await releaseTask?.(); await releaseStorage(); }
}
