import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, materialize, collectChanges, safePath, validateFiles, MAX_FILES } from './files.mjs';
import { runCodex } from './codex.mjs';
import { runClaude, manageClaudeHistory } from './claude.mjs';
import { executionSettings, executionHarness, retentionDays } from './config.mjs';
import { manageTaskHistory } from './codex-history.mjs';
import { queryModels, modelCapabilities } from './models.mjs';
import { effectiveLimits, fileLimits, WIRE_BYTES } from './limits.mjs';

export function taskId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error('Invalid task ID.');
  return value;
}

export async function inspectTask(directory, details = false) {
  const inspection = { checkedAt: new Date().toISOString(), workCopyExists: false };
  const work = path.join(directory, 'work');
  let stat;
  try { stat = await fs.lstat(work); }
  catch (error) { if (error.code === 'ENOENT') return inspection; throw error; }
  inspection.workCopyExists = true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { ...inspection, issue: 'Work copy path is not a regular directory.' };
  if (details) {
    let bytes = 0, fileCount = 0;
    const visit = async dir => {
      for (const name of await fs.readdir(dir)) {
        const file = path.join(dir, name), stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw new Error(`Cannot inspect linked task path: ${file}`);
        if (stat.isDirectory()) await visit(file);
        else if (stat.isFile()) { bytes += stat.size; fileCount++; }
        else throw new Error(`Cannot inspect special task path: ${file}`);
      }
    };
    try { await visit(work); Object.assign(inspection, { bytes, fileCount }); }
    catch (error) { inspection.issue = error.message; }
  }
  return inspection;
}

export async function providerRequest(request, { root, executable = 'codex', onProgress = () => {}, signal = new AbortController().signal, ownerCleanup = false, limits, retention = 7, modelInfo }) {
  if (!path.isAbsolute(root)) throw new Error('Provider task root must be an absolute path.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  root = await fs.realpath(root);
  if (request.action === 'check') return { protocol: 1, taskRoot: root, transport: 'stdio' };
  if (request.action === 'models') return modelCapabilities(await queryModels(executable, root, signal));
  const directory = path.join(root, taskId(request.taskId));
  if (request.action === 'finish' && !['keep', 'workcopy', 'records', 'all'].includes(request.cleanup)) throw new Error('Choose cleanup explicitly: keep, workcopy, records or all.');
  if (request.action === 'finish' && request.cleanup === 'keep') return { taskId: request.taskId, status: 'retained' };
  const statePath = path.join(directory, 'state.json');
  if (request.action === 'run' && request.snapshot) {
    const accepted = effectiveLimits(request.limits, limits);
    const harnessFile = path.join(root, '.harnesses.json');
    let used;
    try { used = await readJson(harnessFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; used = (await fs.readdir(root)).length ? ['codex'] : []; }
    await writeJson(harnessFile, [...new Set([...used, executionHarness(request)])]);
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      await materialize(path.join(directory, 'work'), request.snapshot.files, fileLimits(accepted, 'input'));
      await writeJson(path.join(directory, 'original.json'), request.snapshot.files);
      await writeJson(statePath, { taskId: request.taskId, harness: executionHarness(request), createdAt: new Date().toISOString(), status: 'ready', revision: 0, threadId: null, response: '', limits: accepted, syncVersion: 1, savedRevision: 0, temporaryFiles: true, retentionDays: retentionDays({ retentionDays: retention }) });
    } catch (error) {
      await writeJson(statePath, { taskId: request.taskId, harness: executionHarness(request), status: 'failed', revision: 0, threadId: null, response: '', error: error.message });
      throw error;
    }
  }
  if (request.action === 'status') {
    let recorded;
    try { recorded = await readJson(statePath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; recorded = { taskId: request.taskId, status: 'unknown', reason: 'Task record is missing; native history has not been checked.' }; }
    return { ...recorded, inspection: await inspectTask(directory, request.details) };
  }
  if (request.action === 'cancel') {
    const state = await readJson(statePath);
    if (state.status !== 'running') return state;
    await fs.writeFile(path.join(directory, 'cancel'), '', { mode: 0o600 });
    return { taskId: request.taskId, status: 'cancellation-requested' };
  }
  if (!['run', 'result', 'finish', 'ack', 'restore'].includes(request.action)) throw new Error(`Unknown provider action: ${request.action}`);
  if (['run', 'restore'].includes(request.action) && (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 100000)) throw new Error('A non-empty prompt of at most 100000 characters is required.');
  if (request.model !== undefined && (typeof request.model !== 'string' || request.model.length > 100)) throw new Error('Invalid model.');
  const locks = path.join(root, '.locks');
  await fs.mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, request.taskId);
  try { await fs.mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('This task already has a running turn. If its SSH connection was lost, the provider must check the process before removing the running directory.'); throw error; }
  try {
    try { await fs.stat(path.join(directory, 'running')); throw new Error('A legacy task lock is present. Confirm the old process has stopped before cleanup or further work.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let state;
    try { state = await readJson(statePath); }
    catch (error) { if (error.code !== 'ENOENT' || request.action !== 'finish') throw error; }
    const harness = executionHarness(state || request);
    if (['run', 'restore'].includes(request.action) && executionHarness(request) !== harness) throw new Error(`This task belongs to ${harness}. Switch the provider back before continuing.`);
    if (request.action === 'finish') {
      if (state?.status === 'running') throw new Error('Task is still running; stop it before cleanup.');
      if (request.cleanup === 'workcopy') {
        if (!state?.syncVersion) throw new Error('This old task lacks confirmed local recovery information. Keep it or choose explicit legacy cleanup.');
        if (state.status === 'released' && !ownerCleanup) {
          if ((await inspectTask(directory)).workCopyExists) throw new Error('Work files reappeared after cleanup; inspect them before deleting.');
          return { taskId: request.taskId, status: 'released', cleanup: state.cleanup };
        }
        if (!['releasing', 'released'].includes(state.status)) {
          if (!ownerCleanup) {
            if (!state.lastSync || state.savedRevision !== state.revision || state.pendingSync) throw new Error('Latest results are not saved locally; collect them before cleanup.');
            const delta = await collectChanges(path.join(directory, 'work'), await readJson(path.join(directory, 'original.json')), { ...fileLimits(state.limits, 'result'), temporaryFiles: state.temporaryFiles === true });
            if (delta.files.length || delta.removed.length) throw new Error('Work files changed after the last save; collect the latest result before cleanup.');
            const discard = request.discardPaths || [];
            if (!Array.isArray(discard) || discard.length > MAX_FILES) throw new Error('Invalid discarded paths.');
            for (const name of discard) safePath(name);
            const unresolved = [...new Set([...(state.unresolvedSkipped || []), ...delta.skipped])].filter(p => !discard.includes(p));
            if (unresolved.length) throw new Error(`Resolve skipped necessary files before cleanup: ${unresolved.join(', ')}.`);
          }
          state.restorePaths = (await readJson(path.join(directory, 'original.json'))).map(f => f.path);
          state.discardedRevision = ownerCleanup ? state.revision : undefined;
        }
        state.status = 'releasing';
        state.cleanup = { status: 'cleaning', startedAt: new Date().toISOString() };
        await writeJson(statePath, state);
        try {
          for (const name of (await fs.readdir(directory)).filter(n => n !== 'state.json')) await fs.rm(path.join(directory, name), { recursive: true, force: true });
          delete state.response; delete state.progress; delete state.pendingSync;
          state.status = 'released';
          state.cleanup = { status: 'cleaned', cleanedAt: new Date().toISOString(), nativeHistory: 'retained' };
          await writeJson(statePath, state);
          return { taskId: request.taskId, status: 'released', cleanup: state.cleanup };
        } catch (error) {
          state.cleanup = { status: 'failed', error: error.message };
          await writeJson(statePath, state); throw error;
        }
      }
      if (state && !['finishing', 'finished', 'released', 'releasing'].includes(state.status)) {
        if (!ownerCleanup && (state.revision !== request.revision || !Number.isInteger(request.revision))) throw new Error('Download the latest result before cleaning this task.');
        if (!ownerCleanup) {
          if (state.syncVersion && (!state.lastSync || state.savedRevision !== state.revision || state.pendingSync)) throw new Error('Latest results are not saved locally; collect them before cleanup.');
          const discard = request.discardPaths === undefined ? [] : request.discardPaths;
          if (!Array.isArray(discard) || discard.length > MAX_FILES) throw new Error('discardPaths must list unneeded skipped paths.');
          for (const name of discard) safePath(name);
          const delta = await collectChanges(path.join(directory, 'work'), await readJson(path.join(directory, 'original.json')), { ...fileLimits(state.limits, 'result'), temporaryFiles: state.temporaryFiles === true });
          if (state.syncVersion && (delta.files.length || delta.removed.length)) throw new Error('Work files changed after the last save; collect the latest result before cleanup.');
          const unresolved = [...new Set([...(state.unresolvedSkipped || []), ...delta.skipped])].filter(name => !discard.includes(name));
          if (unresolved.length) throw new Error(`Resolve skipped paths before cleanup: ${unresolved.join(', ')}.`);
        }
        state.status = 'finishing';
        await writeJson(statePath, state);
      }
      const manageHistory = harness === 'claude' ? manageClaudeHistory : manageTaskHistory;
      const history = request.cleanup === 'all'
        ? await manageHistory({ executable, root, taskId: request.taskId, threadId: state?.threadId, signal })
        : state?.threadId && !state.historyTagged ? await manageHistory({ executable, root, taskId: request.taskId, threadId: state.threadId, retain: true, signal }) : {};
      await fs.rm(directory, { recursive: true, force: true });
      return { taskId: request.taskId, status: request.cleanup === 'all' ? 'all_deleted' : 'records_deleted', ...history };
    }
    if (request.action === 'restore') {
      if (!['released', 'restoring'].includes(state.status) || !state.restorePaths) throw new Error('This task is not ready for work copy restoration.');
      if (state.discardedRevision !== undefined || state.savedRevision !== request.revision || request.revision !== state.revision) throw new Error('The latest task results are unavailable locally; cannot silently restore an older copy.');
      const accepted = effectiveLimits(request.limits, limits);
      validateFiles(request.snapshot?.files, { ...fileLimits(accepted, 'input'), result: true });
      const paths = new Set(request.snapshot.files.map(f => f.path));
      if (paths.size !== state.restorePaths.length || state.restorePaths.some(p => !paths.has(p))) throw new Error('Restoration files do not match the provider-owned task scope.');
      if (state.status === 'released') {
        if ((await inspectTask(directory)).workCopyExists) throw new Error('Unexpected files appeared after cleanup. Inspect them before restoring.');
        state.status = 'restoring'; await writeJson(statePath, state);
      }
      const work = path.join(directory, 'work');
      if ((await inspectTask(directory)).workCopyExists) {
        const delta = await collectChanges(work, request.snapshot.files, { ...fileLimits(state.limits, 'result'), temporaryFiles: state.temporaryFiles === true });
        if (delta.files.length || delta.removed.length || delta.skipped.length) throw new Error('Interrupted restoration has different files; inspect this task before retrying.');
      } else {
        const staging = path.join(directory, 'restoration');
        await fs.rm(staging, { recursive: true, force: true });
        await materialize(staging, request.snapshot.files, { ...fileLimits(accepted, 'input'), result: true });
        await fs.rename(staging, work);
      }
      await writeJson(path.join(directory, 'original.json'), request.snapshot.files);
      state.status = 'ready'; state.response = ''; delete state.cleanup; delete state.restorePaths;
      await writeJson(statePath, state);
      // Restore and execute under the same task lock, with no cleanup window between them.
    }
    if (request.action === 'ack' && state.lastSync?.id === request.syncId && state.lastSync.revision === request.revision) return { taskId: request.taskId, savedRevision: state.savedRevision };
    if (['finished', 'released', 'releasing', 'restoring'].includes(state.status)) {
      throw new Error('Task was finished and its work copy removed.');
    }
    if (state.status === 'running') throw new Error('Task has an unfinished turn; the provider must check its process before recovery.');
    if (state.status === 'finishing') throw new Error('Task cleanup has already started; retry finish_task to complete it.');
    if (request.action === 'ack') {
      if (!state.pendingSync || state.pendingSync.id !== request.syncId || state.pendingSync.revision !== request.revision) throw new Error('Save confirmation does not match the pending task result. Collect the result again.');
      const packet = await readJson(path.join(directory, 'pending-result.json'));
      await writeJson(path.join(directory, 'original.json'), await readJson(path.join(directory, 'pending-manifest.json')));
      state.savedRevision = request.revision;
      state.unresolvedSkipped = packet.changes.skipped;
      state.lastSync = state.pendingSync;
      delete state.pendingSync;
      await writeJson(statePath, state);
      return { taskId: request.taskId, savedRevision: state.savedRevision, unresolvedSkipped: state.unresolvedSkipped };
    }
    if (request.action === 'result') {
      if (state.pendingSync) return readJson(path.join(directory, 'pending-result.json'));
      const { manifest, ...changes } = await collectChanges(path.join(directory, 'work'), await readJson(path.join(directory, 'original.json')), { ...fileLimits(state.limits, 'result'), temporaryFiles: state.temporaryFiles === true });
      if (!state.syncVersion) return { ...state, changes };
      const packet = { ...state, syncId: randomUUID(), baseRevision: state.savedRevision, changes };
      await writeJson(path.join(directory, 'pending-manifest.json'), manifest);
      await writeJson(path.join(directory, 'pending-result.json'), packet);
      state.pendingSync = { id: packet.syncId, revision: state.revision };
      await writeJson(statePath, state);
      return packet;
    }
    if (state.pendingSync) throw new Error('A result is waiting for local save confirmation. Collect it before continuing.');
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal.addEventListener('abort', relayAbort, { once: true });
    if (signal.aborted) controller.abort();
    let progress = '';
    let polling = false;
    let ioError;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        try { await fs.stat(path.join(directory, 'cancel')); controller.abort(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (progress !== state.progress) {
          state.progress = progress;
          await writeJson(statePath, state);
          onProgress(progress);
        }
      } catch (error) { ioError = error; controller.abort(); }
      finally { polling = false; }
    }, 500);
    try {
      await fs.rm(path.join(directory, 'cancel'), { force: true });
      state.status = 'running';
      state.revision++;
      delete state.error;
      delete state.stopReason;
      state.response = '';
      state.progress = '';
      const settings = executionSettings(request, harness);
      Object.assign(state, settings);
      await writeJson(statePath, state);
      const temporaryDirectory = state.temporaryFiles ? path.join(directory, 'work/.sub2sub') : undefined;
      if (temporaryDirectory) await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      const result = await (harness === 'claude' ? runClaude : runCodex)({
        executable, workspace: path.join(directory, 'work'), threadId: state.threadId, resolvedModel: modelInfo?.resolvedModel,
        prompt: request.prompt, temporaryDirectory, ...settings, signal: controller.signal,
        onThread: async (id, historyTagged) => { state.threadId = id; state.historyTagged = historyTagged; await writeJson(statePath, state); },
        onProgress: value => { progress = value; }
      });
      if (ioError) throw ioError;
      Object.assign(state, result);
      return state;
    } catch (error) {
      const timeLimit = error.code === 'SUB2SUB_TURN_TIMEOUT';
      state.status = timeLimit || controller.signal.aborted ? 'interrupted' : 'failed';
      state.error = error.message;
      if (timeLimit) { state.stopReason = 'time_limit'; return state; }
      throw error;
    } finally {
      clearInterval(timer);
      // Let an already-started disk update finish before writing final state.
      while (polling) await new Promise(resolve => setTimeout(resolve, 10));
      signal.removeEventListener('abort', relayAbort);
      state.endedAt = new Date().toISOString();
      if (state.retentionDays !== undefined) state.expiresAt = new Date(Date.now() + state.retentionDays * 86400000).toISOString();
      await writeJson(statePath, state);
    }
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  const executable = process.argv[3] || 'codex';
  let data = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      data += chunk;
      if (Buffer.byteLength(data) > WIRE_BYTES) throw new Error('Request is too large.');
    }
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    process.once('SIGHUP', () => controller.abort());
    process.stdout.on('error', () => controller.abort());
    const result = await providerRequest(JSON.parse(data), {
      root, executable, signal: controller.signal,
      onProgress: message => process.stdout.write(`${JSON.stringify({ progress: message })}\n`)
    });
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
}
