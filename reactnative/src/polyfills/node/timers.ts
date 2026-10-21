/**
 * Node `timers` polyfill for React Native.
 *
 * React Native provides the timer functions as globals, so the module simply
 * re-exports them and adds the promise based variants of `timers/promises`.
 */
const globalTimers = globalThis as any;

export const setTimeout: typeof globalThis.setTimeout = globalTimers.setTimeout;
export const clearTimeout: typeof globalThis.clearTimeout = globalTimers.clearTimeout;
export const setInterval: typeof globalThis.setInterval = globalTimers.setInterval;
export const clearInterval: typeof globalThis.clearInterval = globalTimers.clearInterval;
export const setImmediate: typeof globalTimers.setImmediate =
  globalTimers.setImmediate ?? ((callback: (...args: any[]) => void, ...args: any[]) => globalTimers.setTimeout(callback, 0, ...args));
export const clearImmediate: typeof globalTimers.clearImmediate =
  globalTimers.clearImmediate ?? ((handle: any) => globalTimers.clearTimeout(handle));

/** The promise based timer API (`timers/promises`). */
export const promises = {
  setTimeout: (delay?: number, value?: any): Promise<any> =>
    new Promise(resolve => {
      globalTimers.setTimeout(() => resolve(value), delay);
    }),
  setImmediate: (value?: any): Promise<any> =>
    new Promise(resolve => {
      globalTimers.setTimeout(() => resolve(value), 0);
    }),
  sleep: (delay?: number, value?: any): Promise<any> =>
    new Promise(resolve => {
      globalTimers.setTimeout(() => resolve(value), delay);
    }),
};

export default {
  clearImmediate,
  clearInterval,
  clearTimeout,
  promises,
  setImmediate,
  setInterval,
  setTimeout,
};
