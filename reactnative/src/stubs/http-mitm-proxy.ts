/**
 * `http-mitm-proxy` 的移动端替身。
 *
 * 桌面版用 `http-mitm-proxy` 做中间人代理：它自己签发证书、装进系统信任库，
 * 因此能解密 HTTPS 流量并改写正文。移动端做不到这一点：
 *
 *  - iOS / Android 不允许 App 往系统证书库塞自签根证书；
 *  - `react-native-tcp-socket` 的 TLS 服务端只认原生 keystore 资产，
 *    没有 PEM 私钥这条路；
 *  - 桌面版那套「装根证书」的流程本身也超出本次移植范围（见 E2RN_TODOS.md）。
 *
 * 所以这里实现的是**明文 HTTP 拦截 + HTTPS 中间人**：
 *
 *  - 明文 HTTP：完整实现 `onRequest` / `onRequestData` / `onRequestEnd` /
 *    `onResponse` / `onResponseData` / `onResponseEnd` 这套钩子，语义对齐
 *    `http-mitm-proxy` 的 `ProxyFinalRequestFilter` / `ProxyFinalResponseFilter`；
 *  - HTTPS（`CONNECT`）：回 `200 Connection Established` 之后，把客户端连接
 *    接到本机的原生 TLS 服务端上（`react-native-tcp-socket` 的
 *    `createTLSServer`，证书来自 APK 里的 PKCS#12 keystore），由它完成 TLS
 *    握手，再走和明文完全相同的钩子链，`ctx.isSSL = true`；上游用 TLS 重连。
 *
 * 前提：客户端必须信任 `certs/auto366-ca.pem`（见
 * `scripts/generate-mitm-cert.js`），否则握手会被客户端拒绝。
 *
 * 没有 keystore 时（`tlsKeystore: false`，或原生 TLS 服务端起不来）自动退回
 * 盲隧道：只做 TCP 转发，看不到明文。
 */
import {Buffer} from 'buffer';
import {EventEmitter} from 'events';
import TcpSocket from 'react-native-tcp-socket';
import {
  MITM_KEYSTORE_PASSWORD,
  MITM_KEYSTORE_RESOURCE,
} from '../mitm/ca-certificate';
import {HttpClientRequest} from '../runtime/http/client';
import {
  HttpServer,
  RawHttpRequest,
  RawHttpResponse,
} from '../runtime/http/server';

export interface ProxyOptions {
  /** 监听端口，默认 8080。 */
  port?: number;
  /** 监听地址，默认 localhost。 */
  host?: string;
  /** 证书缓存目录（移动端不支持，仅为接口兼容而保留）。 */
  sslCaDir?: string;
  /** 是否保持连接。 */
  keepAlive?: boolean;
  /** 超时毫秒数，0 表示不限制。 */
  timeout?: number;
  /** 兼容字段，本实现不使用连接池。 */
  httpAgent?: any;
  httpsAgent?: any;
  /** 兼容字段，本实现没有 SNI 服务端。 */
  forceSNI?: boolean;
  httpsPort?: number;
  /** 去掉上游请求的 content-length，强制 chunked。 */
  forceChunkedRequest?: boolean;
  /**
   * HTTPS 中间人用的原生 PKCS#12 keystore（`res/raw` 资源名，空密码）。
   *
   * 传 `false` 可以关闭中间人能力（CONNECT 退回盲隧道），主要给没有打包
   * 证书的调试构建用。默认 `'auto366_mitm'`。
   */
  tlsKeystore?: string | false;
}

export type MaybeError = Error | null | undefined;
export type ErrorCallback = (error?: MaybeError, data?: any) => void;
export type OnRequestParams = (ctx: ProxyContext, callback: ErrorCallback) => void;
export type OnRequestDataCallback = (error?: MaybeError, chunk?: Buffer) => void;
export type OnRequestDataParams = (
  ctx: ProxyContext,
  chunk: Buffer,
  callback: OnRequestDataCallback,
) => void;
export type OnErrorParams = (
  ctx: ProxyContext | null,
  err?: MaybeError,
  errorKind?: string,
) => void;
export type OnConnectParams = (
  req: any,
  socket: any,
  head: any,
  callback: ErrorCallback,
) => void;

/** 代理的上下文对象。 */
export interface ProxyContext {
  uuid: string;
  isSSL: boolean;
  /** 客户端发来的请求。 */
  clientToProxyRequest: any;
  /** 回给客户端的响应。 */
  proxyToClientResponse: ProxyToClientResponse;
  /** 发往上游的请求（`onRequest` 阶段还是 undefined）。 */
  proxyToServerRequest?: ProxyToServerRequest;
  /** 上游返回的响应。 */
  serverToProxyResponse?: ProxyToServerResponse;
  /** 上游请求参数，`onRequest` 里可以改。 */
  proxyToServerRequestOptions?: {
    method: string;
    path: string;
    host: string;
    port: number;
    headers: Record<string, string>;
  };

  onRequestHandlers: OnRequestParams[];
  onErrorHandlers: OnErrorParams[];
  onRequestDataHandlers: OnRequestDataParams[];
  onRequestEndHandlers: OnRequestParams[];
  onRequestHeadersHandlers: OnRequestParams[];
  onResponseHandlers: OnRequestParams[];
  onResponseHeadersHandlers: OnRequestParams[];
  onResponseDataHandlers: OnRequestDataParams[];
  onResponseEndHandlers: OnRequestParams[];

  /** 响应正文可能被改写 → 上游响应要改用 chunked。 */
  responseContentPotentiallyModified: boolean;

  onRequest(fn: OnRequestParams): ProxyContext;
  onError(fn: OnErrorParams): ProxyContext;
  onRequestData(fn: OnRequestDataParams): ProxyContext;
  onRequestEnd(fn: OnRequestParams): ProxyContext;
  onRequestHeaders(fn: OnRequestParams): ProxyContext;
  onResponse(fn: OnRequestParams): ProxyContext;
  onResponseHeaders(fn: OnRequestParams): ProxyContext;
  onResponseData(fn: OnRequestDataParams): ProxyContext;
  onResponseEnd(fn: OnRequestParams): ProxyContext;
  use(mod: any): ProxyContext;
  addRequestFilter(filter: any): ProxyContext;
  addResponseFilter(filter: any): ProxyContext;
}

/** 回给客户端的响应（Node `ServerResponse` 的形状）。 */
export class ProxyToClientResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = '';
  headers: Record<string, any> = {};
  headersSent = false;
  finished = false;
  writableEnded = false;
  private closed = false;

  constructor(private readonly raw: RawHttpResponse) {
    super();
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, any>,
    maybeHeaders?: Record<string, any>,
  ): this {
    if (this.headersSent) {
      return this;
    }
    this.statusCode = statusCode;
    let headers = maybeHeaders;
    if (typeof statusMessageOrHeaders === 'string') {
      this.statusMessage = statusMessageOrHeaders;
    } else if (statusMessageOrHeaders) {
      headers = statusMessageOrHeaders;
    }
    if (headers) {
      for (const name of Object.keys(headers)) {
        this.headers[name.toLowerCase()] = headers[name];
      }
    }
    this.headersSent = true;
    this.raw.writeHead(
      statusCode,
      this.statusMessage || undefined,
      {...this.headers},
    );
    return this;
  }

  getHeader(name: string): any {
    return this.headers[String(name).toLowerCase()];
  }

  setHeader(name: string, value: any): this {
    if (!this.headersSent) {
      this.headers[String(name).toLowerCase()] = value;
    }
    return this;
  }

  removeHeader(name: string): this {
    delete this.headers[String(name).toLowerCase()];
    return this;
  }

  write(chunk: any): boolean {
    if (this.finished) {
      return false;
    }
    if (!this.headersSent) {
      this.writeHead(this.statusCode);
    }
    this.raw.write(chunk);
    return true;
  }

  end(chunk?: any): void {
    if (this.finished) {
      return;
    }
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    if (!this.headersSent) {
      this.writeHead(this.statusCode);
    }
    this.finished = true;
    this.writableEnded = true;
    this.raw.end();
    this.emit('finish');
    this.emitClose();
  }

  destroy(error?: Error): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.writableEnded = true;
    try {
      this.raw.destroy(error);
    } catch {
      // 忽略
    }
    this.emitClose();
  }

  private emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit('close');
  }
}

/** 上游响应（Node `IncomingMessage` 的形状）。 */
export class ProxyToServerResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = '';
  headers: Record<string, any> = {};
  complete = false;

  constructor(
    statusCode: number,
    statusMessage: string,
    headers: Record<string, any>,
  ) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
  }
}

/** 发往上游的请求（Node `ClientRequest` 的形状）。 */
export class ProxyToServerRequest extends EventEmitter {
  private readonly inner: HttpClientRequest;

  constructor(inner: HttpClientRequest) {
    super();
    this.inner = inner;
  }

  get headers(): Record<string, string> {
    return this.inner.getHeaders();
  }

  getHeader(name: string): string | undefined {
    return this.inner.getHeader(name);
  }

  getHeaders(): Record<string, string> {
    return this.inner.getHeaders();
  }

  setHeader(name: string, value: any): void {
    this.inner.setHeader(name, value);
  }

  removeHeader(name: string): void {
    this.inner.removeHeader(name);
  }

  write(chunk: any): boolean {
    return this.inner.write(chunk);
  }

  end(chunk?: any): void {
    this.inner.end(chunk);
  }

  abort(): void {
    this.inner.destroy();
  }

  destroy(error?: Error): void {
    this.inner.destroy(error);
  }
}

/** 客户端请求（Node `IncomingMessage` 的形状）。 */
class ClientToProxyRequest extends EventEmitter {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, any>;
  body: Buffer;
  socket: any;
  complete = true;

  constructor(request: RawHttpRequest) {
    super();
    this.method = request.method;
    this.url = request.url;
    this.httpVersion = request.httpVersion;
    this.headers = request.headers;
    this.body = request.body;
    this.socket = request.socket;
  }
}

/** 生成一个足够随机的 uuid（不引入额外依赖）。 */
function createUuid(): string {
  const random = Math.random().toString(16).slice(2, 10);
  const time = Date.now().toString(16);
  return `${time}-${random}-${random}`;
}

/** 去掉 HPKP 之类的废弃响应头。 */
export function filterAndCanonizeHeaders(
  originalHeaders: Record<string, any>,
): Record<string, any> {
  const headers: Record<string, any> = {};
  for (const key of Object.keys(originalHeaders || {})) {
    const canonizedKey = key.trim();
    if (/^public-key-pins/i.test(canonizedKey)) {
      continue;
    }
    headers[canonizedKey] = originalHeaders[key];
  }
  return headers;
}

/** 解析 `host[:port]`。 */
export function parseHost(
  hostString: string,
  defaultPort?: number,
): {host: string; port: number} {
  const text = String(hostString || '').trim();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end >= 0) {
      const host = text.slice(0, end + 1);
      const rest = text.slice(end + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
      return {host, port: port || defaultPort || 80};
    }
  }
  const index = text.lastIndexOf(':');
  if (index > 0) {
    const port = Number(text.slice(index + 1));
    return {host: text.slice(0, index), port: port || defaultPort || 80};
  }
  return {host: text, port: defaultPort || 80};
}

/**
 * 从请求行和 Host 头里解析目标地址。
 *
 * 返回 `null` 表示 Host 缺失（真实代理会回 400）。
 */
export function parseHostAndPort(
  url: string,
  hostHeader: string | undefined,
  defaultPort = 80,
): {host: string; port: number; path: string} | null {
  const absolute = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/.exec(
    url || '',
  );
  if (absolute) {
    const authority = absolute[2] || '';
    const path = `${absolute[3] || '/'}${absolute[4] || ''}`;
    const parsed = parseHost(authority, defaultPort);
    return {host: parsed.host, port: parsed.port, path: path || '/'};
  }
  if (hostHeader) {
    const parsed = parseHost(hostHeader, defaultPort);
    return {host: parsed.host, port: parsed.port, path: url || '/'};
  }
  return null;
}

/**
 * 顺序执行一串 `(ctx, callback)` 钩子。
 *
 * 和 `async.forEach` 的语义一致：全部完成（或出错）才继续。
 */
function runHandlers(
  handlers: Array<(ctx: ProxyContext, callback: ErrorCallback) => void>,
  ctx: ProxyContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0;
    const next = (error?: MaybeError) => {
      if (error) {
        reject(error);
        return;
      }
      if (index >= handlers.length) {
        resolve();
        return;
      }
      const handler = handlers[index++];
      let called = false;
      const done = (err?: MaybeError) => {
        if (called) {
          return;
        }
        called = true;
        next(err);
      };
      try {
        handler(ctx, done);
      } catch (thrown) {
        done(thrown as Error);
      }
    };
    next();
  });
}

/**
 * 顺序执行一串 `(ctx, chunk, callback)` 钩子，返回最终的数据块。
 *
 * 和真实实现一致：上一个钩子的输出是下一个钩子的输入；
 * 钩子返回 `null` 表示丢弃这一块。
 */
function runDataHandlers(
  handlers: OnRequestDataParams[],
  ctx: ProxyContext,
  chunk: Buffer,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let index = 0;
    let current: any = chunk;
    const next = (error?: MaybeError) => {
      if (error) {
        reject(error);
        return;
      }
      if (index >= handlers.length) {
        resolve(current === undefined ? null : current);
        return;
      }
      const handler = handlers[index++];
      let called = false;
      const done = (err?: MaybeError, newChunk?: Buffer) => {
        if (called) {
          return;
        }
        called = true;
        if (err) {
          reject(err);
          return;
        }
        current = newChunk;
        next();
      };
      try {
        handler(ctx, current, done);
      } catch (thrown) {
        done(thrown as Error);
      }
    };
    next();
  });
}

/** 默认的 keystore 资源名（`android/app/src/main/res/raw/auto366_mitm.p12`）。 */
const DEFAULT_KEYSTORE = MITM_KEYSTORE_RESOURCE;

/**
 * 移动端版的中间人代理。
 *
 * 明文 HTTP 完整拦截；HTTPS 用原生 TLS 服务端终止后走同一套钩子。
 */
export class Proxy {
  options: ProxyOptions = {};
  httpPort = 0;
  httpHost?: string;
  timeout = 0;
  keepAlive = false;
  forceSNI = false;
  httpsPort?: number;
  sslCaDir = '';
  responseContentPotentiallyModified = false;

  private server: HttpServer | null = null;
  /** 本机 TLS 服务端，用来给 CONNECT 的客户端做 TLS 终止。 */
  private tlsServer: HttpServer | null = null;
  /** 上面那个服务端的端口（0 = 不可用，CONNECT 退回盲隧道）。 */
  private tlsPort = 0;
  private readonly onErrorHandlers: OnErrorParams[] = [];
  private readonly onRequestHandlers: OnRequestParams[] = [];
  private readonly onRequestHeadersHandlers: OnRequestParams[] = [];
  private readonly onRequestDataHandlers: OnRequestDataParams[] = [];
  private readonly onRequestEndHandlers: OnRequestParams[] = [];
  private readonly onResponseHandlers: OnRequestParams[] = [];
  private readonly onResponseHeadersHandlers: OnRequestParams[] = [];
  private readonly onResponseDataHandlers: OnRequestDataParams[] = [];
  private readonly onResponseEndHandlers: OnRequestParams[] = [];
  private readonly onConnectHandlers: OnConnectParams[] = [];

  constructor(options?: ProxyOptions) {
    this.options = options || {};
  }

  /** 开始监听。回调收到 error 表示失败。 */
  listen(
    options?: ProxyOptions,
    callback?: (error?: MaybeError) => void,
  ): this {
    this.options = options || this.options || {};
    this.httpPort = this.options.port ?? 8080;
    this.httpHost = this.options.host || 'localhost';
    this.timeout = this.options.timeout || 0;
    this.keepAlive = !!this.options.keepAlive;
    this.forceSNI = !!this.options.forceSNI;

    const server = new HttpServer(
      (request, response) => this.handleRequest(request, response),
      {
        requestTimeout: this.timeout,
      },
    );
    this.server = server;

    const start = async () => {
      await server.listen(this.httpPort, this.httpHost || '0.0.0.0');
      const info = server.address();
      if (info) {
        this.httpPort = info.port;
      }
      // 原生 TLS 服务端起不来不影响明文代理：CONNECT 会退回盲隧道。
      await this.startTlsServer();
    };

    start().then(
      () => callback?.(),
      (error: Error) => callback?.(error),
    );
    return this;
  }

  /**
   * 启动本机 TLS 服务端（HTTPS 中间人的服务端那一半）。
   *
   * `react-native-tcp-socket` 只能从 APK 里的 PKCS#12 keystore 建 TLS 服务端，
   * 证书和私钥都由原生 `SSLContext` 持有，JS 侧只拿到明文字节流。
   */
  private async startTlsServer(): Promise<void> {
    const keystore =
      this.options.tlsKeystore === undefined
        ? DEFAULT_KEYSTORE
        : this.options.tlsKeystore;
    if (!keystore) {
      return;
    }
    const tlsServer = new HttpServer(
      (request, response) => this.handleHttp(request, response, true),
      // `TLSServer.setSecureContext` runs the value through
      // `Image.resolveAssetSource(...).uri`; an object is returned unchanged,
      // so `{uri: 'auto366_mitm'}` resolves to the `res/raw` resource name
      // without having to `require()` the keystore (which would make Metro
      // bundle a second copy of it).
      {tls: {keystore: {uri: keystore}, password: MITM_KEYSTORE_PASSWORD}},
    );
    try {
      await tlsServer.listen(0, '127.0.0.1');
      const info = tlsServer.address();
      if (!info || !info.port) {
        throw new Error('TLS 服务端没有拿到端口');
      }
      this.tlsServer = tlsServer;
      this.tlsPort = info.port;
      console.log(`[http-mitm-proxy] HTTPS 中间人已就绪 (127.0.0.1:${info.port})`);
    } catch (error) {
      this.tlsPort = 0;
      console.warn(
        '[http-mitm-proxy] HTTPS 中间人不可用，CONNECT 将退回盲隧道:',
        error,
      );
    }
  }

  /** 停止监听。 */
  close(): this {
    const server = this.server;
    this.server = null;
    server?.close();
    const tlsServer = this.tlsServer;
    this.tlsServer = null;
    this.tlsPort = 0;
    tlsServer?.close();
    return this;
  }

  onError(fn: OnErrorParams): this {
    this.onErrorHandlers.push(fn);
    return this;
  }

  onRequest(fn: OnRequestParams): this {
    this.onRequestHandlers.push(fn);
    return this;
  }

  onRequestHeaders(fn: OnRequestParams): this {
    this.onRequestHeadersHandlers.push(fn);
    return this;
  }

  onRequestData(fn: OnRequestDataParams): this {
    this.onRequestDataHandlers.push(fn);
    return this;
  }

  onRequestEnd(fn: OnRequestParams): this {
    this.onRequestEndHandlers.push(fn);
    return this;
  }

  onResponse(fn: OnRequestParams): this {
    this.onResponseHandlers.push(fn);
    return this;
  }

  onResponseHeaders(fn: OnRequestParams): this {
    this.onResponseHeadersHandlers.push(fn);
    return this;
  }

  onResponseData(fn: OnRequestDataParams): this {
    this.onResponseDataHandlers.push(fn);
    this.responseContentPotentiallyModified = true;
    return this;
  }

  onResponseEnd(fn: OnRequestParams): this {
    this.onResponseEndHandlers.push(fn);
    return this;
  }

  onConnect(fn: OnConnectParams): this {
    this.onConnectHandlers.push(fn);
    return this;
  }

  /** 装载一个模块（只支持回调型钩子）。 */
  use(mod: any): this {
    if (!mod) {
      return this;
    }
    if (mod.onError) {
      this.onError(mod.onError);
    }
    if (mod.onRequest) {
      this.onRequest(mod.onRequest);
    }
    if (mod.onRequestHeaders) {
      this.onRequestHeaders(mod.onRequestHeaders);
    }
    if (mod.onRequestData) {
      this.onRequestData(mod.onRequestData);
    }
    if (mod.onRequestEnd) {
      this.onRequestEnd(mod.onRequestEnd);
    }
    if (mod.onResponse) {
      this.onResponse(mod.onResponse);
    }
    if (mod.onResponseHeaders) {
      this.onResponseHeaders(mod.onResponseHeaders);
    }
    if (mod.onResponseData) {
      this.onResponseData(mod.onResponseData);
    }
    if (mod.onResponseEnd) {
      this.onResponseEnd(mod.onResponseEnd);
    }
    return this;
  }

  /** 证书相关回调：移动端没有中间人能力，直接回错误。 */
  onCertificateRequired(hostname: string, callback: any): void {
    callback(new Error('移动端不支持 HTTPS 中间人代理（缺少证书签发能力）'));
  }

  onCertificateMissing(ctx: any, files: any, callback: any): void {
    callback(new Error('移动端不支持 HTTPS 中间人代理（缺少证书签发能力）'));
  }

  /**
   * 处理一条进来的连接。
   *
   * `CONNECT` 走 HTTPS 中间人（没有 TLS 服务端时退回盲隧道），其它方法按普通
   * HTTP 代理处理。
   */
  private handleRequest(
    rawRequest: RawHttpRequest,
    rawResponse: RawHttpResponse,
  ): void {
    if (rawRequest.isConnect) {
      this.handleConnect(rawRequest, rawResponse);
      return;
    }
    this.handleHttp(rawRequest, rawResponse, false);
  }

  /**
   * CONNECT：回 200 之后把连接交给本机 TLS 服务端（中间人）或直接转发
   * （盲隧道）。
   */
  private handleConnect(
    rawRequest: RawHttpRequest,
    rawResponse: RawHttpResponse,
  ): void {
    const socket = rawResponse.hijack();
    const target = String(rawRequest.url || '');
    const parsed = parseHost(target, 443);
    const rest = rawRequest.rest;

    const fail = (error: Error) => {
      this.reportError(null, error, 'CONNECT_ERROR');
      try {
        rawResponse.writeRaw(
          'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n',
        );
      } catch {
        // 忽略
      }
      try {
        socket?.destroy?.();
      } catch {
        // 忽略
      }
    };

    if (!parsed.host) {
      fail(new Error(`无法解析 CONNECT 目标: ${target}`));
      return;
    }

    // 客户端要等这个 200 才会开始 TLS 握手。
    try {
      rawResponse.writeRaw('HTTP/1.1 200 Connection Established\r\n\r\n');
    } catch {
      // 忽略
    }

    if (this.tlsPort) {
      this.pipeToTlsServer(socket, rest, target);
      return;
    }
    this.pipeBlindTunnel(socket, rest, parsed);
  }

  /**
   * 把客户端连接接到本机 TLS 服务端。
   *
   * 服务端在另一条 socket 上完成 TLS 握手，因此这里只是双向转发密文；
   * 解密后的 HTTP 由 `handleHttp(..., isSSL = true)` 处理。
   */
  private pipeToTlsServer(socket: any, rest: Buffer | undefined, target: string): void {
    try {
      this.bridge(socket, {host: '127.0.0.1', port: this.tlsPort}, rest);
    } catch (error) {
      this.reportError(null, error as Error, 'CONNECT_TLS_ERROR');
      try {
        socket.destroy?.();
      } catch {
        // 忽略
      }
      return;
    }
    console.log(`[http-mitm-proxy] CONNECT ${target} → 本机 TLS 中间人`);
  }

  /** CONNECT：盲隧道，代理看不到 TLS 明文。 */
  private pipeBlindTunnel(
    socket: any,
    rest: Buffer | undefined,
    parsed: {host: string; port: number},
  ): void {
    try {
      this.bridge(socket, parsed, rest);
    } catch (error) {
      this.reportError(null, error as Error, 'CONNECT_ERROR');
      try {
        socket.destroy?.();
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 双向转发两条 TCP 连接，`rest`（CONNECT 首部之后同一批到达的字节）先写给
   * 目标端。
   *
   * 客户端拿到 `200 Connection Established` 后**立刻**开始 TLS 握手，握手包
   * 可能比 `TcpSocket.connect` 的 `connect` 回调更早到达。因此这里先挂上
   * `data` 监听并缓冲，等目标连接建立后再回放，避免丢包导致握手卡死。
   */
  private bridge(
    client: any,
    target: {host: string; port: number},
    rest: Buffer | undefined,
  ): void {
    const pending: any[] = [];
    let upstream: any = null;
    /** `TcpSocket.connect()` 返回的对象立刻可用，但连接建立前 `write()` 会抛错。 */
    let ready = false;
    let closed = false;

    const teardown = () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        upstream?.destroy?.();
      } catch {
        // 忽略
      }
      try {
        client.destroy?.();
      } catch {
        // 忽略
      }
    };

    client.on('data', (data: any) => {
      if (closed) {
        return;
      }
      if (!ready) {
        pending.push(data);
        return;
      }
      try {
        upstream.write(data);
      } catch {
        teardown();
      }
    });
    client.on('close', teardown);
    client.on('error', teardown);

    try {
      upstream = TcpSocket.connect({host: target.host, port: target.port}, () => {
        if (closed) {
          return;
        }
        ready = true;
        try {
          if (rest && rest.length) {
            upstream.write(rest);
          }
          for (const chunk of pending) {
            upstream.write(chunk);
          }
        } catch {
          teardown();
          return;
        }
        pending.length = 0;
      });
    } catch (error) {
      teardown();
      throw error;
    }

    upstream.on('data', (data: any) => {
      try {
        client.write(data);
      } catch {
        teardown();
      }
    });
    upstream.on('close', teardown);
    upstream.on('error', teardown);
  }

  /** 明文 HTTP / 中间人后的 HTTPS：完整实现 http-mitm-proxy 的钩子语义。 */
  private handleHttp(
    rawRequest: RawHttpRequest,
    rawResponse: RawHttpResponse,
    isSSL: boolean,
  ): void {
    const clientRequest = new ClientToProxyRequest(rawRequest);
    const clientResponse = new ProxyToClientResponse(rawResponse);
    const ctx = this.createContext(clientRequest, clientResponse);
    ctx.isSSL = isSSL;

    // 客户端断开时通知钩子（桌面代码用它释放抓包文件）
    const socket = rawRequest.socket;
    try {
      socket?.on?.('close', () => {
        clientRequest.emit('aborted');
      });
    } catch {
      // 忽略
    }

    this.pipeRequest(ctx, clientRequest, rawRequest).catch((error: Error) => {
      console.error('[http-mitm-proxy] 处理请求失败:', error);
    });
  }

  private createContext(
    clientRequest: ClientToProxyRequest,
    clientResponse: ProxyToClientResponse,
  ): ProxyContext {
    const ctx: ProxyContext = {
      uuid: createUuid(),
      isSSL: false,
      clientToProxyRequest: clientRequest,
      proxyToClientResponse: clientResponse,
      proxyToServerRequest: undefined,
      serverToProxyResponse: undefined,
      proxyToServerRequestOptions: undefined,
      onRequestHandlers: [],
      onErrorHandlers: [],
      onRequestDataHandlers: [],
      onRequestEndHandlers: [],
      onRequestHeadersHandlers: [],
      onResponseHandlers: [],
      onResponseHeadersHandlers: [],
      onResponseDataHandlers: [],
      onResponseEndHandlers: [],
      responseContentPotentiallyModified: false,
      onRequest(fn) {
        ctx.onRequestHandlers.push(fn);
        return ctx;
      },
      onError(fn) {
        ctx.onErrorHandlers.push(fn);
        return ctx;
      },
      onRequestData(fn) {
        ctx.onRequestDataHandlers.push(fn);
        return ctx;
      },
      onRequestEnd(fn) {
        ctx.onRequestEndHandlers.push(fn);
        return ctx;
      },
      onRequestHeaders(fn) {
        ctx.onRequestHeadersHandlers.push(fn);
        return ctx;
      },
      onResponse(fn) {
        ctx.onResponseHandlers.push(fn);
        return ctx;
      },
      onResponseHeaders(fn) {
        ctx.onResponseHeadersHandlers.push(fn);
        return ctx;
      },
      onResponseData(fn) {
        ctx.onResponseDataHandlers.push(fn);
        ctx.responseContentPotentiallyModified = true;
        return ctx;
      },
      onResponseEnd(fn) {
        ctx.onResponseEndHandlers.push(fn);
        return ctx;
      },
      use(mod: any) {
        if (!mod) {
          return ctx;
        }
        if (mod.onError) {
          ctx.onError(mod.onError);
        }
        if (mod.onRequest) {
          ctx.onRequest(mod.onRequest);
        }
        if (mod.onRequestHeaders) {
          ctx.onRequestHeaders(mod.onRequestHeaders);
        }
        if (mod.onRequestData) {
          ctx.onRequestData(mod.onRequestData);
        }
        if (mod.onRequestEnd) {
          ctx.onRequestEnd(mod.onRequestEnd);
        }
        if (mod.onResponse) {
          ctx.onResponse(mod.onResponse);
        }
        if (mod.onResponseHeaders) {
          ctx.onResponseHeaders(mod.onResponseHeaders);
        }
        if (mod.onResponseData) {
          ctx.onResponseData(mod.onResponseData);
        }
        if (mod.onResponseEnd) {
          ctx.onResponseEnd(mod.onResponseEnd);
        }
        return ctx;
      },
      addRequestFilter() {
        // 过滤器是流式的，本实现不支持；正文改写请用 onRequestData / onRequestEnd。
        return ctx;
      },
      addResponseFilter() {
        return ctx;
      },
    };
    return ctx;
  }

  /** 请求方向：onRequest → 上游请求 → onRequestData → onRequestEnd → 结束。 */
  private async pipeRequest(
    ctx: ProxyContext,
    clientRequest: ClientToProxyRequest,
    rawRequest: RawHttpRequest,
  ): Promise<void> {
    const isSSL = !!ctx.isSSL;
    const target = parseHostAndPort(
      clientRequest.url,
      clientRequest.headers?.host,
      isSSL ? 443 : 80,
    );
    if (!target) {
      ctx.proxyToClientResponse.writeHead(400, {
        'Content-Type': 'text/html; charset=utf-8',
      });
      ctx.proxyToClientResponse.end('Bad request: Host missing...');
      return;
    }
    // 绝对形式的请求行要改写成 origin 形式，Host 头补齐
    clientRequest.url = target.path;
    if (!clientRequest.headers.host) {
      const defaultPort = isSSL ? 443 : 80;
      clientRequest.headers.host =
        target.port === defaultPort ? target.host : `${target.host}:${target.port}`;
    }

    const headers: Record<string, string> = {};
    for (const name of Object.keys(clientRequest.headers || {})) {
      // 逐跳头不转发
      if (/^proxy-/i.test(name) || name.toLowerCase() === 'connection') {
        continue;
      }
      const value = clientRequest.headers[name];
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    if (this.options.forceChunkedRequest) {
      delete headers['content-length'];
    }

    ctx.proxyToServerRequestOptions = {
      method: clientRequest.method,
      path: target.path,
      host: target.host,
      port: target.port,
      headers,
    };

    try {
      await runHandlers(
        this.onRequestHandlers.concat(ctx.onRequestHandlers),
        ctx,
      );
    } catch (error) {
      this.reportError(ctx, error as Error, 'ON_REQUEST_ERROR');
      this.failClient(ctx, 500);
      return;
    }

    try {
      await runHandlers(
        this.onRequestHeadersHandlers.concat(ctx.onRequestHeadersHandlers),
        ctx,
      );
    } catch (error) {
      this.reportError(ctx, error as Error, 'ON_REQUESTHEADERS_ERROR');
      this.failClient(ctx, 500);
      return;
    }

    const options = ctx.proxyToServerRequestOptions!;
    const upstream = new HttpClientRequest({
      host: options.host,
      hostname: options.host,
      port: options.port,
      path: options.path,
      method: options.method,
      headers: options.headers,
      tls: isSSL,
      timeout: this.timeout || undefined,
    });
    const proxyToServerRequest = new ProxyToServerRequest(upstream);
    ctx.proxyToServerRequest = proxyToServerRequest;
    proxyToServerRequest.on('error', (error: Error) => {
      this.reportError(ctx, error, 'PROXY_TO_SERVER_REQUEST_ERROR');
      this.failClient(ctx, 502);
    });

    // 上游响应
    let chain: Promise<void> = Promise.resolve();
    upstream.on('response', (head: any) => {
      chain = chain.then(() => this.handleResponseHead(ctx, head));
    });
    upstream.on('data', (chunk: Buffer) => {
      chain = chain.then(() => this.handleResponseChunk(ctx, chunk));
    });
    upstream.on('end', () => {
      chain = chain.then(() => this.handleResponseEnd(ctx));
    });
    upstream.on('aborted', () => {
      ctx.serverToProxyResponse?.emit('aborted');
    });
    upstream.on('error', (error: Error) => {
      this.reportError(ctx, error, 'SERVER_TO_PROXY_RESPONSE_ERROR');
    });

    // 请求正文：整包缓冲后一次性交给钩子
    const body = rawRequest.body;
    if (body && body.length > 0) {
      try {
        const filtered = await runDataHandlers(
          this.onRequestDataHandlers.concat(ctx.onRequestDataHandlers),
          ctx,
          body,
        );
        if (filtered && filtered.length > 0) {
          proxyToServerRequest.write(filtered);
        }
      } catch (error) {
        this.reportError(ctx, error as Error, 'ON_REQUEST_DATA_ERROR');
        this.failClient(ctx, 500);
        return;
      }
    }

    try {
      await runHandlers(
        this.onRequestEndHandlers.concat(ctx.onRequestEndHandlers),
        ctx,
      );
    } catch (error) {
      this.reportError(ctx, error as Error, 'ON_REQUEST_END_ERROR');
      this.failClient(ctx, 500);
      return;
    }

    proxyToServerRequest.end();
  }

  /** 响应首部：onResponse → 调整响应头 → onResponseHeaders → 写回客户端。 */
  private async handleResponseHead(
    ctx: ProxyContext,
    head: any,
  ): Promise<void> {
    const serverToProxyResponse = new ProxyToServerResponse(
      head?.statusCode ?? 502,
      head?.statusMessage ?? '',
      {...(head?.headers ?? {})},
    );
    ctx.serverToProxyResponse = serverToProxyResponse;

    try {
      await runHandlers(
        this.onResponseHandlers.concat(ctx.onResponseHandlers),
        ctx,
      );
    } catch (error) {
      this.reportError(ctx, error as Error, 'ON_RESPONSE_ERROR');
      this.failClient(ctx, 500);
      return;
    }

    const headers = serverToProxyResponse.headers;
    // 逐跳头不转发：上游连接用完就关
    delete headers.connection;
    delete headers['proxy-connection'];
    delete headers['keep-alive'];
    delete headers.upgrade;

    if (
      this.responseContentPotentiallyModified ||
      ctx.responseContentPotentiallyModified
    ) {
      headers['transfer-encoding'] = 'chunked';
      delete headers['content-length'];
    }

    try {
      await runHandlers(
        this.onResponseHeadersHandlers.concat(ctx.onResponseHeadersHandlers),
        ctx,
      );
    } catch (error) {
      this.reportError(ctx, error as Error, 'ON_RESPONSEHEADERS_ERROR');
      this.failClient(ctx, 500);
      return;
    }

    ctx.proxyToClientResponse.writeHead(
      serverToProxyResponse.statusCode,
      serverToProxyResponse.statusMessage || undefined,
      filterAndCanonizeHeaders(headers),
    );
  }

  /** 响应正文：逐块过 onResponseData。 */
  private async handleResponseChunk(
    ctx: ProxyContext,
    chunk: Buffer,
  ): Promise<void> {
    if (!chunk || chunk.length === 0) {
      return;
    }
    try {
      const filtered = await runDataHandlers(
        this.onResponseDataHandlers.concat(ctx.onResponseDataHandlers),
        ctx,
        chunk,
      );
      if (filtered && filtered.length > 0) {
        ctx.proxyToClientResponse.write(filtered);
      }
    } catch (error) {
      this.reportError(ctx, error as Error, 'ON_RESPONSE_DATA_ERROR');
    }
  }

  /** 响应结束：onResponseEnd → 关闭客户端响应。 */
  private async handleResponseEnd(ctx: ProxyContext): Promise<void> {
    try {
      await runHandlers(
        this.onResponseEndHandlers.concat(ctx.onResponseEndHandlers),
        ctx,
      );
    } catch (error) {
      this.reportError(ctx, error as Error, 'ON_RESPONSE_END_ERROR');
    }
    ctx.proxyToClientResponse.end();
  }

  /** 出错时给客户端一个 5xx。 */
  private failClient(ctx: ProxyContext, statusCode: number): void {
    try {
      if (!ctx.proxyToClientResponse.headersSent) {
        ctx.proxyToClientResponse.writeHead(statusCode, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        ctx.proxyToClientResponse.end(`${statusCode}`);
      } else if (!ctx.proxyToClientResponse.finished) {
        ctx.proxyToClientResponse.end();
      }
    } catch {
      // 忽略
    }
  }

  /** 上报错误：全局钩子 + 上下文钩子。 */
  private reportError(
    ctx: ProxyContext | null,
    error: Error,
    kind: string,
  ): void {
    console.warn(`[http-mitm-proxy] ${kind}:`, error?.message ?? error);
    for (const handler of this.onErrorHandlers) {
      try {
        handler(ctx, error, kind);
      } catch {
        // 忽略
      }
    }
    if (ctx) {
      for (const handler of ctx.onErrorHandlers) {
        try {
          handler(ctx, error, kind);
        } catch {
          // 忽略
        }
      }
    }
  }

  /** 兼容真实包的静态方法。 */
  static parseHostAndPort = parseHostAndPort;
  static parseHost = parseHost;
  static filterAndCanonizeHeaders = filterAndCanonizeHeaders;

  /** 真实包提供的中间件，移动端用不到，调用即报错。 */
  static gunzip = {
    onResponseData(): void {
      throw new Error('移动端代理不支持 gunzip 中间件');
    },
  };
  static wildcard = {
    onCertificateMissing(): void {
      throw new Error('移动端代理不支持 wildcard 中间件');
    },
  };
}

export default {Proxy};
