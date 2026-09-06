import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { readJson, writeJson } from './files.mjs';
import { processLock } from './lock.mjs';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const TASK_FILE_SCOPE = 'Send the files and instructions needed for tasks you delegate to this device, including non-public project source, documents and necessary configuration. Excludes credentials, unrelated files and sensitive material needing separate consent. This does not override Codex host approvals.';
export function executionSettings(settings = {}) {
  const model = settings.model ?? 'gpt-5.6-luna';
  const reasoningEffort = settings.reasoningEffort ?? 'max';
  if (typeof model !== 'string' || !model.trim() || model.length > 100) throw new Error('model must be a nonempty Codex model ID.');
  if (!REASONING_EFFORTS.includes(reasoningEffort)) throw new Error(`reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}.`);
  return { model, reasoningEffort };
}

export function allowedModels(provider = {}) {
  const models = provider.allowedModels ?? (provider.model ? [provider.model] : 'all');
  if (models === 'all') return models;
  if (!Array.isArray(models) || !models.length || models.length > 2000 || models.some(m => typeof m !== 'string' || !m.trim() || m.length > 100) || new Set(models).size !== models.length) throw new Error('allowedModels must be all or a nonempty list of unique model IDs.');
  return models;
}

export function retentionDays(provider = {}) {
  const days = provider.retentionDays ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('retentionDays must be an integer from 1 to 365.');
  return days;
}

export class Config {
  constructor(file) { this.file = file; }
  async read() {
    let config;
    try { config = await readJson(this.file); }
    catch (error) {
      if (error.code === 'ENOENT') return { peers: {} };
      throw new Error(`Cannot read sub2sub configuration ${this.file}: ${error.message}`, { cause: error });
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('sub2sub configuration must be a JSON object.');
    for (const key of ['peers', 'provider']) if (config[key] !== undefined && (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key]))) throw new Error(`Configuration ${key} must be an object.`);
    if (config.stateRoot !== undefined && (typeof config.stateRoot !== 'string' || !path.isAbsolute(config.stateRoot))) throw new Error('stateRoot must be an absolute path.');
    return config;
  }
  async update(change) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const release = await processLock(`${this.file}.lock`);
    try {
      const config = await this.read();
      const result = await change(config);
      await writeJson(this.file, config);
      return result;
    } finally { await release(); }
  }
}

export function deviceName(config) {
  const name = config.deviceName || os.hostname();
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Device name must contain 1–100 characters.');
  return name;
}

export async function executableOnPath(name) {
  const filename = process.platform === 'win32' ? `${name}.exe` : name;
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory.replace(/^"(.*)"$/, '$1'), filename);
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error(`${filename} was not found on the plugin process PATH. Install it or make its directory available to Codex, then restart the plugin.`);
}

export async function codexExecutable(config) {
  const explicit = config.provider?.codexPath || process.env.SUB2SUB_CODEX;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(explicit || '')) throw new Error('provider.codexPath must point to the native codex.exe on Windows, not a .cmd or .bat launcher.');
  const candidates = explicit ? [explicit] : process.platform === 'darwin' ? [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex'
  ] : [];
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; }
    catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
  }
  if (!explicit) return executableOnPath('codex');
  throw new Error('Codex executable not found. Install Codex, or set provider.codexPath in the sub2sub configuration to its executable path.');
}
