import { measuredUsage, TOKEN_FIELDS, tokenCounts } from './task-usage.mjs';
// Measurements belong to a task record, never to polling or result downloads.
export function measuredRounds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid task round measurements.');
  const revisions = new Set();
  return value.map(round => {
    if (!round || !Number.isSafeInteger(round.revision) || round.revision < 1 || revisions.has(round.revision)
      || typeof round.startedAt !== 'string' || !Number.isFinite(Date.parse(round.startedAt)) || !['running', 'completed', 'failed', 'interrupted'].includes(round.status)
      || round.endedAt !== undefined && (typeof round.endedAt !== 'string' || !Number.isFinite(Date.parse(round.endedAt)))
      || round.elapsedMs !== undefined && (!Number.isFinite(round.elapsedMs) || round.elapsedMs < 0)) {
      throw new Error('Invalid task round measurement.');
    }
    revisions.add(round.revision);
    return { revision: round.revision, startedAt: round.startedAt, endedAt: round.endedAt, elapsedMs: round.elapsedMs, status: round.status, ...(round.usage === undefined ? {} : { usage: measuredUsage(round.usage) }) };
  });
}

export function summarizeTasks(tasks, { role = 'caller', days = 7, now = Date.now() } = {}) {
  if (!['caller', 'provider'].includes(role) || ![7, 30].includes(days)) throw new Error('Choose caller/provider and 7/30 days for statistics.');
  const since = now - days * 86400000;
  const groups = new Map();
  const usageDetails = [], usageGroups = new Map();
  let unmeasuredTasks = 0, usagePendingTasks = 0;
  for (const task of tasks) {
    // Explicit record deletion preserves local files/indexes, not usage history.
    if (task.finished || ['records_deleted', 'all_deleted'].includes(task.cleanupStatus)) continue;
    if (role === 'caller' && task.deliveryPending) usagePendingTasks++;
    const rounds = measuredRounds(task.rounds);
    if (!rounds || !rounds.length || (task.revision ?? task.savedRevision ?? 0) > rounds.length) unmeasuredTasks++;
    const included = (rounds || []).filter(round => Date.parse(round.startedAt) >= since && Date.parse(round.startedAt) <= now);
    if (!included.length) continue;
    const resource = role === 'caller' ? task.peer : task.pairId;
    const harness = task.harness || 'codex';
    const key = JSON.stringify([resource, harness]);
    const group = groups.get(key) || { resource, harness, tasks: 0, rounds: 0, elapsedMs: 0, timedRounds: 0, outcomes: {} };
    group.tasks++;
    for (const round of included) {
      const usage = round.usage;
      const detail = { taskId: task.taskId, revision: round.revision, startedAt: round.startedAt, endedAt: round.endedAt, status: round.status,
        resource, harness, requestedModel: usage?.requestedModel ?? null, actualModel: usage?.actualModel ?? null,
        source: usage?.source ?? 'uncollected', usageStatus: usage?.status ?? 'unavailable', reason: usage?.reason ?? (usage ? undefined : 'Native usage was not collected for this round.'),
        scope: usage?.scope, observedModels: usage?.observedModels, observedAt: usage?.observedAt, tokens: usage?.tokens ?? tokenCounts({}),
        syncStatus: role === 'provider' ? 'local' : task.deliveryPending && round.revision > (task.savedRevision ?? 0) ? 'pending' : 'received', savedAt: role === 'caller' ? task.savedAt : undefined };
      usageDetails.push(detail);
      const usageKey = JSON.stringify([resource, harness, detail.actualModel, detail.source]);
      const usageGroup = usageGroups.get(usageKey) || { resource, harness, actualModel: detail.actualModel, source: detail.source,
        rounds: 0, observedRounds: 0, incompleteRounds: 0, unavailableRounds: 0, pendingRounds: 0, tokens: tokenCounts({}), knownFields: Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0])) };
      usageGroup.rounds++;
      usageGroup[`${detail.usageStatus}Rounds`]++;
      if (detail.syncStatus === 'pending') usageGroup.pendingRounds++;
      for (const field of TOKEN_FIELDS) {
        if (detail.tokens[field] === null) continue;
        const sum = (usageGroup.tokens[field] ?? 0) + detail.tokens[field];
        if (!Number.isSafeInteger(sum)) throw new Error(`Token statistics exceed the supported integer range: ${field}.`);
        usageGroup.tokens[field] = sum;
        usageGroup.knownFields[field]++;
      }
      usageGroups.set(usageKey, usageGroup);
      group.rounds++;
      group.outcomes[round.status] = (Object.hasOwn(group.outcomes, round.status) ? group.outcomes[round.status] : 0) + 1;
      if (round.elapsedMs !== undefined) { group.elapsedMs += round.elapsedMs; group.timedRounds++; }
    }
    groups.set(key, group);
  }
  const resources = [...groups.values()];
  return {
    role, days, since: new Date(since).toISOString(), checkedAt: new Date(now).toISOString(),
    resources, unmeasuredTasks, usagePendingTasks, usageDetails, usageGroups: [...usageGroups.values()],
    usageNote: 'Native usage for retained main-thread execution records only; auxiliary calls and subagent usage are not proven complete. Cached input is included in input; reasoning is included in output. Source totals are not sums of these overlapping fields. Null means unknown; group tokens sum known fields only and knownFields counts the contributing rounds. Caller data may be unsynchronized; provider and caller views represent the same work and must not be added together. Work-copy cleanup preserves usage, but explicit record deletion removes history. No account allowance or price is inferred.',
    totals: resources.reduce((total, group) => ({ tasks: total.tasks + group.tasks, rounds: total.rounds + group.rounds, elapsedMs: total.elapsedMs + group.elapsedMs, timedRounds: total.timedRounds + group.timedRounds }), { tasks: 0, rounds: 0, elapsedMs: 0, timedRounds: 0 }),
    note: 'Retained task records only, measured from this version onward. Caller figures include received execution/result records, not all remote work. Unknown/unfinished timing is excluded. Work-copy cleanup preserves statistics; explicit record deletion removes them. This is not account usage or a quality score.'
  };
}
