/**
 * Node `buffer` polyfill for React Native.
 *
 * Hermes / JSC do not expose a global `Buffer`, so the npm `buffer` package
 * is used. It is installed globally by the runtime bootstrap before any
 * business module is loaded.
 */
import {Buffer} from 'buffer';

export {Buffer};

/** Deprecated alias kept for Node compatibility. */
export const SlowBuffer = Buffer;

/** Number of bytes inspected by `util.inspect()` before eliding. */
export const INSPECT_MAX_BYTES = 50;

export default Buffer;
