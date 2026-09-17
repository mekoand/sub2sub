import { readRequest, writeMessage, releaseReceived, legacyMessage } from './transfer.mjs';
import fs from 'node:fs/promises';
import { measuredRounds } from './statistics.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, materialize, collectChanges, safePath, validateFiles } from './files.mjs';
import { runCodex } from './codex.mjs';
import { runClaude, manageClaudeHistory } from './claude.mjs';
import { executionSettings, executionHarness, retentionDays } from './config.mjs';
import { manageTaskHistory } from './codex-history.mjs';
import { queryModels, modelCapabilities } from './models.mjs';
import { effectiveLimits, fileLimits, legacyLimits, transferWarning } from './limits.mjs';

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

function retentionRecord(state, status, cleanup) {
  return { taskId: state.taskId, harness: state.harness, threadId: state.threadId, createdAt: state.createdAt, endedAt: state.endedAt, revision: state.revision, retentionDays: state.retentionDays, cleanupAllOnExpiry: true, expiresAt: state.expiresAt, status, pendingSync: state.pendingSync, lastSync: state.lastSync, savedRevision: state.savedRevision, cleanup };
}

export async function providerRequest(request, { root, executable = 'codex', onProgress = () => {}, signal = new AbortController().signal, ownerCleanup = false, expiryCleanup = false, limits, retention = 7, cleanupAllOnExpiry = false, keepSessionVisible = false, modelInfo, onResult, onRoundStart = async () => false, onRoundEnd = async () => {} }) {
  if (!path.isAbsolute(root)) throw new Error('Host task root must be an absolute path.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  root = await fs.realpath(root);
  if (request.action === 'check') return { protocol: 1, taskRoot: root, transport: 'stdio' };
  if (request.action === 'models') return modelCapabilities(await queryModels(executable, root, signal), { ...limits });
  const directory = path.join(root, taskId(request.taskId));
  if (request.action === 'finish' && !['keep', 'workcopy', 'records', 'all'].includes(request.cleanup)) throw new Error('Choose cleanup explicitly: keep, workcopy, records or all.');
  if (request.action === 'finish' && request.cleanup === 'keep') return { taskId: request.taskId, status: 'retained' };
  const statePath = path.join(directory, 'state.json');
  if (request.action === 'run' && request.snapshot) {
    const accepted = effectiveLimits(request.limits ?? (request.protocol === 3 ? {} : legacyLimits()), limits);
    const harnessFile = path.join(root, '.harnesses.json');
    let used;
    try { used = await readJson(harnessFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; used = (await fs.readdir(root)).length ? ['codex'] : []; }
    await writeJson(harnessFile, [...new Set([...used, executionHarness(request)])]);
    await fs.mkdir(directory, { mode: 0o700 });
    const initial = { taskId: request.taskId, harness: executionHarness(request), ...(executionHarness(request) === 'codex' ? { keepSessionVisible } : {}), createdAt: new Date().toISOString(), status: 'ready', revision: 0, threadId: null, response: '', limits: accepted, syncVersion: 1, savedRevision: 0, temporaryFiles: true, retentionDays: retentionDays({ retentionDays: retention }), ...(cleanupAllOnExpiry ? { cleanupAllOnExpiry: true, expiresAt: new Date(Date.now() + retention * 86400000).toISOString() } : {}) };
    try {
      await writeJson(statePath, initial);
      await materialize(path.join(directory, 'work'), request.snapshot.files, fileLimits(accepted, 'input'));
      await writeJson(path.join(directory, 'original.json'), request.snapshot.files.map(({ path, hash, executable, content }) => ({ path, executable, ...(hash ? { hash } : { content }) })));
    } catch (error) {
      await writeJson(statePath, { ...initial, status: 'failed', error: error.message });
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
  if (!['run', 'result', 'finish', 'ack', 'restore'].includes(request.action)) throw new Error(`Unknown host action: ${request.action}`);
  if (['run', 'restore'].includes(request.action) && (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 100000)) throw new Error('A non-empty prompt of at most 100000 characters is required.');
  if (request.model !== undefined && (typeof request.model !== 'string' || request.model.length > 100)) throw new Error('Invalid model.');
  const locks = path.join(root, '.locks');
  await fs.mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, request.taskId);
  try { await fs.mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('This task already has a running turn. If its SSH connection was lost, the host must check the process before removing the running directory.'); throw error; }
  try {
    try { await fs.stat(path.join(directory, 'running')); throw new Error('A legacy task lock is present. Confirm the old process has stopped before cleanup or further work.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let state;
    try { state = await readJson(statePath); }
    catch (error) { if (error.code !== 'ENOENT' || request.action !== 'finish') throw error; }
    const harness = executionHarness(state || request);
    if (['run', 'restore'].includes(request.action) && executionHarness(request) !== harness) throw new Error(`This task belongs to ${harness}. Switch the host back before continuing.`);
    if (['run', 'restore'].includes(request.action) && state?.cleanupAllOnExpiry && Date.now() >= Date.parse(state.expiresAt)) throw new Error('Task retention expired. The original session cannot continue; start a new task from available local files.');
    if (request.action === 'ack' && typeof request.syncId === 'string' && ['expiring', 'expired'].includes(state?.status) && (state.pendingSync?.id === request.syncId || state.lastSync?.id === request.syncId) && state.revision === request.revision) {
      state.lastSync = { id: request.syncId, revision: request.revision }; state.savedRevision = request.revision;
      delete state.pendingSync;
      await writeJson(statePath, state);
      return { taskId: request.taskId, savedRevision: request.revision, status: state.status };
    }
    if (['expiring', 'expired'].includes(state?.status) && request.action !== 'finish') throw new Error('Task retention expired. Remote task content is no longer available and the original session cannot continue.');
    if (request.action === 'finish') {
      if (expiryCleanup) {
        if (!state?.cleanupAllOnExpiry || !state.expiresAt || Date.now() < Date.parse(state.expiresAt)) return { taskId: request.taskId, status: 'retained' };
        if (!['ready', 'completed', 'failed', 'interrupted', 'released', 'releasing', 'finishing', 'records_deleted', 'expiring'].includes(state.status)) throw new Error(`Task state ${state.status} does not permit automatic cleanup.`);
        // Keep ownership and sync receipt metadata for retries, never task text or usage history.
        state = retentionRecord(state, 'expiring', { status: 'cleaning', startedAt: new Date().toISOString() });
        await writeJson(statePath, state);
      }
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
            const delta = await collectChanges(path.join(directory, 'work'), await readJson(path.join(directory, 'original.json')), { ...fileLimits(state.limits ?? legacyLimits(), 'result'), temporaryFiles: state.temporaryFiles === true, storage: path.join(directory, 'scan-files') });
            await Promise.all(delta.files.filter(file => file.source).map(file => fs.rm(file.source, { force: true })));
            if (delta.files.length || delta.removed.length) throw new Error('Work files changed after the last save; collect the latest result before cleanup.');
            const discard = request.discardPaths || [];
            if (!Array.isArray(discard)) throw new Error('Invalid discarded paths.');
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
      if (state && !['finishing', 'finished', 'released', 'releasing', 'records_deleted', 'expiring', 'expired'].includes(state.status)) {
        if (!ownerCleanup && (state.revision !== request.revision || !Number.isInteger(request.revision))) throw new Error('Download the latest result before cleaning this task.');
        if (!ownerCleanup) {
          if (state.syncVersion && (!state.lastSync || state.savedRevision !== state.revision || state.pendingSync)) throw new Error('Latest results are not saved locally; collect them before cleanup.');
          const discard = request.discardPaths === undefined ? [] : request.discardPaths;
          if (!Array.isArray(discard)) throw new Error('discardPaths must list unneeded skipped paths.');
          for (const name of discard) safePath(name);
          const delta = await collectChanges(path.join(directory, 'work'), await readJson(path.join(directory, 'original.json')), { ...fileLimits(state.limits ?? legacyLimits(), 'result'), temporaryFiles: state.temporaryFiles === true, storage: path.join(directory, 'scan-files') });
          await Promise.all(delta.files.filter(file => file.source).map(file => fs.rm(file.source, { force: true })));
          if (state.syncVersion && (delta.files.length || delta.removed.length)) throw new Error('Work files changed after the last save; collect the latest result before cleanup.');
          const unresolved = [...new Set([...(state.unresolvedSkipped || []), ...delta.skipped])].filter(name => !discard.includes(name));
          if (unresolved.length) throw new Error(`Resolve skipped paths before cleanup: ${unresolved.join(', ')}.`);
        }
        state.status = 'finishing';
        await writeJson(statePath, state);
      }
      const manageHistory = harness === 'claude' ? manageClaudeHistory : manageTaskHistory;
      try {
        const history = request.cleanup === 'all'
          ? await manageHistory({ executable, root, taskId: request.taskId, threadId: state?.threadId, signal })
          : state?.threadId && !state.historyTagged ? await manageHistory({ executable, root, taskId: request.taskId, threadId: state.threadId, retain: true, signal }) : {};
        const retainDeadline = request.cleanup === 'records' && state?.cleanupAllOnExpiry && state.status !== 'expired';
        if (expiryCleanup || retainDeadline) {
          if (retainDeadline) {
            state = retentionRecord(state, 'finishing', { status: 'cleaning', nativeHistory: 'retained' });
            await writeJson(statePath, state);
          }
          for (const name of (await fs.readdir(directory)).filter(name => name !== 'state.json')) await fs.rm(path.join(directory, name), { recursive: true, force: true });
          state.status = expiryCleanup ? 'expired' : 'records_deleted';
          if (expiryCleanup) delete state.threadId;
          state.cleanup = { status: 'cleaned', cleanedAt: new Date().toISOString(), nativeHistory: expiryCleanup ? 'deleted' : 'retained' };
          await writeJson(statePath, state);
          return state;
        }
        await fs.rm(directory, { recursive: true, force: true });
        return { taskId: request.taskId, status: request.cleanup === 'all' ? 'all_deleted' : 'records_deleted', ...history };
      } catch (error) {
        if (expiryCleanup) {
          state.cleanup = { status: 'failed', error: error.message };
          try { await writeJson(statePath, state); }
          catch (writeError) { throw new AggregateError([error, writeError], `${error.message}; ${writeError.message}`); }
        }
        throw error;
      }
    }
    if (request.action === 'restore') {
      if (!['released', 'restoring'].includes(state.status) || !state.restorePaths) throw new Error('This task is not ready for work copy restoration.');
      if (state.discardedRevision !== undefined || state.savedRevision !== request.revision || request.revision !== state.revision) throw new Error('The latest task results are unavailable locally; cannot silently restore an older copy.');
      const accepted = effectiveLimits(state.limits ?? legacyLimits(), effectiveLimits(request.limits ?? (request.protocol === 3 ? {} : legacyLimits()), limits));
      validateFiles(request.snapshot?.files, { ...fileLimits(accepted, 'input'), result: true });
      const paths = new Set(request.snapshot.files.map(f => f.path));
      if (paths.size !== state.restorePaths.length || state.restorePaths.some(p => !paths.has(p))) throw new Error('Restoration files do not match the host-owned task scope.');
      if (state.status === 'released') {
        if ((await inspectTask(directory)).workCopyExists) throw new Error('Unexpected files appeared after cleanup. Inspect them before restoring.');
        state.status = 'restoring'; await writeJson(statePath, state);
      }
      const work = path.join(directory, 'work');
      if ((await inspectTask(directory)).workCopyExists) {
        const delta = await collectChanges(work, request.snapshot.files, { ...fileLimits(state.limits ?? legacyLimits(), 'result'), temporaryFiles: state.temporaryFiles === true, storage: path.join(directory, 'scan-files') });
        await Promise.all(delta.files.filter(file => file.source).map(file => fs.rm(file.source, { force: true })));
        if (delta.files.length || delta.removed.length || delta.skipped.length) throw new Error('Interrupted restoration has different files; inspect this task before retrying.');
      } else {
        const staging = path.join(directory, 'restoration');
        await fs.rm(staging, { recursive: true, force: true });
        await materialize(staging, request.snapshot.files, { ...fileLimits(accepted, 'input'), result: true });
        await fs.rename(staging, work);
      }
      await writeJson(path.join(directory, 'original.json'), request.snapshot.files.map(({ path, hash, executable, content }) => ({ path, executable, ...(hash ? { hash } : { content }) })));
      state.status = 'ready'; state.response = ''; delete state.cleanup; delete state.restorePaths;
      await writeJson(statePath, state);
      // Restore and execute under the same task lock, with no cleanup window between them.
    }
    if (request.action === 'ack' && state.lastSync?.id === request.syncId && state.lastSync.revision === request.revision) return { taskId: request.taskId, savedRevision: state.savedRevision };
    if (['finished', 'released', 'releasing', 'restoring'].includes(state.status)) {
      throw new Error('Task was finished and its work copy removed.');
    }
    if (state.status === 'running') throw new Error('Task has an unfinished turn; the host must check its process before recovery.');
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
      await fs.rm(path.join(directory, 'scan-files'), { recursive: true, force: true });
      return { taskId: request.taskId, savedRevision: state.savedRevision, unresolvedSkipped: state.unresolvedSkipped };
    }
    if (request.action === 'result') {
      if (state.pendingSync) {
        const packet = await readJson(path.join(directory, 'pending-result.json'));
        const warning = transferWarning(packet.changes.files.reduce((n, f) => n + (f.size ?? Buffer.byteLength(f.content, 'base64')), 0));
        if (warning) onProgress(warning);
        return onResult ? await onResult(packet) : packet;
      }
      const { manifest, ...changes } = await collectChanges(path.join(directory, 'work'), await readJson(path.join(directory, 'original.json')), { ...fileLimits(state.limits ?? legacyLimits(), 'result'), temporaryFiles: state.temporaryFiles === true, storage: path.join(directory, 'scan-files') });
      if (!state.syncVersion) { const packet = { ...state, changes }; return onResult ? await onResult(packet) : packet; }
      const warning = transferWarning(changes.files.reduce((n, f) => n + (f.size ?? Buffer.byteLength(f.content, 'base64')), 0));
      if (warning) onProgress(warning);
      const packet = { ...state, syncId: randomUUID(), baseRevision: state.savedRevision, changes };
      await writeJson(path.join(directory, 'pending-manifest.json'), manifest);
      await writeJson(path.join(directory, 'pending-result.json'), packet);
      state.pendingSync = { id: packet.syncId, revision: state.revision };
      await writeJson(statePath, state);
      return onResult ? await onResult(packet) : packet;
    }
    if (state.pendingSync) throw new Error('A result is waiting for local save confirmation. Collect it before continuing.');
    if (state.keepSessionVisible !== undefined && typeof state.keepSessionVisible !== 'boolean') throw new Error('Invalid saved task visibility setting. Inspect the task record before continuing.');
    if (harness === 'codex' && state.keepSessionVisible === false && state.threadId) {
      try {
        state.sessionVisibility = await manageTaskHistory({ executable, root, taskId: request.taskId, threadId: state.threadId, archive: false, signal });
      } catch (error) {
        state.sessionVisibility = { status: 'error', action: 'unarchive', error: error.message };
        await writeJson(statePath, state);
        throw new Error(`Cannot restore the original Codex session. No new turn started. Resolve this error before continuing the same task: ${error.message}`, { cause: error });
      }
    }
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal.addEventListener('abort', relayAbort, { once: true });
    if (signal.aborted) controller.abort();
    let progress = '';
    let polling = false;
    let ioError;
    let executionError;
    let round, started;
    let stateWrites = Promise.resolve();
    const ioErrors = [];
    const recordIoError = error => {
      if (!ioErrors.includes(error)) ioErrors.push(error);
      ioError = ioErrors.length === 1 ? error : new AggregateError([...ioErrors], `Task state I/O failed: ${ioErrors.map(item => item.message).join('; ')}`);
      controller.abort();
    };
    const saveState = () => {
      const writing = stateWrites.then(() => writeJson(statePath, state));
      stateWrites = writing.catch(recordIoError);
      return writing;
    };
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        try { await fs.stat(path.join(directory, 'cancel')); controller.abort(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (progress !== state.progress) {
          state.progress = progress;
          await saveState();
          onProgress(progress);
        }
      } catch (error) { recordIoError(error); }
      finally { polling = false; }
    }, 500);
    try {
      await fs.rm(path.join(directory, 'cancel'), { force: true });
      state.status = 'running';
      if (harness === 'codex' && state.keepSessionVisible !== undefined) state.sessionVisibility = { status: 'visible', checkedAt: new Date().toISOString() };
      state.revision++;
      state.rounds = measuredRounds(state.rounds) || [];
      round = { revision: state.revision, startedAt: new Date().toISOString(), status: 'running' };
      started = performance.now();
      state.rounds.push(round);
      delete state.error;
      delete state.stopReason;
      state.response = '';
      state.progress = '';
      const settings = executionSettings(request, harness);
      Object.assign(state, settings);
      await saveState();
      const temporaryDirectory = state.temporaryFiles ? path.join(directory, 'work/.sub2sub') : undefined;
      if (temporaryDirectory) await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      const tokenBudget = await onRoundStart(round);
      const result = await (harness === 'claude' ? runClaude : runCodex)({
        executable, workspace: path.join(directory, 'work'), threadId: state.threadId, resolvedModel: modelInfo?.resolvedModel,
        prompt: request.prompt, temporaryDirectory, tokenBudget, ...settings, signal: controller.signal,
        onThread: async (id, historyTagged) => { state.threadId = id; state.historyTagged = historyTagged; await saveState(); },
        onUsage: usage => {
          round.usage = usage;
          saveState();
        },
        onProgress: value => { progress = value; }
      });
      await stateWrites;
      if (ioError) throw ioError;
      Object.assign(state, result);
      return state;
    } catch (error) {
      await stateWrites;
      if (ioError && error !== ioError) error = new AggregateError([error, ioError], `${error.message}; ${ioError.message}`);
      executionError = error;
      const timeLimit = error.code === 'SUB2SUB_TURN_TIMEOUT';
      state.status = timeLimit || controller.signal.aborted ? 'interrupted' : 'failed';
      state.error = error.message;
      if (timeLimit) { state.stopReason = 'time_limit'; return state; }
      throw error;
    } finally {
      clearInterval(timer);
      // Let an already-started disk update finish before writing final state.
      while (polling) await new Promise(resolve => setTimeout(resolve, 10));
      await stateWrites;
      signal.removeEventListener('abort', relayAbort);
      state.endedAt = new Date().toISOString();
      if (round) Object.assign(round, { endedAt: state.endedAt, elapsedMs: Math.round(performance.now() - started), status: state.status });
      if (state.retentionDays !== undefined) state.expiresAt = new Date(Date.now() + state.retentionDays * 86400000).toISOString();
      // Persist and settle the stopped turn before native presentation maintenance.
      const finalErrors = [];
      try { await saveState(); } catch (error) { finalErrors.push(error); }
      try { if (round) await onRoundEnd(round); } catch (error) { finalErrors.push(error); }
      if (finalErrors.length) {
        if (executionError) finalErrors.unshift(executionError);
        throw finalErrors.length === 1 ? finalErrors[0] : new AggregateError(finalErrors, finalErrors.map(error => error.message).join('; '));
      }
      // runCodex has closed its execution process before this finally runs.
      // Archiving is presentation maintenance, never a reason to rerun a finished turn.
      if (harness === 'codex' && state.keepSessionVisible === false && state.threadId) {
        try {
          state.sessionVisibility = await manageTaskHistory({ executable, root, taskId: request.taskId, threadId: state.threadId, archive: true });
        } catch (error) {
          state.sessionVisibility = { status: 'error', action: 'archive', error: `Could not archive the stopped Codex session: ${error.message} Execution status and saved results are unchanged. Inspect this task and archive its session in Codex; do not rerun it just to hide it.` };
        }
      }
      await saveState();
    }
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  const executable = process.argv[3] || 'codex';
  let received, sending = Promise.resolve();
  const send = message => {
    sending = sending.then(async () => {
      if (received?.streaming) await writeMessage(process.stdout, message);
      else process.stdout.write(JSON.stringify(await legacyMessage(message)) + '\n');
    });
    sending.catch(() => {});
  };
  try {
    received = await readRequest(process.stdin);
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    process.once('SIGHUP', () => controller.abort());
    process.stdout.on('error', () => controller.abort());
    const result = await providerRequest(received.value, {
      root, executable, signal: controller.signal,
      onProgress: message => send({ progress: message })
    });
    send({ result }); await sending;
  } catch (error) {
    send({ error: error.message }); await sending;
    process.exitCode = 1;
  } finally { await releaseReceived(received?.value); }
}
