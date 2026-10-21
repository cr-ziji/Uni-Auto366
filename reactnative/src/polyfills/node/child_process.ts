/**
 * Node `child_process` polyfill for React Native.
 *
 * React Native cannot spawn operating system processes, therefore every
 * function of this module is inert:
 *
 *   - `spawn()` returns a child process object that behaves like a process
 *     that terminated immediately (empty `stdout`/`stderr` streams, an
 *     `exit`/`close` event);
 *   - the synchronous variants report the limitation through an error.
 *
 * The desktop code that relies on real processes (PowerShell helpers, the
 * mihomo TUN proxy, the speed injector and the TTS worker) is Windows only
 * and never runs on mobile.
 */
import {EventEmitter} from 'events';
import {PassThrough, Readable, Writable} from 'stream';
import {Buffer} from 'buffer';

export interface SpawnOptions {
  cwd?: string;
  env?: {[key: string]: string | undefined};
  argv0?: string;
  stdio?: any;
  detached?: boolean;
  shell?: boolean | string;
  windowsVerbatimArguments?: boolean;
  windowsHide?: boolean;
  timeout?: number;
  killSignal?: string | number;
  maxBuffer?: number;
  encoding?: string;
  uid?: number;
  gid?: number;
}

export interface ExecOptions extends SpawnOptions {
  timeout?: number;
  maxBuffer?: number;
  encoding?: string;
  killSignal?: string | number;
}

function unsupportedError(command: string): NodeJS.ErrnoException {
  const error = new Error(
    `child_process: "${command}" cannot be executed - React Native does not support operating system processes`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOTSUP';
  error.errno = -95;
  error.syscall = 'spawn';
  return error;
}

/** The (inert) result of {@link spawn}. */
export class ChildProcess extends EventEmitter {
  readonly pid = 0;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  connected = false;

  constructor(command: string) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    // Report the failure asynchronously, so that the caller can attach its
    // listeners first.
    setTimeout(() => {
      const error = unsupportedError(command);
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      this.exitCode = null;
      this.signalCode = null;
      this.emit('exit', null, null);
      this.emit('close', null);
    }, 0);
  }

  /** Spawning is not possible, therefore the process is simply "killed". */
  kill(_signal?: string | number): boolean {
    this.killed = true;
    this.exitCode = null;
    return true;
  }

  /** No IPC channel exists on mobile. */
  send(...args: any[]): boolean {
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const error = unsupportedError('send');
    callback?.(error);
    return false;
  }

  disconnect(): void {
    this.connected = false;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** Spawns a process (not supported, see the module documentation). */
export function spawn(command: string, _args?: string[], _options?: SpawnOptions): ChildProcess {
  return new ChildProcess(command);
}

/** The synchronous variant of {@link spawn}. */
export function spawnSync(command: string, _args?: string[], _options?: SpawnOptions): any {
  const error = unsupportedError(command);
  return {
    pid: 0,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
    error,
  };
}

/** Runs a command in a shell (not supported). */
export function exec(command: string, options?: ExecOptions | ((error: any, stdout: any, stderr: any) => void), callback?: (error: any, stdout: any, stderr: any) => void): any {
  let done = callback;
  let settings = options;
  if (typeof settings === 'function') {
    done = settings as any;
    settings = undefined;
  }
  const error = unsupportedError(command);
  if (typeof done === 'function') {
    setTimeout(() => done(error, Buffer.alloc(0), Buffer.alloc(0)), 0);
    return undefined;
  }
  return Promise.reject(error);
}

/** Runs a command in a shell synchronously (not supported). */
export function execSync(command: string, _options?: ExecOptions): Buffer {
  throw unsupportedError(command);
}

/** Runs a file synchronously (not supported). */
export function execFileSync(file: string, _args?: string[], _options?: ExecOptions): Buffer {
  throw unsupportedError(file);
}

/** Runs a file asynchronously (not supported). */
export function execFile(file: string, args?: string[], options?: ExecOptions | ((error: any, stdout: any, stderr: any) => void), callback?: (error: any, stdout: any, stderr: any) => void): any {
  let done = callback;
  let settings = options;
  if (typeof settings === 'function') {
    done = settings as any;
    settings = undefined;
  }
  const error = unsupportedError(file);
  if (typeof done === 'function') {
    setTimeout(() => done(error, Buffer.alloc(0), Buffer.alloc(0)), 0);
    return undefined;
  }
  return Promise.reject(error);
}

/** Forking a Node worker is not supported on mobile. */
export function fork(modulePath: string, _args?: string[], _options?: SpawnOptions): ChildProcess {
  const child = new ChildProcess(modulePath);
  return child;
}

export default {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
};
