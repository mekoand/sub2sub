// Preserve native classifications: Codex input includes cache reads; Claude
// input excludes cache reads/writes. Thinking is part of output for both.
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
  if (!value || !['codex-app-server', 'claude-agent-sdk'].includes(value.source) || !['observed', 'incomplete', 'unavailable'].includes(value.status)
    || value.actualModel !== null && typeof value.actualModel !== 'string'
    || value.requestedModel !== null && typeof value.requestedModel !== 'string'
    || value.observedModels !== undefined && (!Array.isArray(value.observedModels) || value.observedModels.some(model => typeof model !== 'string'))
    || typeof value.scope !== 'string'
    || value.reason !== undefined && typeof value.reason !== 'string'
    || value.observedAt !== undefined && (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)))) throw new Error('Invalid task usage measurement.');
  let models;
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || !value.models.length) throw new Error('Invalid per-model task usage.');
    const names = new Set();
    models = value.models.map(model => {
      if (!model || typeof model.actualModel !== 'string' || !model.actualModel || names.has(model.actualModel)) throw new Error('Invalid or duplicate task usage model.');
      names.add(model.actualModel);
      return { actualModel: model.actualModel, tokens: tokenCounts(model.tokens) };
    });
  }
  return { source: value.source, scope: value.scope, requestedModel: value.requestedModel, actualModel: value.actualModel,
    ...(models === undefined ? {} : { models }),
    status: value.status, ...(value.observedModels === undefined ? {} : { observedModels: [...value.observedModels] }), ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }), tokens: tokenCounts(value.tokens) };
}
