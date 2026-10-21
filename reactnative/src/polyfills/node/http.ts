/**
 * Node `http` 兼容层（React Native）。
 *
 * 桌面版模块是按 Node 的 `http` API 写的（`http.createServer`、`req.on('data')`、
 * `res.writeHead`、`http.request` ...）。这里用 `react-native-tcp-socket` 复刻这一层，
 * 让业务逻辑可以基本照搬桌面原版。
 *
 * 与 Node 的刻意差异：
 *  - 请求正文先完整缓冲再回放（JS 线程无法把原生回调里的数据交给挂起的异步函数）；
 *  - 没有 HTTP/2、没有连接池（`Agent` 只是占位），一个请求一条连接；
 *  - 服务端响应是 `Writable`，客户端响应是 `Readable`，因此 `pipe()` / `for await` 都能用；
 *  - 未监听的 `error` 事件只打印日志，不会让 App 崩溃。
 *
 * `https` 模块复用本文件的实现（见 `createHttpModule`），只是默认端口与 TLS 不同。
 */
import {Buffer} from 'buffer';
import {Readable, Writable} from 'stream';
import {
  HttpClientOptions,
  HttpClientRequest,
  HttpEmitter,
} from '../../runtime/http/client';
import {
  HttpServer,
  HttpServerOptions,
  RawHttpRequest,
  RawHttpResponse,
} from '../../runtime/http/server';

export type HeaderValue = string | number | string[];

/**
 * 服务端请求。
 *
 * 正文已经完整缓冲，`replay()` 把它回放成 `data` / `end`。
 */
export class NodeIncomingMessage extends Readable {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, any>;
  body: Buffer;
  socket: any;
  complete = true;
  private replayed = false;

  constructor(rawRequest: RawHttpRequest) {
    super();
    this.method = rawRequest.method;
    this.url = rawRequest.url;
    this.httpVersion = rawRequest.httpVersion;
    this.headers = rawRequest.headers || {};
    this.body = rawRequest.body || Buffer.alloc(0);
    this.socket = rawRequest.socket;
  }

  /**
   * 回放缓冲好的请求体。
   *
   * 必须先缓冲再回放：桌面代码是在 handler 内部挂 `req.on('data')`，
   * 而 JS 线程无法在原生回调里把数据交给挂起的异步函数。
   */
  replay(): void {
    if (this.replayed) {
      return;
    }
    this.replayed = true;
    if (this.body && this.body.length > 0) {
      this.push(this.body);
    }
    this.push(null);
  }

  _read(_size: number): void {
    // 正文已经完整缓冲，这里不需要再拉取数据
  }
}

/**
 * 服务端响应。
 *
 * 是 `Writable`，所以 `fs.createReadStream(...).pipe(res)` 这种写法能用。
 */
export interface NodeServerResponse {
  /**
   * Node 的 `Writable.prototype.writableEnded` 只有 getter
   * （Babel/RN 运行时若直接赋值会报 `Cannot set property writableEnded ...
   * which has only a getter`），
   * 因此这里用 `Object.defineProperty` 跳过字段初始化，改在构造函数里定义自有属性。
   */
  writableEnded: boolean;
}

export class NodeServerResponse extends Writable {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  finished = false;
  socket: any;
  private readonly headers = new Map<string, {name: string; value: HeaderValue}>();
  private readonly target: RawHttpResponse;

  constructor(target: RawHttpResponse, socket: any) {
    super();
    Object.defineProperty(this, 'writableEnded', {
      value: false,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    this.target = target;
    this.socket = socket;
  }

  setHeader(name: string, value: HeaderValue): this {
    if (this.headersSent) {
      return this;
    }
    this.headers.set(String(name).toLowerCase(), {name: String(name), value});
    return this;
  }

  getHeader(name: string): HeaderValue | undefined {
    return this.headers.get(String(name).toLowerCase())?.value;
  }

  getHeaders(): Record<string, HeaderValue> {
    const result: Record<string, HeaderValue> = {};
    for (const [key, entry] of this.headers) {
      result[key] = entry.value;
    }
    return result;
  }

  hasHeader(name: string): boolean {
    return this.headers.has(String(name).toLowerCase());
  }

  removeHeader(name: string): void {
    this.headers.delete(String(name).toLowerCase());
  }

  writeHead(
    statusCode: number,
    statusMessage?: string | Record<string, HeaderValue>,
    headers?: Record<string, HeaderValue>,
  ): this {
    if (this.headersSent) {
      return this;
    }
    this.statusCode = statusCode;
    let headerValues = headers;
    if (typeof statusMessage === 'string') {
      this.statusMessage = statusMessage;
    } else if (statusMessage && typeof statusMessage === 'object') {
      headerValues = statusMessage;
    }
    if (headerValues) {
      for (const name of Object.keys(headerValues)) {
        this.setHeader(name, headerValues[name]);
      }
    }
    const flat: Record<string, any> = {};
    for (const [key, entry] of this.headers) {
      flat[key] = entry.value;
    }
    this.headersSent = true;
    this.target.writeHead(statusCode, this.statusMessage || undefined, flat);
    return this;
  }

  write(chunk: Buffer | string): boolean {
    if (this.writableEnded) {
      return false;
    }
    if (!this.headersSent) {
      this.writeHead(this.statusCode, this.statusMessage);
    }
    this.target.write(chunk);
    return true;
  }

  /**
   * 结束响应。
   *
   * 参数与 Node 的 `end()` 保持一致：`end()`、`end(chunk)`、`end(chunk, encoding)`、
   * `end(callback)` 都可以。
   */
  end(chunk?: any, encoding?: any, callback?: any): this {
    if (this.writableEnded) {
      return this;
    }
    let payload = chunk;
    let done = callback;
    if (typeof payload === 'function') {
      done = payload;
      payload = undefined;
    }
    if (payload !== undefined && payload !== null) {
      this.write(payload);
    }
    if (!this.headersSent) {
      this.writeHead(this.statusCode, this.statusMessage);
    }
    this.writableEnded = true;
    this.finished = true;
    this.target.end();
    this.emit('finish');
    this.emit('close');
    if (typeof done === 'function') {
      done();
    }
    return this;
  }

  destroy(error?: Error): this {
    const state = (this as any)._writableState;
    if (state) {
      state.destroyed = true;
    }
    if (!this.writableEnded) {
      this.writableEnded = true;
      this.finished = true;
      try {
        this.target.destroy(error);
      } catch {
        // 忽略
      }
    }
    this.emit('close');
    return this;
  }

  _write(_chunk: any, _encoding: any, callback: any): void {
    // 真正写数据走 `write()`，这里只是为了满足 Writable 的抽象接口
    callback();
  }
}

/** 客户端响应：`Readable`，支持 `pipe()` 与 `for await`。 */
export class NodeClientResponse extends Readable {
  statusCode = 0;
  statusMessage = '';
  httpVersion = 'HTTP/1.1';
  headers: Record<string, any> = {};
  complete = false;
  aborted = false;
  private destroyedFlag = false;

  constructor(head: any) {
    super();
    this.statusCode = head?.statusCode ?? 0;
    this.statusMessage = head?.statusMessage ?? '';
    this.httpVersion = head?.httpVersion ?? 'HTTP/1.1';
    this.headers = head?.headers ?? {};
  }

  _read(_size: number): void {
    // 数据由运行时客户端主动 push
  }

  /** 覆盖 `destroy`：没有 `error` 监听者时不抛未捕获异常。 */
  destroy(error?: any): this {
    if (this.destroyedFlag) {
      return this;
    }
    this.destroyedFlag = true;
    const state = (this as any)._readableState;
    if (state) {
      state.destroyed = true;
    }
    if (error) {
      this.aborted = true;
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      } else {
        console.error('[http] 响应被销毁:', error);
      }
    }
    this.emit('close');
    return this;
  }
}

/** 客户端请求。 */
export class NodeClientRequest extends HttpEmitter {
  private readonly inner: HttpClientRequest;
  private response: NodeClientResponse | null = null;
  private pendingBody: any;

  constructor(options: HttpClientOptions, callback?: (response: NodeClientResponse) => void) {
    super();
    this.pendingBody = options.body;
    this.inner = new HttpClientRequest(options);
    this.inner.on('response', (head: any) => {
      const response = new NodeClientResponse(head);
      this.response = response;
      this.emit('response', response);
    });
    if (callback) {
      this.on('response', callback);
    }
    this.inner.on('data', (chunk: Buffer) => {
      this.response?.push(chunk);
      // Node 的 ClientRequest 是 Writable，没有 'data' 事件；
      // 这里额外转发一份，方便把请求当响应流用的桌面代码。
      this.emit('data', chunk);
    });
    this.inner.on('end', () => {
      if (this.response) {
        this.response.complete = true;
      }
      this.response?.push(null);
      this.emit('end');
    });
    this.inner.on('aborted', () => {
      this.response?.emit('aborted');
    });
    this.inner.on('error', (error: Error) => {
      this.response?.destroy(error);
      this.emit('error', error);
    });
    this.inner.on('timeout', () => {
      this.emit('timeout');
    });
    this.inner.on('close', () => {
      this.emit('close');
    });
  }

  write(chunk: Buffer | string): boolean {
    this.pendingBody = undefined;
    return this.inner.write(chunk);
  }

  end(chunk?: Buffer | string): void {
    const body = chunk !== undefined && chunk !== null ? chunk : this.pendingBody;
    this.pendingBody = undefined;
    this.inner.end(body);
  }

  destroy(error?: Error): void {
    this.inner.destroy(error);
  }

  abort(): void {
    this.inner.destroy(new Error('The request was aborted.'));
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    this.inner.setTimeout(milliseconds, callback);
    return this;
  }

  setHeader(name: string, value: HeaderValue): void {
    this.inner.setHeader(name, value);
  }

  removeHeader(name: string): void {
    this.inner.removeHeader(name);
  }

  getHeader(name: string): string | undefined {
    return this.inner.getHeader(name);
  }

  getHeaders(): Record<string, string> {
    return this.inner.getHeaders();
  }
}

export type NodeRequestListener = (
  req: NodeIncomingMessage,
  res: NodeServerResponse,
) => void | Promise<void>;

export interface NodeServerAddress {
  address: string;
  family: string;
  port: number;
}

export interface NodeServer {
  requestTimeout: number;
  keepAliveTimeout: number;
  timeout: number;
  listening: boolean;
  listen(port: number, host?: string, callback?: () => void): NodeServer;
  listen(port: number, callback?: () => void): NodeServer;
  address(): NodeServerAddress | null;
  close(callback?: (error?: Error) => void): NodeServer;
  closeAllConnections(): void;
  unref(): NodeServer;
  ref(): NodeServer;
  on(event: string, listener: (...args: any[]) => void): NodeServer;
  once(event: string, listener: (...args: any[]) => void): NodeServer;
  removeListener(event: string, listener: (...args: any[]) => void): NodeServer;
  emit(event: string, ...args: any[]): boolean;
}

/** 解析请求目标（字符串或 WHATWG URL）。 */
function parseRequestTarget(target: any, defaultProtocol: string): {
  protocol: string;
  hostname: string;
  port: number;
  path: string;
  host: string;
} {
  if (target && typeof target === 'object') {
    const path = `${target.pathname || '/'}${target.search || ''}`;
    return {
      protocol: String(target.protocol || defaultProtocol),
      hostname: String(target.hostname || ''),
      port: Number(target.port) || 0,
      path: path || '/',
      host: String(target.host || ''),
    };
  }
  const text = String(target || '');
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)/.exec(text);
  if (!match) {
    return {protocol: defaultProtocol, hostname: '', port: 0, path: text || '/', host: ''};
  }
  const protocol = (match[1] || defaultProtocol).toLowerCase();
  let authority = match[2] || '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    authority = authority.slice(at + 1);
  }
  let hostname = authority;
  let port = 0;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    hostname = end >= 0 ? authority.slice(0, end + 1) : authority;
    if (end >= 0 && authority[end + 1] === ':') {
      port = Number(authority.slice(end + 2)) || 0;
    }
  } else if (authority.includes(':')) {
    const index = authority.lastIndexOf(':');
    hostname = authority.slice(0, index);
    port = Number(authority.slice(index + 1)) || 0;
  }
  return {
    protocol,
    hostname,
    port,
    path: match[3] || '/',
    host: authority,
  };
}

/** 是否是 WHATWG URL 对象。 */
function isUrlLike(value: any): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.href === 'string' &&
    typeof value.protocol === 'string'
  );
}

/** 统一 `request(options, cb)` / `request(url, options, cb)` 这几种调用形式。 */
function normalizeRequestArgs(
  args: any[],
  defaultPort: number,
  defaultProtocol: string,
  tls: boolean,
): {options: HttpClientOptions; callback?: (response: NodeClientResponse) => void} {
  let target: any = null;
  let options: any = {};
  let callback: any = null;
  for (const arg of args) {
    if (arg === undefined || arg === null) {
      continue;
    }
    if (typeof arg === 'function') {
      callback = arg;
      continue;
    }
    if (typeof arg === 'string') {
      target = arg;
      continue;
    }
    if (typeof arg === 'object') {
      if (isUrlLike(arg)) {
        target = arg;
      } else {
        options = {...options, ...arg};
      }
    }
  }
  const merged: any = {...options};
  if (target) {
    const parsed = parseRequestTarget(target, defaultProtocol);
    merged.protocol = parsed.protocol;
    merged.hostname = parsed.hostname;
    merged.port = parsed.port || defaultPort;
    merged.path = parsed.path;
    merged.host = parsed.host;
  }
  if (!merged.hostname && merged.host) {
    const text = String(merged.host);
    const index = text.lastIndexOf(':');
    if (index > 0 && !text.includes(']')) {
      merged.hostname = text.slice(0, index);
      if (!options.port) {
        merged.port = Number(text.slice(index + 1)) || defaultPort;
      }
    } else {
      merged.hostname = text;
    }
  }
  if (!merged.hostname) {
    merged.hostname = '127.0.0.1';
  }
  merged.port = Number(merged.port) || defaultPort;
  merged.method = String(merged.method || 'GET').toUpperCase();
  merged.path = merged.path || '/';
  merged.tls = tls;
  return {options: merged as HttpClientOptions, callback};
}

/** Node 风格 HTTP 服务端。 */
function buildServer(handler?: NodeRequestListener, serverOptions?: any): NodeServer {
  const emitter = new HttpEmitter();
  const innerOptions: HttpServerOptions = {};
  let inner: HttpServer | null = null;
  let listening = false;
  let boundHost = '0.0.0.0';
  let boundPort = 0;

  const api: any = {
    get requestTimeout(): number {
      return Number(innerOptions.requestTimeout) || 0;
    },
    set requestTimeout(value: number) {
      innerOptions.requestTimeout = Number(value) || 0;
    },
    get keepAliveTimeout(): number {
      return Number(innerOptions.keepAliveTimeout) || 0;
    },
    set keepAliveTimeout(value: number) {
      innerOptions.keepAliveTimeout = Number(value) || 0;
    },
    timeout: 0,
    get listening(): boolean {
      return listening;
    },
    listen(port: number, host?: string | (() => void), callback?: () => void): NodeServer {
      const resolvedCallback =
        typeof host === 'function'
          ? host
          : typeof callback === 'function'
          ? callback
          : undefined;
      const resolvedHost = typeof host === 'string' ? host : '0.0.0.0';
      boundHost = resolvedHost;
      boundPort = port;
      const server = new HttpServer(
        async (rawRequest: RawHttpRequest, rawResponse: RawHttpResponse) => {
          const nodeRequest = new NodeIncomingMessage(rawRequest);
          const nodeResponse = new NodeServerResponse(rawResponse, rawRequest.socket);
          emitter.emit('request', nodeRequest, nodeResponse);
          try {
            const outcome = handler ? handler(nodeRequest, nodeResponse) : undefined;
            // 正文立即回放，handler 里的 `for await` 才能拿到数据
            nodeRequest.replay();
            await outcome;
          } catch (error) {
            if (!nodeResponse.headersSent) {
              nodeResponse.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
              nodeResponse.end(String((error as Error)?.message ?? error));
            } else if (!nodeResponse.writableEnded) {
              nodeResponse.destroy(error as Error);
            }
          } finally {
            if (!nodeResponse.writableEnded) {
              nodeResponse.end();
            }
          }
        },
        innerOptions,
      );
      inner = server;
      server
        .listen(port, resolvedHost)
        .then(() => {
          listening = true;
          const info = server.address();
          if (info) {
            boundPort = info.port;
            boundHost = info.address;
          }
          emitter.emit('listening');
          resolvedCallback?.();
        })
        .catch((error: Error) => {
          listening = false;
          emitter.emit('error', error);
        });
      return api;
    },
    address(): NodeServerAddress | null {
      const info = inner?.address();
      if (info) {
        return info;
      }
      return listening ? {address: boundHost, family: 'IPv4', port: boundPort} : null;
    },
    close(callback?: (error?: Error) => void): NodeServer {
      const server = inner;
      inner = null;
      listening = false;
      if (!server) {
        emitter.emit('close');
        callback?.();
        return api;
      }
      server.close().then(() => {
        emitter.emit('close');
        callback?.();
      });
      return api;
    },
    closeAllConnections(): void {
      inner?.closeAllConnections();
    },
    unref(): NodeServer {
      return api;
    },
    ref(): NodeServer {
      return api;
    },
    on(event: string, listener: (...args: any[]) => void): NodeServer {
      emitter.on(event, listener);
      return api;
    },
    once(event: string, listener: (...args: any[]) => void): NodeServer {
      emitter.once(event, listener);
      return api;
    },
    removeListener(event: string, listener: (...args: any[]) => void): NodeServer {
      emitter.removeListener(event, listener);
      return api;
    },
    emit(event: string, ...args: any[]): boolean {
      return emitter.emit(event, ...args);
    },
  };

  if (serverOptions) {
    const tlsOption = serverOptions.tls;
    const keystore = serverOptions.keystore ?? tlsOption?.keystore;
    if (tlsOption === true || keystore) {
      innerOptions.tls = {keystore};
    }
  }

  return api as NodeServer;
}

/** Node 风格 HTTP 服务端。 */
export function createServer(handler?: NodeRequestListener): NodeServer;
export function createServer(options: any, handler?: NodeRequestListener): NodeServer;
export function createServer(
  optionsOrHandler?: any,
  maybeHandler?: NodeRequestListener,
): NodeServer {
  if (typeof optionsOrHandler === 'function') {
    return buildServer(optionsOrHandler);
  }
  return buildServer(maybeHandler, optionsOrHandler);
}

/** 发起 HTTP 请求。 */
export function request(...args: any[]): NodeClientRequest {
  const {options, callback} = normalizeRequestArgs(args, 80, 'http:', false);
  return new NodeClientRequest(options, callback);
}

/** 发起 HTTP GET 请求（调用后立即结束请求）。 */
export function get(...args: any[]): NodeClientRequest {
  const {options, callback} = normalizeRequestArgs(args, 80, 'http:', false);
  if (!options.method) {
    options.method = 'GET';
  }
  const client = new NodeClientRequest(options, callback);
  client.end();
  return client;
}

/** 连接池占位：本实现不使用连接池，保留接口是为了兼容桌面代码。 */
export class Agent {
  options: any;
  keepAlive: boolean;
  maxSockets: number;
  maxFreeSockets: number;

  constructor(options?: any) {
    this.options = options || {};
    this.keepAlive = !!this.options.keepAlive;
    this.maxSockets = this.options.maxSockets ?? Infinity;
    this.maxFreeSockets = this.options.maxFreeSockets ?? 256;
  }

  destroy(): void {
    // 没有连接池，无需清理
  }
}

export const globalAgent = new Agent();

export const METHODS = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'QUERY',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
];

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

/**
 * `http` / `https` 共用的模块工厂。
 *
 * `https` 只是默认端口（443）与 TLS 不同，接口完全一致，
 * 因此 `src/polyfills/node/https.ts` 直接复用这里的实现。
 */
export interface HttpModuleOptions {
  defaultPort: number;
  defaultProtocol: string;
  tls: boolean;
  /** TLS 服务端的原生 keystore 资源（移动端需要打包进 assets）。 */
  keystore?: any;
}

export interface HttpModule {
  createServer(handler?: NodeRequestListener): NodeServer;
  createServer(options: any, handler?: NodeRequestListener): NodeServer;
  request(...args: any[]): NodeClientRequest;
  get(...args: any[]): NodeClientRequest;
  Agent: typeof Agent;
  globalAgent: Agent;
  METHODS: string[];
  STATUS_CODES: Record<number, string>;
}

/** 生成一个 `http` / `https` 风格的模块。 */
export function createHttpModule(options: HttpModuleOptions): HttpModule {
  const {defaultPort, defaultProtocol, tls} = options;
  const moduleRequest = (...args: any[]): NodeClientRequest => {
    const {options: clientOptions, callback} = normalizeRequestArgs(
      args,
      defaultPort,
      defaultProtocol,
      tls,
    );
    return new NodeClientRequest(clientOptions, callback);
  };
  const moduleGet = (...args: any[]): NodeClientRequest => {
    const {options: clientOptions, callback} = normalizeRequestArgs(
      args,
      defaultPort,
      defaultProtocol,
      tls,
    );
    if (!clientOptions.method) {
      clientOptions.method = 'GET';
    }
    const client = new NodeClientRequest(clientOptions, callback);
    client.end();
    return client;
  };
  const moduleCreateServer = (
    optionsOrHandler?: any,
    maybeHandler?: NodeRequestListener,
  ): NodeServer => {
    if (typeof optionsOrHandler === 'function') {
      return buildServer(optionsOrHandler, {
        tls: tls || undefined,
        keystore: options.keystore,
      });
    }
    const merged = {...(optionsOrHandler || {})};
    if (tls) {
      merged.tls = true;
    }
    if (options.keystore && !merged.keystore) {
      merged.keystore = options.keystore;
    }
    return buildServer(maybeHandler, merged);
  };
  return {
    createServer: moduleCreateServer,
    request: moduleRequest,
    get: moduleGet,
    Agent,
    globalAgent,
    METHODS,
    STATUS_CODES,
  };
}

const httpModule = createHttpModule({defaultPort: 80, defaultProtocol: 'http:', tls: false});

export default httpModule;
