export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 2000;
export const SUPPORT_BYTES = 64 * 1024 * 1024;
export const SUPPORT_FILES = 10000;
export const WIRE_BYTES = SUPPORT_BYTES * 2 + 4 * 1024 * 1024;

export function transferLimits(settings = {}) {
  const limits = {};
  for (const key of ['inputBytes', 'inputFiles', 'resultBytes', 'resultFiles']) {
    const value = settings[key] ?? null;
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${key} must be a positive safe integer or null for unlimited.`);
    limits[key] = value;
  }
  return limits;
}

export function effectiveLimits(caller, provider) {
  const left = transferLimits(caller), right = transferLimits(provider);
  return Object.fromEntries(Object.keys(left).map(key => [key, left[key] === null ? right[key] : right[key] === null ? left[key] : Math.min(left[key], right[key])]));
}

export function fileLimits(limits, direction) {
  const values = transferLimits(limits);
  return { maxBytes: values[`${direction}Bytes`] ?? Infinity, maxFiles: values[`${direction}Files`] ?? Infinity };
}

export function legacyLimits(settings = {}) {
  return { inputBytes: settings.inputBytes ?? MAX_BYTES, inputFiles: settings.inputFiles ?? MAX_FILES,
    resultBytes: settings.resultBytes ?? MAX_BYTES, resultFiles: settings.resultFiles ?? MAX_FILES };
}

export function transferWarning(bytes) {
  return bytes > SUPPORT_BYTES ? `本次传输共 ${(bytes / 1048576).toFixed(1)} MiB，可能耗时较长；非局域网连接下可能更慢。 / Transferring ${(bytes / 1048576).toFixed(1)} MiB may take longer, especially outside the local network. Continuing automatically.` : undefined;
}
