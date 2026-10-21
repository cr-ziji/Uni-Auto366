/**
 * Node.js globals that React Native does not provide.
 *
 * The ported desktop main process was written for Node, where `Buffer`,
 * `setImmediate` and `TextDecoder` are globals - the code uses them WITHOUT
 * requiring the module first (`modules/logging/format.js` calls
 * `Buffer.isBuffer()`, `modules/app/process-text.js` constructs a global
 * `TextDecoder`, ...). Hermes only exposes the browser globals, so those
 * identifiers are undefined and the first module that touches one throws
 * `ReferenceError: Property 'Buffer' doesn't exist`.
 *
 * `installNodeGlobals()` is called by the runtime bootstrap before the
 * original `main.js` is required, which is the same point in time Node would
 * have had them available.
 */
import {Buffer} from './buffer';
import {TextDecoder, TextEncoder} from './util';
import {clearImmediate, setImmediate} from './timers';

/** Installs the missing Node globals (idempotent). */
export function installNodeGlobals(): void {
  const globalObject = globalThis as any;

  if (typeof globalObject.Buffer === 'undefined') {
    globalObject.Buffer = Buffer;
  }
  if (typeof globalObject.setImmediate !== 'function') {
    globalObject.setImmediate = setImmediate;
  }
  if (typeof globalObject.clearImmediate !== 'function') {
    globalObject.clearImmediate = clearImmediate;
  }
  if (typeof globalObject.TextDecoder === 'undefined') {
    globalObject.TextDecoder = TextDecoder;
  }
  if (typeof globalObject.TextEncoder === 'undefined') {
    globalObject.TextEncoder = TextEncoder;
  }
  // Node's `global` alias - the desktop code uses it in a few callbacks.
  if (typeof globalObject.global === 'undefined') {
    globalObject.global = globalObject;
  }
}

export default installNodeGlobals;
