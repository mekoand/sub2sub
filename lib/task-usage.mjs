// Native classifications overlap: cached input is part of input and reasoning is
// part of output. Keep the source total; never sum the classifications.
export const TOKEN_FIELDS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];

export function tokenCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native token usage.');
  return Object.fromEntries(TOKEN_FIELDS.map(key => {
    const count = value[key] ?? null;
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error(`Invalid native token usage: ${key}.`);
    return [key, count];
  }));
}

export function measuredUsage(value) {
  if (value === undefined) return undefined;
  if (!value || value.source !== 'codex-app-server' || !['observed', 'incomplete', 'unavailable'].includes(value.status)
    || value.actualModel !== null && typeof value.actualModel !== 'string'
    || value.requestedModel !== null && typeof value.requestedModel !== 'string'
    || value.observedModels !== undefined && (!Array.isArray(value.observedModels) || value.observedModels.some(model => typeof model !== 'string'))
    || typeof value.scope !== 'string'
    || value.reason !== undefined && typeof value.reason !== 'string'
    || value.observedAt !== undefined && (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)))) throw new Error('Invalid task usage measurement.');
  return { source: value.source, scope: value.scope, requestedModel: value.requestedModel, actualModel: value.actualModel,
    status: value.status, ...(value.observedModels === undefined ? {} : { observedModels: [...value.observedModels] }), ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }), tokens: tokenCounts(value.tokens) };
}
