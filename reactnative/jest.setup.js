/**
 * Mocks of the native modules that the polyfills use.
 *
 * The real modules are backed by the Android / iOS file system and the socket
 * implementation, neither of which exists in the Jest environment. The mocks
 * keep the API surface so that the polyfills can be tested.
 *
 * NOTE: the callbacks are written without `async` arrow functions - the Flow
 * parser of the React Native preset does not accept them inside an object
 * literal.
 */
'use strict';

jest.mock('react-native-fs', () => {
  const documents = '/tmp/Auto366/documents';
  const caches = '/tmp/Auto366/caches';
  const temporary = '/tmp/Auto366/temporary';
  /** The mocked device file system. */
  const files = new Map();
  const directories = new Set([documents, caches, temporary]);

  const toBuffer = data =>
    typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data ?? '');

  const ok = value => Promise.resolve(value);

  return {
    __mockFiles: files,
    __mockDirectories: directories,
    DocumentDirectoryPath: documents,
    CachesDirectoryPath: caches,
    TemporaryDirectoryPath: temporary,
    ExternalDirectoryPath: '/tmp/Auto366/external',
    ExternalCachesDirectoryPath: '/tmp/Auto366/external-caches',
    LibraryDirectoryPath: '/tmp/Auto366/library',
    MainBundlePath: '/tmp/Auto366/bundle',
    exists: jest.fn(target => ok(files.has(target) || directories.has(target))),
    readFile: jest.fn((target, encoding) => {
      const content = files.get(target);
      if (!content) {
        return Promise.reject(new Error(`ENOENT: no such file or directory, '${target}'`));
      }
      return ok(encoding ? content.toString(encoding) : content);
    }),
    writeFile: jest.fn((target, data, encoding) => {
      files.set(
        target,
        encoding === 'base64' ? Buffer.from(String(data), 'base64') : toBuffer(data),
      );
      return ok();
    }),
    appendFile: jest.fn((target, data, encoding) => {
      const current = files.get(target) ?? Buffer.alloc(0);
      const addition =
        encoding === 'base64' ? Buffer.from(String(data), 'base64') : toBuffer(data);
      files.set(target, Buffer.concat([current, addition]));
      return ok();
    }),
    unlink: jest.fn(target => {
      files.delete(target);
      return ok();
    }),
    mkdir: jest.fn(target => {
      directories.add(target);
      return ok();
    }),
    readDir: jest.fn(target =>
      ok(
        [...directories]
          .filter(entry => entry.startsWith(target) && entry !== target)
          .map(entry => ({
            name: entry.slice(target.length + 1),
            path: entry,
            isFile: () => false,
            isDirectory: () => true,
          })),
      ),
    ),
    stat: jest.fn(target =>
      ok({
        path: target,
        size: files.get(target)?.length ?? 0,
        isFile: () => files.has(target),
        isDirectory: () => directories.has(target),
        mtime: new Date(0),
      }),
    ),
    copyFile: jest.fn((source, target) => {
      files.set(target, files.get(source));
      return ok();
    }),
    moveFile: jest.fn((source, target) => {
      files.set(target, files.get(source));
      files.delete(source);
      return ok();
    }),
    existsSync: jest.fn(target => files.has(target) || directories.has(target)),
  };
});

/**
 * The native transport module (`Auto366Net`) does not exist in the Jest
 * environment. The HTTP client tests install their own fake sockets, while this
 * default mock keeps the rest of the suite importable.
 */
jest.mock('./src/runtime/native/net', () => {
  const {EventEmitter} = require('events');

  class NativeSocket extends EventEmitter {
    constructor(id = 'socket', isSSL = false, serverId = '') {
      super();
      this.id = id;
      this.isSSL = isSSL;
      this.serverId = serverId;
    }

    write() {
      return true;
    }

    end() {}

    destroy() {}

    setTimeout() {}

    setNoDelay() {}

    holdData() {}

    suspend() {}

    tunnel() {
      return Promise.resolve();
    }

    _markClosed() {}
  }

  class NativeServer extends EventEmitter {
    constructor(options, onConnection) {
      super();
      this.id = 'server';
      this.options = options;
      this.onConnection = onConnection;
      this.hasTls = false;
    }

    listen() {
      this.emit('listening');
      return Promise.resolve();
    }

    address() {
      return {address: '127.0.0.1', family: 'IPv4', port: 0};
    }

    close() {
      this.emit('close');
      return Promise.resolve();
    }

    _handleConnection(socket) {
      this.onConnection(socket);
    }
  }

  return {
    NativeSocket,
    NativeServer,
    createNativeServer: jest.fn(
      (options, onConnection) => new NativeServer(options, onConnection),
    ),
    connectTcp: jest.fn(() => new NativeSocket('client', false)),
    connectTls: jest.fn(() => new NativeSocket('client', true)),
    isNativeNetAvailable: jest.fn(() => true),
    normalizeNativeError: jest.fn(error =>
      error instanceof Error ? error : new Error(String(error)),
    ),
    stats: jest.fn(() => ({servers: 0, sockets: 0})),
  };
});
