/**
 * `process` shim for React Native.
 *
 * Hermes only provides a very small `process` object (`env` and `nextTick`),
 * while the ported main process code expects the Node surface:
 * `process.cwd()`, `process.platform`, `process.env`, `process.stdout`,
 * `process.on('uncaughtException')`, ...
 *
 * The module provides that surface and `installProcessGlobals()` copies it
 * onto the global `process` object. It has to be called during the bootstrap,
 * before any ported module is evaluated.
 */
import {Platform} from 'react-native';
import {EventEmitter} from 'events';
import {appDataDirectory, virtualAppRoot, workingDirectory} from '../../runtime/paths';

const startedAt = Date.now();

/** The desktop build reports `win32`/`darwin`; the mobile build mirrors it. */
export const platform: string = Platform.OS === 'ios' ? 'darwin' : 'win32';
export const arch: string = Platform.OS === 'ios' ? 'arm64' : 'arm64-v8a';

/** Node reports `browser` for every non Node.js runtime. */
export const type: string = 'browser';

export const version: string = '18.0.0';

export const versions: Record<string, string> = {
  node: '18.0.0',
  electron: '30.0.0',
  chrome: '120.0.0',
  v8: '12.0.0',
  react_native: '0.76.5',
};

/** The command line arguments of the application. */
export const argv: string[] = [virtualAppRoot];

/** The path of the executable - the virtual application root on mobile. */
export const execPath: string = virtualAppRoot;

/**
 * `process.resourcesPath` - the directory that holds the application resources.
 *
 * A packaged Electron build keeps it next to the executable (`<app>/resources`),
 * and the ported code resolves the Windows-only helpers from there
 * (`openspeedy/injector32.exe`, `tts/kitten-micro-en-v0_8`, ...). The virtual
 * `/app/resources` mirrors that layout, so the paths stay well formed even
 * though the helpers cannot run on mobile.
 */
export const resourcesPath: string = `${virtualAppRoot}/resources`;

/** A stable pseudo process id. */
export const pid: number = 1;

/** The window title. */
export let title: string = 'Auto366';

/** The environment of the application. */
export const env: {[key: string]: string | undefined} = {};

/**
 * The current working directory. The desktop build used it as the writable
 * application root, therefore it points at the mobile data directory.
 */
export function cwd(): string {
  return appDataDirectory;
}

/** Changing the working directory is not possible on mobile. */
export function chdir(directory: string): void {
  throw new Error(`[e2rn] process.chdir("${directory}") is not supported on React Native`);
}

/** Uptime of the JavaScript context in seconds. */
export function uptime(): number {
  return (Date.now() - startedAt) / 1000;
}

/** High resolution time - milliseconds based. */
export function hrtime(): [number, number] {
  const elapsed = Date.now() - startedAt;
  return [Math.floor(elapsed / 1000), (elapsed % 1000) * 1e6];
}

/** Schedules a callback for the next tick of the event loop. */
export function nextTick(callback: (...args: any[]) => void, ...args: any[]): void {
  const globalProcess = (globalThis as any).process;
  if (globalProcess && typeof globalProcess.nextTick === 'function' && globalProcess.nextTick !== nextTick) {
    globalProcess.nextTick(callback, ...args);
    return;
  }
  setTimeout(() => callback(...args), 0);
}

/** Quitting the application is not possible from JavaScript. */
export function exit(code?: number): void {
  /* the application lifecycle is owned by React Native */
  void code;
}

/** Killing a process is not possible on mobile. */
export function kill(pid: number, _signal?: string | number): boolean {
  throw new Error(`[e2rn] process.kill(${pid}) is not supported on React Native`);
}

/** A rough approximation of the memory usage. */
export function memoryUsage(): {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
} {
  const performance = (globalThis as any).performance;
  const used = typeof performance?.memory?.usedJSHeapSize === 'number' ? performance.memory.usedJSHeapSize : 0;
  const total = typeof performance?.memory?.totalJSHeapSize === 'number' ? performance.memory.totalJSHeapSize : 0;
  return {
    rss: total,
    heapTotal: total,
    heapUsed: used,
    external: 0,
    arrayBuffers: 0,
  };
}

/** The output stream of the process; writes go to the React Native console. */
export class ProcessStream extends EventEmitter {
  readonly isTTY = false;
  readonly columns = 0;
  readonly rows = 0;

  constructor(private readonly prefix: string) {
    super();
  }

  write(chunk: any): boolean {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    const globalConsole = (globalThis as any).console;
    if (this.prefix === 'stderr') {
      globalConsole?.error?.(text.replace(/\n$/, ''));
    } else {
      globalConsole?.log?.(text.replace(/\n$/, ''));
    }
    return true;
  }

  end(chunk?: any): void {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.emit('finish');
  }
}

export const stdout = new ProcessStream('stdout');
export const stderr = new ProcessStream('stderr');

/** The complete `process` object. */
export class Process extends EventEmitter {
  readonly platform = platform;
  readonly arch = arch;
  readonly type = type;
  readonly version = version;
  readonly versions = versions;
  readonly argv = argv;
  readonly execPath = execPath;
  readonly resourcesPath = resourcesPath;
  readonly pid = pid;
  readonly stdout = stdout;
  readonly stderr = stderr;
  readonly env = env;
  readonly browser = true;

  get title(): string {
    return title;
  }

  set title(value: string) {
    title = value;
  }

  cwd = cwd;
  chdir = chdir;
  uptime = uptime;
  hrtime = hrtime;
  nextTick = nextTick;
  exit = exit;
  kill = kill;
  memoryUsage = memoryUsage;

  /**
   * `process.send()` - only meaningful inside a `child_process.fork()` child.
   * Forking is not supported on React Native, so this is a no-op that keeps
   * the ported worker scripts from throwing when they are evaluated.
   */
  send(_message?: any, _sendHandle?: any, _options?: any, callback?: (error: Error | null) => void): boolean {
    if (typeof callback === 'function') {
      callback(null);
    }
    return true;
  }
}

/**
 * Installs the missing `process` members on the global object. Called once
 * during the bootstrap, before any ported module is loaded.
 */
export function installProcessGlobals(): void {
  const globalObject = globalThis as any;
  const existing = globalObject.process ?? {};
  const shim = new Process();
  shim.nextTick = existing.nextTick ? existing.nextTick.bind(existing) : nextTick;
  if (existing.env) {
    Object.assign(shim.env, existing.env);
  }
  globalObject.process = shim;
  globalObject.global = globalObject;
}

export {workingDirectory};

export default {
  Process,
  arch,
  argv,
  chdir,
  cwd,
  env,
  execPath,
  exit,
  hrtime,
  installProcessGlobals,
  kill,
  memoryUsage,
  nextTick,
  pid,
  platform,
  resourcesPath,
  stderr,
  stdout,
  title,
  type,
  uptime,
  version,
  versions,
};
