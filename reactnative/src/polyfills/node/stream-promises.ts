/**
 * Node `stream/promises` polyfill for React Native.
 *
 * Node exposes a promise based `pipeline()` (and `finished()`) in
 * `stream/promises`. The underlying implementation is reused from
 * `stream-browserify`, the only addition is the promise wrapper and the
 * support for the `{signal}` option, which `stream-browserify` does not know
 * about.
 */
import {pipeline as browserifyPipeline} from 'stream-browserify';

export interface PipelineOptions {
  /** Aborts the pipeline; every stream is destroyed and the promise rejects. */
  signal?: AbortSignal;
  /** Whether the destination stream is ended (default: `true`). */
  end?: boolean;
}

function isStream(value: any): boolean {
  return Boolean(value) && typeof value === 'object' && typeof value.pipe === 'function';
}

function createAbortError(): NodeJS.ErrnoException {
  const error = new Error('The operation was aborted') as NodeJS.ErrnoException;
  error.code = 'ABORT_ERR';
  error.name = 'AbortError';
  return error;
}

function invalidArguments(): NodeJS.ErrnoException {
  const error = new TypeError('The "streams" argument must be an array of streams') as NodeJS.ErrnoException;
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

/**
 * Pipes a series of streams together.
 *
 * - `pipeline(a, b, callback)` behaves like `stream.pipeline()`.
 * - `pipeline(a, b)` returns a promise that resolves when the pipeline is done.
 * - `pipeline(a, b, {signal})` aborts the pipeline when the signal is aborted.
 */
export function pipeline(...args: any[]): any {
  let callback: ((error?: NodeJS.ErrnoException | null) => void) | undefined;
  let options: PipelineOptions = {};

  const last = args.length ? args[args.length - 1] : undefined;
  if (typeof last === 'function') {
    callback = args.pop();
  }
  const maybeOptions = args.length ? args[args.length - 1] : undefined;
  if (maybeOptions && typeof maybeOptions === 'object' && !isStream(maybeOptions)) {
    options = (args.pop() ?? {}) as PipelineOptions;
  }

  const streams: any[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (streams.length < 2) {
    const error = invalidArguments();
    if (callback) {
      callback(error);
      return undefined;
    }
    return Promise.reject(error);
  }

  if (callback) {
    browserifyPipeline(streams as any, callback as any);
    return undefined;
  }

  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: any) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };

    const signal = options.signal;
    const onAbort = () => {
      const error = createAbortError();
      for (const stream of streams) {
        try {
          stream?.destroy?.(error);
        } catch {
          /* ignore */
        }
      }
      finish(error);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener?.('abort', onAbort);
    }

    browserifyPipeline(streams as any, ((error?: any) => {
      signal?.removeEventListener?.('abort', onAbort);
      finish(error);
    }) as any);
  });
}

/**
 * Waits until a stream is finished (or closed).
 */
export function finished(stream: any, options?: any, callback?: (error?: NodeJS.ErrnoException | null) => void): any {
  let done = callback;
  let settings = options;
  if (typeof settings === 'function') {
    done = settings;
    settings = undefined;
  }
  if (typeof done === 'function') {
    stream.once?.('end', () => done(null));
    stream.once?.('error', (error: any) => done(error));
    stream.once?.('close', () => done(null));
    return undefined;
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: any) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };
    stream.once?.('end', () => finish());
    stream.once?.('close', () => finish());
    stream.once?.('error', (error: any) => finish(error));
  });
}

export default {pipeline, finished};
