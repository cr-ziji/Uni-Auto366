/**
 * Node `console` polyfill for React Native.
 *
 * Hermes already provides a global `console`, therefore the module only
 * re-exports it. The additional `Console` class keeps the Node API
 * (`new Console(stdout, stderr)`) available and the `assert` helper mirrors
 * the Node behaviour of throwing an `AssertionError`.
 */
const globalConsole = (globalThis as any).console;

export class AssertionError extends Error {
  actual: any;
  expected: any;
  operator: string;

  constructor(options?: {message?: string; actual?: any; expected?: any; operator?: string}) {
    super(options?.message ?? 'Assertion failed');
    this.name = 'AssertionError';
    this.actual = options?.actual;
    this.expected = options?.expected;
    this.operator = options?.operator ?? '==';
  }
}

/** A `console` implementation that writes to the given streams. */
export class Console {
  private readonly stdout: any;
  private readonly stderr: any;

  constructor(stdout?: any, stderr?: any) {
    this.stdout = stdout ?? globalConsole;
    this.stderr = stderr ?? this.stdout;
  }

  log(...args: any[]): void {
    this.stdout.log?.(...args);
  }

  info(...args: any[]): void {
    this.stdout.info?.(...args);
  }

  warn(...args: any[]): void {
    this.stderr.warn?.(...args);
  }

  error(...args: any[]): void {
    this.stderr.error?.(...args);
  }

  debug(...args: any[]): void {
    this.stdout.debug?.(...args);
  }

  trace(...args: any[]): void {
    this.stdout.trace?.(...args);
  }

  dir(...args: any[]): void {
    this.stdout.dir?.(...args);
  }

  table(...args: any[]): void {
    this.stdout.table?.(...args);
  }

  time(...args: any[]): void {
    this.stdout.time?.(...args);
  }

  timeEnd(...args: any[]): void {
    this.stdout.timeEnd?.(...args);
  }

  timeLog(...args: any[]): void {
    this.stdout.timeLog?.(...args);
  }

  group(...args: any[]): void {
    this.stdout.group?.(...args);
  }

  groupCollapsed(...args: any[]): void {
    this.stdout.groupCollapsed?.(...args);
  }

  groupEnd(): void {
    this.stdout.groupEnd?.();
  }

  assert(condition: any, ...args: any[]): void {
    if (!condition) {
      throw new AssertionError({message: args[0], actual: args[1], expected: args[2], operator: '=='});
    }
  }

  count(...args: any[]): void {
    this.stdout.count?.(...args);
  }

  countReset(...args: any[]): void {
    this.stdout.countReset?.(...args);
  }

  clear(): void {
    this.stdout.clear?.();
  }
}

const consoleInstance: any = globalConsole;

export const log = (...args: any[]): void => consoleInstance.log?.(...args);
export const info = (...args: any[]): void => consoleInstance.info?.(...args);
export const warn = (...args: any[]): void => consoleInstance.warn?.(...args);
export const error = (...args: any[]): void => consoleInstance.error?.(...args);
export const debug = (...args: any[]): void => consoleInstance.debug?.(...args);
export const trace = (...args: any[]): void => consoleInstance.trace?.(...args);
export const dir = (...args: any[]): void => consoleInstance.dir?.(...args);
export const table = (...args: any[]): void => consoleInstance.table?.(...args);
export const time = (...args: any[]): void => consoleInstance.time?.(...args);
export const timeEnd = (...args: any[]): void => consoleInstance.timeEnd?.(...args);
export const timeLog = (...args: any[]): void => consoleInstance.timeLog?.(...args);
export const group = (...args: any[]): void => consoleInstance.group?.(...args);
export const groupCollapsed = (...args: any[]): void => consoleInstance.groupCollapsed?.(...args);
export const groupEnd = (): void => consoleInstance.groupEnd?.();
export const count = (...args: any[]): void => consoleInstance.count?.(...args);
export const countReset = (...args: any[]): void => consoleInstance.countReset?.(...args);
export const clear = (): void => consoleInstance.clear?.();
export const assert = (condition: any, ...args: any[]): void => {
  if (!condition) {
    throw new AssertionError({message: args[0], actual: args[1], expected: args[2], operator: '=='});
  }
};

export default consoleInstance;
