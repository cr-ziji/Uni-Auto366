/**
 * Stub module for Node APIs that cannot be supported on React Native.
 *
 * Modules such as `cluster`, `dgram` or `worker_threads` rely on operating
 * system features that do not exist on mobile. Instead of failing with an
 * obscure "module not found" error, the Metro resolver can point them here:
 * every call reports the limitation in a descriptive way.
 */

/** Throws a descriptive error for an unsupported API. */
export function unsupported(name: string, reason?: string): never {
  const error = new Error(
    `"${name}" is not supported on React Native${reason ? ` (${reason})` : ''}`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOTSUP';
  error.errno = -95;
  error.syscall = name;
  throw error;
}

/** Creates a function that always reports the API as unsupported. */
export function createUnsupportedStub(name: string, reason?: string): (...args: any[]) => never {
  return () => unsupported(name, reason);
}

/** The unsupported modules and their stubs. */
export const unsupportedModules = {
  cluster: {
    fork: createUnsupportedStub('cluster.fork', 'worker processes are not available'),
    isPrimary: () => true,
    isWorker: () => false,
    setupPrimary: createUnsupportedStub('cluster.setupPrimary'),
  },
  dgram: {
    createSocket: createUnsupportedStub('dgram.createSocket', 'UDP sockets are not available'),
  },
  worker_threads: {
    Worker: createUnsupportedStub('worker_threads.Worker', 'threads are not available'),
    MessageChannel: createUnsupportedStub('worker_threads.MessageChannel'),
    MessagePort: createUnsupportedStub('worker_threads.MessagePort'),
    isMainThread: true,
    parentPort: null,
    threadId: 0,
    workerData: null,
  },
  vm: {
    createContext: createUnsupportedStub('vm.createContext', 'dynamic code evaluation is not available'),
    Script: createUnsupportedStub('vm.Script'),
    runInContext: createUnsupportedStub('vm.runInContext'),
    runInNewContext: createUnsupportedStub('vm.runInNewContext'),
    compileFunction: createUnsupportedStub('vm.compileFunction'),
  },
  inspector: {
    open: createUnsupportedStub('inspector.open', 'the V8 inspector is not available'),
    url: () => '',
  },
};

export default unsupportedModules;
