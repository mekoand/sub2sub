import { readCodex } from './codex-read.mjs';
import { allowedModels, harnessSettings } from './config.mjs';
import { queryClaudeModels } from './claude.mjs';
import { transferLimits } from './limits.mjs';

export function queryModels(executable, cwd, signal) {
  return readCodex(executable, cwd, signal, async request => {
    const models = [], cursors = new Set();
    let cursor;
    do {
      const page = await request('model/list', { cursor, limit: 100, includeHidden: false });
      if (!Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string')) throw new Error('Invalid model catalog; capabilities are unconfirmed.');
      for (const model of page.data) {
        if (typeof model.model !== 'string' || !model.model || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.some(e => typeof e.reasoningEffort !== 'string' || !e.reasoningEffort)) throw new Error('Invalid model capabilities from Codex.');
        models.push({ model: model.model, displayName: model.displayName, reasoningEfforts: model.supportedReasoningEfforts.map(e => e.reasoningEffort) });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Model discovery returned a repeated cursor.');
      cursors.add(cursor);
      if (models.length > 2000) throw new Error('Model catalog exceeds 2000 entries.');
    } while (cursor);
    return models;
  });
}

export function queryExecutionModels(harness, executable, cwd, signal) {
  return harness === 'claude' ? queryClaudeModels(executable, cwd, signal) : queryModels(executable, cwd, signal);
}

export function modelCapabilities(models, provider = {}, harness = 'codex') {
  const allowed = allowedModels(harnessSettings(provider, harness));
  return { protocol: 2, harness, checkedAt: new Date().toISOString(), allowedModels: allowed, limits: transferLimits(provider), models: models.filter(m => allowed === 'all' || allowed.includes(m.model)) };
}

export function requireModel(settings, capabilities) {
  if (capabilities.protocol !== 2 || !Array.isArray(capabilities.models)) throw new Error('Provider model capabilities are unconfirmed or incompatible. Upgrade both endpoints before sending task files.');
  if (!settings.model || !settings.reasoningEffort) throw new Error(`Choose a model and reasoning effort before starting this task. Available choices: ${JSON.stringify(capabilities.models)}. No task files were sent.`);
  const selected = capabilities.models.find(m => m.model === settings.model);
  if (!selected || !Array.isArray(selected.reasoningEfforts) || !selected.reasoningEfforts.includes(settings.reasoningEffort)) {
    throw new Error(`${settings.model} / ${settings.reasoningEffort} is not available or allowed. Choose from: ${JSON.stringify(capabilities.models)}. No alternative was selected.`);
  }
}
