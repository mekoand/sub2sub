import { existsSync } from 'node:fs';

// Trigger the real execution deadline without waiting thirty minutes.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds !== 30 * 60 * 1000) return realTimeout(callback, milliseconds, ...args);
  const timer = setInterval(() => {
    if (!existsSync(process.env.SUB2SUB_TEST_DEADLINE)) return;
    clearInterval(timer);
    callback(...args);
  }, 10);
  return timer;
};
