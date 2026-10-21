/**
 * Node `events` polyfill for React Native.
 *
 * The npm `events` package is a faithful port of Node's implementation, the
 * only difference being that it does not expose the `events.EventEmitter`
 * self reference. Everything else (`once`, `on`, the `EventEmitter` class
 * with `on` / `once` / `off` / `emit` / `removeListener` / ...) behaves like
 * in Node.
 */
import * as eventsModule from 'events';

const moduleExports: any = eventsModule as any;

/**
 * `require('events')` returns the `EventEmitter` class itself; the npm
 * package additionally exposes `once`. Older Node releases (and a lot of
 * code) expect `require('events').EventEmitter` to be the very same class.
 */
const EventEmitter: any = moduleExports.EventEmitter ?? moduleExports.default ?? moduleExports;

if (EventEmitter && EventEmitter.EventEmitter !== EventEmitter) {
  EventEmitter.EventEmitter = EventEmitter;
}

/** Registers a one-shot listener and returns a disposer. */
export const once: (emitter: any, event: string, listener: (...args: any[]) => void) => () => void =
  typeof moduleExports.once === 'function' ? moduleExports.once : () => () => undefined;

/** Registers a listener for the next occurrence of `event`. */
export const on: (emitter: any, event: string, listener: (...args: any[]) => void) => () => void = (
  emitter: any,
  event: string,
  listener: (...args: any[]) => void,
) => {
  emitter.on(event, listener);
  return () => emitter.removeListener(event, listener);
};

/** Lists the listeners registered for `event`. */
export function getEventListeners(emitter: any, event: string): any[] {
  if (!emitter || typeof emitter.listeners !== 'function') {
    return [];
  }
  return emitter.listeners(event) ?? [];
}

/** Maximum number of listeners per event emitter (Node default). */
export function setMaxListeners(count: number, ...emitters: any[]): void {
  for (const emitter of emitters) {
    if (emitter && typeof emitter.setMaxListeners === 'function') {
      emitter.setMaxListeners(count);
    }
  }
}

export {EventEmitter};
export default EventEmitter;
