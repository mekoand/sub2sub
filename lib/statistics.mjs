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
    return { revision: round.revision, startedAt: round.startedAt, endedAt: round.endedAt, elapsedMs: round.elapsedMs, status: round.status };
  });
}

export function summarizeTasks(tasks, { role = 'caller', days = 7, now = Date.now() } = {}) {
  if (!['caller', 'provider'].includes(role) || ![7, 30].includes(days)) throw new Error('Choose caller/provider and 7/30 days for statistics.');
  const since = now - days * 86400000;
  const groups = new Map();
  let unmeasuredTasks = 0;
  for (const task of tasks) {
    // Explicit record deletion preserves local files/indexes, not usage history.
    if (task.finished || ['records_deleted', 'all_deleted'].includes(task.cleanupStatus)) continue;
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
      group.rounds++;
      group.outcomes[round.status] = (Object.hasOwn(group.outcomes, round.status) ? group.outcomes[round.status] : 0) + 1;
      if (round.elapsedMs !== undefined) { group.elapsedMs += round.elapsedMs; group.timedRounds++; }
    }
    groups.set(key, group);
  }
  const resources = [...groups.values()];
  return {
    role, days, since: new Date(since).toISOString(), checkedAt: new Date(now).toISOString(),
    resources, unmeasuredTasks,
    totals: resources.reduce((total, group) => ({ tasks: total.tasks + group.tasks, rounds: total.rounds + group.rounds, elapsedMs: total.elapsedMs + group.elapsedMs, timedRounds: total.timedRounds + group.timedRounds }), { tasks: 0, rounds: 0, elapsedMs: 0, timedRounds: 0 }),
    note: 'Retained task records only, measured from this version onward. Caller figures include received execution/result records, not all remote work. Unknown/unfinished timing is excluded. Work-copy cleanup preserves statistics; explicit record deletion removes them. This is not account usage or a quality score.'
  };
}
