/**
 * 极简 HTTP/1.1 服务端（网络层由原生 `Auto366Net` 提供）。
 *
 * 只实现移动端移植需要的部分：
 *  - 请求首部解析 + `Content-Length` / chunked 正文；
 *  - keep-alive 复用连接；
 *  - `Expect: 100-continue`；
 *  - `hijack()` 交出底层连接（代理的 CONNECT 隧道需要）；
 *  - `writeRaw()` 直接往 socket 写字节（CONNECT 隧道 / 协议升级需要）。
 *
 * 请求正文在进入回调前已经完整缓冲：JS 线程无法在原生回调里把数据交给
 * 挂起的异步函数，因此先缓冲再回放更可靠。
 *
 * TLS 由原生层负责：传入 `options.tls` 后，原生服务端会额外启动一个只监听
 * loopback 的 TLS 服务端，CONNECT 连接通过原生隧道接入后，以 `isSSL = true`
 * 的普通连接回调回来，HTTP 解析与钩子链与明文完全一致。
 */
import {Buffer} from 'buffer';
import {createNativeServer, NativeServer} from '../native/net';
import {
  BodyReader,
  HttpHeaders,
  ParsedRequestHead,
  buildResponseHead,
  defaultStatusMessage,
  headerValue,
  parseRequestHead,
  resolveRequestFraming,
  toBuffer,
} from './parse';

export interface RawHttpRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HttpHeaders;
  body: Buffer;
  /** 底层 socket（升级 / CONNECT 隧道时使用）。 */
  socket: any;
  /** 请求是否为 `CONNECT`（代理隧道）。 */
  isConnect?: boolean;
  /** 连接是否已经由原生层完成 TLS 终止（HTTPS 中间人）。 */
  isSSL?: boolean;
  /**
   * 解析完首部（和正文）之后同一批数据里多出来的字节。
   *
   * CONNECT 隧道需要它：客户端可能在 `CONNECT` 首部后面紧跟着发 TLS 握手包，
   * 那样这部分字节不能丢。
   */
  rest?: Buffer;
}

export interface RawHttpResponse {
  writeHead(statusCode: number, statusMessage?: string, headers?: HttpHeaders): void;
  /** 写入正文；返回 `false` 表示底层连接已经不可写（调用方不应再补结束标记）。 */
  write(chunk: any): boolean;
  end(chunk?: any): void;
  destroy(error?: Error): void;
  /** 交出底层连接，之后服务端不再管理这条连接。 */
  hijack(): any;
  /** 直接往 socket 写原始字节（不做分帧）。 */
  writeRaw(data: any): void;
  readonly headersSent: boolean;
  readonly finished: boolean;
}

export type RawRequestHandler = (
  request: RawHttpRequest,
  response: RawHttpResponse,
) => void | Promise<void>;

export interface HttpServerOptions {
  /**
   * TLS 服务端参数。原生层从 APK / App bundle 里的 PKCS#12 读取证书，
   * 不经过 JS，也不需要 `react-native-tcp-socket` 补丁。
   */
  tls?: {resource: string; password?: string};
  /** 整个请求（含响应）允许的最长毫秒数，0 表示不限制。 */
  requestTimeout?: number;
  /** keep-alive 连接的空闲毫秒数，0 表示不限制。 */
  keepAliveTimeout?: number;
}

/** 原生层抛回来的错误只有一段文本，这里补上 Node 风格的 `code`。 */
export function normalizeSocketError(error: any): Error {
  if (error instanceof Error) {
    return error;
  }
  const message = typeof error === 'string' ? error : String((error && error.message) || error);
  const normalized: any = new Error(message);
  if (/EADDRINUSE|address already in use/i.test(message)) {
    normalized.code = 'EADDRINUSE';
  } else if (/EACCES|permission denied/i.test(message)) {
    normalized.code = 'EACCES';
  } else if (/ECONNREFUSED|connection refused/i.test(message)) {
    normalized.code = 'ECONNREFUSED';
  } else if (/ECONNRESET|connection reset/i.test(message)) {
    normalized.code = 'ECONNRESET';
  } else if (/ENOTFOUND|unable to resolve host|host not found/i.test(message)) {
    normalized.code = 'ENOTFOUND';
  } else if (/ETIMEDOUT|timed out/i.test(message)) {
    normalized.code = 'ETIMEDOUT';
  }
  return normalized as Error;
}

/** 连接是否可以在响应后继续复用。 */
export function shouldKeepAlive(head: ParsedRequestHead): boolean {
  const connection = headerValue(head.headers, 'connection').toLowerCase();
  if (connection.includes('close')) {
    return false;
  }
  if ((head.httpVersion || 'HTTP/1.1').toUpperCase() === 'HTTP/1.0') {
    return connection.includes('keep-alive');
  }
  return true;
}

/** 响应是否允许携带正文。 */
function bodyAllowed(method: string, statusCode: number): boolean {
  if (method && method.toUpperCase() === 'HEAD') {
    return false;
  }
  return statusCode !== 204 && statusCode !== 304 && (statusCode < 100 || statusCode >= 200);
}

/** 服务端响应：负责首部、正文分帧与结束处理。 */
class ServerResponse implements RawHttpResponse {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  finished = false;
  private headers: HttpHeaders = {};
  private chunked = false;
  private destroyed = false;
  private noBody = false;

  constructor(
    private readonly socket: any,
    private readonly keepAlive: boolean,
    private readonly method: string,
    private readonly onFinish: (response: ServerResponse) => void,
    private readonly onHijack: () => void,
  ) {}

  writeHead(statusCode: number, statusMessage?: string, headers?: HttpHeaders): void {
    if (this.headersSent || this.destroyed) {
      return;
    }
    this.statusCode = statusCode;
    this.statusMessage = statusMessage || defaultStatusMessage(statusCode);
    if (headers) {
      for (const name of Object.keys(headers)) {
        this.headers[name.toLowerCase()] = headers[name];
      }
    }
    this.noBody = !bodyAllowed(this.method, this.statusCode);
    const encoding = headerValue(this.headers, 'transfer-encoding').toLowerCase();
    const hasLength = headerValue(this.headers, 'content-length') !== '';
    if (this.noBody) {
      this.chunked = false;
      delete this.headers['transfer-encoding'];
    } else if (encoding.includes('chunked')) {
      this.chunked = true;
    } else if (hasLength) {
      this.chunked = false;
      delete this.headers['transfer-encoding'];
    } else {
      this.chunked = true;
    }
    const finalHeaders: HttpHeaders = {...this.headers};
    if (this.chunked) {
      finalHeaders['transfer-encoding'] = 'chunked';
    } else {
      delete finalHeaders['transfer-encoding'];
    }
    if (!this.keepAlive) {
      finalHeaders.connection = 'close';
    }
    this.headersSent = true;
    try {
      this.socket.write(
        buildResponseHead(this.statusCode, this.statusMessage, finalHeaders),
      );
    } catch {
      // 连接已断开，忽略
    }
  }

  write(chunk: any): boolean {
    if (this.destroyed || this.finished) {
      return false;
    }
    if (!this.headersSent) {
      this.writeHead(this.statusCode);
    }
    if (this.noBody) {
      return true;
    }
    const data = toBuffer(chunk);
    if (!data.length) {
      return true;
    }
    try {
      if (this.chunked) {
        const head = this.socket.write(`${data.length.toString(16)}\r\n`);
        const body = this.socket.write(data);
        const tail = this.socket.write('\r\n');
        return head !== false && body !== false && tail !== false;
      }
      return this.socket.write(data) !== false;
    } catch {
      // 写入失败说明连接已经不可用；返回 false 让上层断开而不是补一个
      // “正常结束”的 chunked 终止块（那会让客户端把截断的 ZIP 当成功）。
      return false;
    }
  }

  end(chunk?: any): void {
    if (this.destroyed || this.finished) {
      return;
    }
    if (chunk !== undefined && chunk !== null) {
      if (!this.write(chunk)) {
        this.destroy();
        return;
      }
    }
    if (!this.headersSent) {
      this.writeHead(this.statusCode);
    }
    this.finished = true;
    if (this.chunked && !this.noBody) {
      try {
        this.socket.write('0\r\n\r\n');
      } catch {
        // 忽略
      }
    }
    if (!this.keepAlive) {
      try {
        this.socket.end?.();
      } catch {
        // 忽略
      }
    }
    this.onFinish(this);
  }

  destroy(_error?: Error): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.finished = true;
    try {
      this.socket.destroy?.();
    } catch {
      // 忽略
    }
    this.onFinish(this);
  }

  hijack(): any {
    this.onHijack();
    this.finished = true;
    return this.socket;
  }

  writeRaw(data: any): void {
    try {
      this.socket.write(toBuffer(data));
    } catch {
      // 忽略
    }
  }
}

/** 极简 HTTP/1.1 服务端。 */
export class HttpServer {
  private server: NativeServer | null = null;
  private readonly sockets = new Set<any>();
  private readonly options: HttpServerOptions;
  /** 原生 TLS 服务端是否就绪（CONNECT 能否做中间人）。 */
  private tlsReady = false;

  constructor(
    private readonly handler: RawRequestHandler,
    options?: HttpServerOptions,
  ) {
    this.options = options || {};
  }

  /** 是否可以对 CONNECT 做 TLS 中间人。 */
  get hasTls(): boolean {
    return this.tlsReady;
  }

  /** 监听端口，Promise 在监听成功后 resolve。 */
  listen(port: number, host: string = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let server: NativeServer;
      try {
        server = createNativeServer(
          {tls: this.options.tls},
          (socket: any) => this.handleConnection(socket),
        );
      } catch (error) {
        reject(normalizeSocketError(error));
        return;
      }
      server.on('listening', () => {
        this.tlsReady = server.hasTls;
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      server.on('error', (error: any) => {
        const normalized = normalizeSocketError(error);
        if (!settled) {
          settled = true;
          reject(normalized);
          return;
        }
        console.error('[http] 服务端错误:', normalized);
      });
      server.listen(port, host).catch((error: Error) => {
        if (!settled) {
          settled = true;
          reject(normalizeSocketError(error));
        }
      });
      this.server = server;
    });
  }

  /** 实际绑定的地址。 */
  address(): {address: string; family: string; port: number} | null {
    const info = this.server && this.server.address ? this.server.address() : null;
    if (!info || !info.port) {
      return null;
    }
    return {address: info.address, family: info.family, port: info.port};
  }

  /** 停止监听并断开所有连接。 */
  close(): Promise<void> {
    return new Promise(resolve => {
      const server = this.server;
      this.server = null;
      this.tlsReady = false;
      this.closeAllConnections();
      if (!server) {
        resolve();
        return;
      }
      server.close().then(() => resolve(), () => resolve());
    });
  }

  /** 断开所有已建立的连接。 */
  closeAllConnections(): void {
    for (const socket of Array.from(this.sockets)) {
      try {
        socket.destroy?.();
      } catch {
        // 忽略
      }
    }
    this.sockets.clear();
  }

  private handleConnection(socket: any): void {
    this.sockets.add(socket);
    try {
      socket.setNoDelay?.(true);
    } catch {
      // 忽略
    }

    let buffer: Buffer = Buffer.alloc(0);
    let state: 'head' | 'body' | 'responding' | 'hijacked' | 'closed' = 'head';
    let head: ParsedRequestHead | null = null;
    let reader: BodyReader | null = null;
    let bodyChunks: Buffer[] = [];
    let requestTimer: any = null;
    let keepAliveTimer: any = null;

    const clearRequestTimer = () => {
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = null;
      }
    };
    const clearKeepAliveTimer = () => {
      if (keepAliveTimer) {
        clearTimeout(keepAliveTimer);
        keepAliveTimer = null;
      }
    };
    const armRequestTimer = () => {
      const limit = Number(this.options.requestTimeout) || 0;
      if (limit <= 0) {
        return;
      }
      clearRequestTimer();
      requestTimer = setTimeout(() => {
        try {
          socket.destroy?.();
        } catch {
          // 忽略
        }
      }, limit);
    };
    const armKeepAliveTimer = () => {
      const limit = Number(this.options.keepAliveTimeout) || 0;
      if (limit <= 0) {
        return;
      }
      clearKeepAliveTimer();
      keepAliveTimer = setTimeout(() => {
        try {
          socket.destroy?.();
        } catch {
          // 忽略
        }
      }, limit);
    };

    const cleanup = () => {
      this.sockets.delete(socket);
      clearRequestTimer();
      clearKeepAliveTimer();
    };

    const process = () => {
      for (;;) {
        if (state === 'head') {
          const parsed = parseRequestHead(buffer);
          if (!parsed.head) {
            return;
          }
          head = parsed.head;
          buffer = parsed.rest;
          bodyChunks = [];
          armRequestTimer();
          const expect = headerValue(head.headers, 'expect').toLowerCase();
          if (expect.includes('100-continue')) {
            try {
              socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            } catch {
              // 忽略
            }
          }
          reader = new BodyReader(resolveRequestFraming(head.headers), head.headers);
          state = 'body';
          continue;
        }
        if (state === 'body' && reader) {
          const result = reader.push(buffer);
          buffer = result.rest;
          for (const chunk of result.chunks) {
            bodyChunks.push(chunk);
          }
          if (!result.complete) {
            return;
          }
          const request: RawHttpRequest = {
            method: head!.method,
            url: head!.url,
            httpVersion: head!.httpVersion,
            headers: head!.headers,
            body: Buffer.concat(bodyChunks),
            socket,
            isConnect: head!.method === 'CONNECT',
            isSSL: !!socket?.isSSL,
            rest: buffer.length ? buffer : undefined,
          };
          const keepAlive = shouldKeepAlive(head!);
          const response = new ServerResponse(
            socket,
            keepAlive,
            head!.method,
            () => {
              clearRequestTimer();
              if (state === 'hijacked' || state === 'closed') {
                return;
              }
              if (keepAlive) {
                state = 'head';
                head = null;
                reader = null;
                bodyChunks = [];
                armKeepAliveTimer();
                process();
              } else {
                state = 'closed';
              }
            },
            () => {
              state = 'hijacked';
              clearRequestTimer();
              clearKeepAliveTimer();
            },
          );
          state = 'responding';
          try {
            const outcome = this.handler(request, response);
            Promise.resolve(outcome).catch(error => {
              response.destroy(normalizeSocketError(error));
            });
          } catch (error) {
            console.error('[http] 请求处理异常:', error);
            response.destroy(normalizeSocketError(error));
          }
          return;
        }
        return;
      }
    };

    socket.on('data', (data: any) => {
      if (state === 'hijacked' || state === 'closed') {
        return;
      }
      clearKeepAliveTimer();
      buffer = buffer.length ? Buffer.concat([buffer, toBuffer(data)]) : toBuffer(data);
      try {
        process();
      } catch {
        state = 'closed';
        try {
          socket.destroy?.();
        } catch {
          // 忽略
        }
      }
    });
    socket.on('error', () => {
      cleanup();
    });
    socket.on('close', () => {
      cleanup();
    });
  }
}
