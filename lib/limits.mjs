export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 2000;
export const SUPPORT_BYTES = 64 * 1024 * 1024;
export const SUPPORT_FILES = 10000;
export const WIRE_BYTES = SUPPORT_BYTES * 2 + 4 * 1024 * 1024;

export function transferLimits(settings = {}) {
  const limits = {};
  for (const key of ['inputBytes', 'inputFiles', 'resultBytes', 'resultFiles']) {
    const bytes = key.endsWith('Bytes');
    const value = settings[key] ?? (bytes ? MAX_BYTES : MAX_FILES);
    if (!Number.isSafeInteger(value) || value < 1 || value > (bytes ? SUPPORT_BYTES : SUPPORT_FILES)) throw new Error(`${key} must be an integer from 1 to ${bytes ? SUPPORT_BYTES : SUPPORT_FILES}.`);
    limits[key] = value;
  }
  return limits;
}

export function effectiveLimits(caller, provider) {
  const left = transferLimits(caller), right = transferLimits(provider);
  return Object.fromEntries(Object.keys(left).map(key => [key, Math.min(left[key], right[key])]));
}

export function fileLimits(limits, direction) {
  const values = transferLimits(limits);
  return { maxBytes: values[`${direction}Bytes`], maxFiles: values[`${direction}Files`] };
}
