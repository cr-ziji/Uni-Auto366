/**
 * 基于 `react-native-tcp-socket` 的极简 HTTP/1.1 客户端。
 *
 * 与 Node 的差别：
 *  - 首部延迟到第一次 `write()`/`end()` 才真正发出，这样 `setHeader()` /
 *    `removeHeader()` 在正文写入之前依然有效（代理改写正文时需要）；
 *  - 未知长度的请求正文使用 chunked 编码；
 *  - 没有连接池（`Agent` 只是占位）。
 *
 * 支持：
 *  - TLS（`options.tls`，走 `TcpSocket.connectTLS`）；
 *  - chunked 请求 / 响应正文；
 *  - 中间响应（`100 Continue` / `103 Early Hints`）自动跳过。
 */
import {Buffer} from 'buffer';
import TcpSocket from 'react-native-tcp-socket';
import {
  BodyReader,
  HttpHeaders,
  ParsedResponseHead,
  buildRequestHead,
  headerValue,
  isInterimStatus,
  parseResponseHead,
  resolveResponseFraming,
  toBuffer,
} from './parse';
import {normalizeSocketError} from './server';

export interface HttpClientOptions {
  host?: string;
  hostname?: string;
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, any>;
  body?: any;
  /** 空闲超时（毫秒），超时后触发 `timeout` 事件。 */
  timeout?: number;
  /** 是否使用 TLS。 */
  tls?: boolean;
  ca?: any;
  key?: any;
  cert?: any;
  rejectUnauthorized?: boolean;
  /** `AbortSignal`，中止时销毁请求。 */
  signal?: any;
  /** 连接失败时的重试次数（默认 0）。 */
  retries?: number;
}

export interface HttpClientResponseHead extends ParsedResponseHead {
  headers: HttpHeaders;
}

/** 首部超过这个大小仍然没解析出来，认为是协议错误。 */
const MAX_HEAD_SIZE = 128 * 1024;

/** 精简版事件发射器（行为接近 Node 的 EventEmitter）。 */
export class HttpEmitter {
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return this;
    }
    const index = bucket.indexOf(listener);
    if (index >= 0) {
      bucket.splice(index, 1);
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /**
   * 触发事件。
   *
   * 与 Node 的差别：没有监听者的 `error` 事件只打印日志，不会抛出未捕获异常，
   * 避免在 React Native 里因为一次网络错误让整个 App 崩掉。
   */
  emit(event: string, ...args: any[]): boolean {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.length === 0) {
      if (event === 'error') {
        console.error('[http] 未处理的 error 事件:', args[0]);
      }
      return false;
    }
    for (const listener of [...bucket]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[http] ${event} 监听器异常:`, error);
      }
    }
    return true;
  }
}

/** HTTP 客户端请求。 */
export class HttpClientRequest extends HttpEmitter {
  private socket: any = null;
  private connected = false;
  private headSent = false;
  private bodyStarted = false;
  private requestEnded = false;
  private destroyedFlag = false;
  private chunked = false;
  private pendingBody: Buffer[] = [];
  private readonly headers = new Map<string, {name: string; value: string}>();
  private readonly options: HttpClientOptions;
  private timeoutMs = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private responseHead: HttpClientResponseHead | null = null;
  private reader: BodyReader | null = null;
  private complete = false;
  private aborted = false;
  private readonly host: string;
  private readonly port: number;
  private readonly method: string;
  private readonly path: string;
  private abortError: Error | null = null;

  constructor(options: HttpClientOptions) {
    super();
    this.options = {...options};
    let host = String(options.hostname || options.host || '127.0.0.1');
    let port = Number(options.port) || 0;
    if (!port && host.includes(':') && !host.includes(']')) {
      const parts = host.split(':');
      host = parts[0];
      port = Number(parts[1]) || 0;
    }
    this.host = host;
    this.port = port || (options.tls ? 443 : 80);
    this.method = String(options.method || 'GET').toUpperCase();
    this.path = options.path || '/';
    this.timeoutMs = Number(options.timeout) || 0;
    const headers = options.headers || {};
    for (const name of Object.keys(headers)) {
      this.setHeader(name, headers[name]);
    }
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) {
        this.abortError = new Error('The operation was aborted.');
        (this.abortError as any).name = 'AbortError';
      } else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => {
          this.abortError = new Error('The operation was aborted.');
          (this.abortError as any).name = 'AbortError';
          this.destroy(this.abortError);
        });
      }
    }
  }

  /** 设置请求头（首部发出之前有效）。 */
  setHeader(name: string, value: any): void {
    if (this.headSent) {
      const error: any = new Error(
        'Cannot set headers after they are sent to the client',
      );
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    const key = String(name).toLowerCase();
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    this.headers.set(key, {name: String(name), value: text});
  }

  removeHeader(name: string): void {
    if (this.headSent) {
      const error: any = new Error(
        'Cannot remove headers after they are sent to the client',
      );
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    this.headers.delete(String(name).toLowerCase());
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(String(name).toLowerCase())?.value;
  }

  getHeaders(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, entry] of this.headers) {
      result[key] = entry.value;
    }
    return result;
  }

  /** 写入正文；首部会在第一次写入时才发出。 */
  write(chunk: any): boolean {
    if (this.destroyedFlag) {
      return false;
    }
    const data = toBuffer(chunk);
    this.bodyStarted = true;
    this.ensureSocket();
    if (this.connected) {
      this.sendHead();
      this.writeBody(data);
    } else {
      this.pendingBody.push(data);
    }
    return true;
  }

  /** 结束请求。 */
  end(chunk?: any): void {
    if (this.destroyedFlag) {
      return;
    }
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    this.requestEnded = true;
    this.ensureSocket();
    if (this.connected) {
      this.sendHead();
      this.finishRequest();
    }
  }

  /** 设置空闲超时。 */
  setTimeout(milliseconds: number, callback?: () => void): this {
    this.timeoutMs = Number(milliseconds) || 0;
    if (callback) {
      this.once('timeout', callback);
    }
    try {
      this.socket?.setTimeout?.(this.timeoutMs);
    } catch {
      // 忽略
    }
    return this;
  }

  /** 销毁请求（底层连接一起断开）。 */
  destroy(error?: Error): void {
    if (this.destroyedFlag) {
      return;
    }
    this.destroyedFlag = true;
    try {
      this.socket?.destroy?.();
    } catch {
      // 忽略
    }
    if (error) {
      this.emit('error', error);
    }
    this.emit('close');
  }

  /** 底层 socket（调试用）。 */
  getSocket(): any {
    return this.socket;
  }

  private ensureSocket(): void {
    if (this.socket || this.destroyedFlag) {
      return;
    }
    if (this.abortError) {
      this.destroy(this.abortError);
      return;
    }
    try {
      if (this.options.tls) {
        this.socket = TcpSocket.connectTLS(
          {
            host: this.host,
            port: this.port,
            // 原生实现用 IP 建 socket，不传 servername 就不会发 SNI；
            // Cloudflare / Supabase 这类按域名路由的服务端会直接握手失败。
            servername: this.host,
            ca: this.options.ca,
            key: this.options.key,
            cert: this.options.cert,
          } as any,
          () => this.onReady(),
        );
      } else {
        this.socket = TcpSocket.connect(
          {host: this.host, port: this.port},
          () => this.onReady(),
        );
      }
    } catch (error) {
      this.emit('error', normalizeSocketError(error));
      return;
    }
    this.socket.on('data', (data: any) => this.onData(data));
    this.socket.on('error', (error: any) =>
      this.emit('error', normalizeSocketError(error)),
    );
    this.socket.on('close', () => this.onClose());
    this.socket.on('timeout', () => this.emit('timeout'));
    if (this.timeoutMs) {
      try {
        this.socket.setTimeout?.(this.timeoutMs);
      } catch {
        // 忽略
      }
    }
  }

  private onReady(): void {
    this.connected = true;
    if (!this.pendingBody.length && !this.requestEnded) {
      return;
    }
    this.sendHead();
    for (const chunk of this.pendingBody) {
      this.writeBody(chunk);
    }
    this.pendingBody = [];
    if (this.requestEnded) {
      this.finishRequest();
    }
  }

  private sendHead(): void {
    if (this.headSent) {
      return;
    }
    this.headSent = true;
    const headers: Record<string, string> = {};
    for (const [key, entry] of this.headers) {
      headers[key] = entry.value;
    }
    if (!headers.host) {
      const defaultPort = this.options.tls ? 443 : 80;
      headers.host =
        this.port === defaultPort ? this.host : `${this.host}:${this.port}`;
    }
    if (!headers.connection) {
      headers.connection = 'close';
    }
    const encoding = headerValue(headers as any, 'transfer-encoding').toLowerCase();
    const hasLength = headerValue(headers as any, 'content-length') !== '';
    if (encoding.includes('chunked')) {
      this.chunked = true;
    } else if (hasLength) {
      this.chunked = false;
    } else if (this.bodyStarted) {
      // 长度未知：使用 chunked
      this.chunked = true;
      headers['transfer-encoding'] = 'chunked';
      delete headers['content-length'];
    } else if (this.method === 'POST' || this.method === 'PUT' || this.method === 'PATCH') {
      headers['content-length'] = '0';
    }
    try {
      this.socket.write(
        buildRequestHead(this.method, this.path, headers as any),
      );
    } catch (error) {
      this.emit('error', normalizeSocketError(error));
    }
  }

  private writeBody(data: Buffer): void {
    if (!data.length) {
      return;
    }
    try {
      if (this.chunked) {
        this.socket.write(`${data.length.toString(16)}\r\n`);
        this.socket.write(data);
        this.socket.write('\r\n');
      } else {
        this.socket.write(data);
      }
    } catch (error) {
      this.emit('error', normalizeSocketError(error));
    }
  }

  private finishRequest(): void {
    if (this.chunked) {
      try {
        this.socket.write('0\r\n\r\n');
      } catch {
        // 忽略
      }
    }
    // 不要调用 `socket.end()`：`react-native-tcp-socket` 把 `end` 实现成
    // `NativeModules.TcpSockets.end(id)` -> `TcpSocketClient.destroy()`，
    // 也就是**关闭整条连接**（不是 Node 的半关闭）。请求一写完就关连接，
    // 上游的响应就再也读不到了。这里只把请求发完，连接由响应结束时关闭
    // （见 `process()`）。
  }

  private onData(data: any): void {
    if (this.destroyedFlag) {
      return;
    }
    const chunk = toBuffer(data);
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    this.process();
  }

  private process(): void {
    for (;;) {
      if (!this.responseHead) {
        const parsed = parseResponseHead(this.buffer);
        if (!parsed.head) {
          if (
            this.buffer.length > MAX_HEAD_SIZE &&
            this.buffer.indexOf('\r\n\r\n') >= 0
          ) {
            this.destroy(new Error('Parse Error: response head is too large'));
          }
          return;
        }
        this.buffer = parsed.rest;
        if (isInterimStatus(parsed.head.statusCode)) {
          // 中间响应：报告给上层后继续等真正的响应
          this.emit(
            parsed.head.statusCode === 100 ? 'continue' : 'information',
            parsed.head,
          );
          continue;
        }
        this.responseHead = parsed.head as HttpClientResponseHead;
        this.reader = new BodyReader(
          resolveResponseFraming(
            this.responseHead.headers,
            this.responseHead.statusCode,
            this.method,
          ),
          this.responseHead.headers,
        );
        this.emit('response', this.responseHead);
      }
      if (!this.reader) {
        return;
      }
      const result = this.reader.push(this.buffer);
      this.buffer = result.rest;
      for (const chunk of result.chunks) {
        this.emit('data', chunk);
      }
      if (result.complete && !this.complete) {
        this.complete = true;
        this.emit('end');
        // 没有连接池：响应收完就主动断开，避免 keep-alive 连接一直占着。
        // 用底层 socket 的 `destroy` 而不是 `this.destroy()`，让 `close`
        // 事件仍然由 socket 的 close 事件统一触发一次。
        try {
          this.socket?.destroy?.();
        } catch {
          // 忽略
        }
      }
      return;
    }
  }

  private onClose(): void {
    if (!this.complete) {
      if (this.reader) {
        const result = this.reader.finish();
        for (const chunk of result.chunks) {
          this.emit('data', chunk);
        }
        if (result.complete) {
          this.complete = true;
          this.emit('end');
        } else {
          // 正文没收全：连接被中断
          this.aborted = true;
          this.emit('aborted');
          this.emit('error', new Error('socket hang up'));
        }
      } else {
        this.aborted = true;
        this.emit('aborted');
        this.emit('error', new Error('socket hang up'));
      }
    }
    this.emit('close');
  }
}

/** 一次性请求：把响应体完整读进内存。 */
export async function httpRequest(
  options: HttpClientOptions,
): Promise<HttpClientResponseHead & {body: Buffer}> {
  return new Promise((resolve, reject) => {
    const request = new HttpClientRequest(options);
    const chunks: Buffer[] = [];
    let head: any = null;
    request.on('response', responseHead => {
      head = responseHead;
    });
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve({...head, body: Buffer.concat(chunks)});
    });
    request.on('error', (error: Error) => reject(error));
    request.end(options.body);
  });
}

/** 流式请求：逐块回调响应内容。 */
export async function httpRequestStream(
  options: HttpClientOptions,
  onChunk: (chunk: Buffer) => void | Promise<void>,
): Promise<HttpClientResponseHead> {
  return new Promise((resolve, reject) => {
    const request = new HttpClientRequest(options);
    let head: any = null;
    let chain: Promise<void> = Promise.resolve();
    request.on('response', responseHead => {
      head = responseHead;
    });
    request.on('data', (chunk: Buffer) => {
      chain = chain.then(() => onChunk(chunk));
    });
    request.on('end', () => {
      chain
        .then(() => resolve(head))
        .catch(error => reject(error));
    });
    request.on('error', (error: Error) => reject(error));
    request.end(options.body);
  });
}
