import { readCodex } from './codex-read.mjs';

function window(value, checkedAt) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex quota window.');
  for (const key of ['usedPercent', 'windowDurationMins', 'resetsAt']) {
    if (value[key] != null && (!Number.isFinite(value[key]) || value[key] < 0)) throw new Error(`Invalid Codex quota ${key}.`);
  }
  const usedPercent = value.usedPercent ?? null, resetsAt = value.resetsAt ?? null;
  return {
    usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    windowDurationMins: value.windowDurationMins ?? null, resetsAt,
    status: resetsAt !== null && resetsAt * 1000 <= Date.parse(checkedAt) ? 'stale' : usedPercent === null ? 'unavailable' : usedPercent >= 100 ? 'exhausted' : 'available'
  };
}

export async function queryUsage(executable, cwd, signal, harness = 'codex') {
  if (harness !== 'codex') return { harness, status: 'unsupported', checkedAt: new Date().toISOString(), reason: 'Quota lookup currently supports Codex. This does not prevent task execution.' };
  try {
    const data = await readCodex(executable, cwd, signal, request => request('account/rateLimits/read', {}));
    const checkedAt = new Date().toISOString();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Codex quota response.');
    const buckets = data.rateLimitsByLimitId ?? (data.rateLimits ? { [data.rateLimits.limitId || 'codex']: data.rateLimits } : {});
    if (typeof buckets !== 'object' || Array.isArray(buckets)) throw new Error('Invalid Codex quota categories.');
    const limits = Object.entries(buckets).map(([limitId, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex quota category.');
      if (value.limitName != null && typeof value.limitName !== 'string') throw new Error('Invalid Codex quota category name.');
      return { limitId, limitName: value.limitName ?? null, primary: window(value.primary, checkedAt), secondary: window(value.secondary, checkedAt) };
    });
    const windows = limits.flatMap(item => [item.primary, item.secondary]).filter(Boolean);
    const status = windows.some(w => w.status === 'stale') ? 'stale' : windows.some(w => w.status === 'exhausted') ? 'exhausted' : windows.some(w => w.status === 'available') ? 'available' : 'unavailable';
    return { harness, status, checkedAt, scope: 'account', limits };
  } catch (error) {
    return { harness, status: error.rpcCode === -32601 ? 'unsupported' : error.code === 'LOGIN_REQUIRED' ? 'unavailable' : 'failed', checkedAt: new Date().toISOString(), reason: error.message };
  }
}
