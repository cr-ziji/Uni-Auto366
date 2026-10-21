/**
 * Node `net` 兼容层（React Native）。
 *
 * 底层用 `react-native-tcp-socket`（原生 TCP）。桌面版代码本身没有直接用 `net`，
 * 但 `http` / `https` / `http-mitm-proxy` 这些第三方库会用到，所以这里补一个
 * Node 形状的最小实现：
 *
 *  - `createServer(options?, connectionListener?)`
 *  - `connect(options?, connectListener?)` / `createConnection`
 *  - `Socket` / `Server`
 *  - `isIP` / `isIPv4` / `isIPv6`
 *
 * 与 Node 的差别：
 *  - `destroy()` 不接受错误参数，错误通过 `error` 事件报告；
 *  - 没有 `error` 监听者时只打印日志，不会让 App 崩溃。
 */
import {Buffer} from 'buffer';
import {EventEmitter} from 'events';
import TcpSocket from 'react-native-tcp-socket';

export interface SocketOptions {
  host?: string;
  port?: number;
  path?: string;
  family?: number;
  localAddress?: string;
  localPort?: number;
  timeout?: number;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
}

export interface NetOptions {
  allowHalfOpen?: boolean;
  pauseOnConnect?: boolean;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
}

export interface AddressInfo {
  address: string;
  family: string;
  port: number;
}

/** 把任意输入归一化成 Buffer。 */
function toBuffer(data: any, encoding?: any): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (typeof data === 'string') {
    const enc =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8';
    return Buffer.from(data, enc);
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  return Buffer.alloc(0);
}

/** Node 形状的 socket。 */
export class Socket extends EventEmitter {
  /** 底层原生 socket。 */
  protected native: any = null;
  protected encoding: string = 'utf8';
  protected destroyedFlag = false;

  bytesRead = 0;
  bytesWritten = 0;
  connecting = false;

  constructor(native?: any) {
    super();
    if (native) {
      this.attach(native);
    }
  }

  /** 绑定底层原生 socket，并接管它的事件。 */
  attach(native: any): void {
    this.native = native;
    native.on('data', (data: any) => {
      const chunk = toBuffer(data);
      this.bytesRead += chunk.length;
      this.emit('data', chunk);
    });
    native.on('error', (error: any) => {
      this.emit('error', error);
    });
    native.on('close', (hadError?: boolean) => {
      this.destroyedFlag = true;
      this.emit('close', !!hadError);
    });
    native.on('timeout', () => {
      this.emit('timeout');
    });
    try {
      native.setNoDelay?.(true);
    } catch {
      // 忽略
    }
  }

  get connected(): boolean {
    return !!this.native && !this.destroyedFlag;
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  get readyState(): string {
    return this.destroyedFlag ? 'closed' : this.connected ? 'open' : 'opening';
  }

  get remoteAddress(): string | undefined {
    return this.native?.remoteAddress;
  }

  get remotePort(): number | undefined {
    return this.native?.remotePort;
  }

  get localAddress(): string | undefined {
    return this.native?.localAddress;
  }

  get localPort(): number | undefined {
    return this.native?.localPort;
  }

  setEncoding(encoding: string): this {
    this.encoding = encoding;
    try {
      this.native?.setEncoding?.(encoding);
    } catch {
      // 忽略
    }
    return this;
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    if (callback) {
      this.once('timeout', callback);
    }
    try {
      this.native?.setTimeout?.(milliseconds);
    } catch {
      // 忽略
    }
    return this;
  }

  setNoDelay(value = true): this {
    try {
      this.native?.setNoDelay?.(value);
    } catch {
      // 忽略
    }
    return this;
  }

  setKeepAlive(enable = false, initialDelay = 0): this {
    try {
      this.native?.setKeepAlive?.(enable, initialDelay);
    } catch {
      // 忽略
    }
    return this;
  }

  address(): AddressInfo | null {
    const info = this.native?.address?.();
    return info ? {address: info.address, family: info.family, port: info.port} : null;
  }

  write(data: any, encoding?: any, callback?: (error?: Error) => void): boolean {
    if (this.destroyedFlag) {
      return false;
    }
    const chunk = toBuffer(data, encoding);
    this.bytesWritten += chunk.length;
    try {
      this.native?.write(chunk, encoding, callback);
    } catch (error) {
      this.emit('error', error);
      return false;
    }
    return true;
  }

  end(data?: any, encoding?: any): this {
    try {
      if (data !== undefined && data !== null) {
        this.native?.end(toBuffer(data, encoding), encoding);
      } else {
        this.native?.end?.();
      }
    } catch (error) {
      this.emit('error', error);
    }
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyedFlag) {
      return this;
    }
    this.destroyedFlag = true;
    if (error) {
      this.emit('error', error);
    }
    try {
      this.native?.destroy?.();
    } catch {
      // 忽略
    }
    return this;
  }

  pause(): this {
    try {
      this.native?.pause?.();
    } catch {
      // 忽略
    }
    return this;
  }

  resume(): this {
    try {
      this.native?.resume?.();
    } catch {
      // 忽略
    }
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  /** 简单的 `pipe`：把数据转给目标流，源结束时结束目标。 */
  pipe<T extends {write: (chunk: any) => any; end?: () => void}>(
    destination: T,
    options?: {end?: boolean},
  ): T {
    this.on('data', (chunk: any) => {
      destination.write(chunk);
    });
    if (!options || options.end !== false) {
      this.on('end', () => destination.end?.());
      this.on('close', () => destination.end?.());
    }
    return destination;
  }
}

/** Node 形状的 TCP 服务端。 */
export class Server extends EventEmitter {
  private native: any = null;
  private readonly options: NetOptions;

  constructor(
    options?: NetOptions | ((socket: Socket) => void),
    connectionListener?: (socket: Socket) => void,
  ) {
    super();
    if (typeof options === 'function') {
      connectionListener = options;
      this.options = {};
    } else {
      this.options = options || {};
    }
    if (connectionListener) {
      this.on('connection', connectionListener);
    }
  }

  get listening(): boolean {
    return !!this.native?.listening;
  }

  listen(
    port: number,
    host?: string | (() => void),
    callback?: () => void,
  ): this {
    const resolvedCallback =
      typeof host === 'function'
        ? host
        : typeof callback === 'function'
        ? callback
        : undefined;
    const resolvedHost = typeof host === 'string' ? host : '0.0.0.0';
    try {
      this.native = TcpSocket.createServer(
        {noDelay: this.options.noDelay ?? true, ...this.options},
        (socket: any) => {
          this.emit('connection', new Socket(socket));
        },
      );
      this.native.on('error', (error: any) => this.emit('error', error));
      this.native.on('listening', () => this.emit('listening'));
      this.native.on('close', () => this.emit('close'));
      this.native.listen({port, host: resolvedHost});
    } catch (error) {
      this.emit('error', error);
      return this;
    }
    if (resolvedCallback) {
      this.once('listening', resolvedCallback);
    }
    return this;
  }

  address(): AddressInfo | null {
    const info = this.native?.address?.();
    return info ? {address: info.address, family: info.family, port: info.port} : null;
  }

  getConnections(callback: (error: Error | null, count: number) => void): this {
    this.native?.getConnections?.((error: any, count: number) =>
      callback(error, count),
    );
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    try {
      this.native?.close?.((error?: Error) => {
        this.emit('close');
        callback?.(error);
      });
    } catch (error) {
      callback?.(error as Error);
    }
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** 创建 TCP 服务端。 */
export function createServer(
  options?: NetOptions | ((socket: Socket) => void),
  connectionListener?: (socket: Socket) => void,
): Server {
  return new Server(options, connectionListener);
}

/** 建立 TCP 连接。 */
export function connect(
  options: SocketOptions | number | string,
  connectListener?: ((socket: Socket) => void) | SocketOptions,
  listener?: (socket: Socket) => void,
): Socket {
  let resolved: SocketOptions = {};
  let resolvedListener: ((socket: Socket) => void) | undefined;
  if (typeof options === 'number') {
    resolved = {port: options};
    resolvedListener =
      typeof connectListener === 'function' ? connectListener : undefined;
  } else if (typeof options === 'string') {
    resolved = {host: options};
    resolvedListener =
      typeof connectListener === 'function' ? connectListener : undefined;
  } else {
    resolved = {...options};
    if (typeof connectListener === 'function') {
      resolvedListener = connectListener;
    } else if (connectListener) {
      resolved = {...resolved, ...connectListener};
      resolvedListener = listener;
    }
  }
  const host = resolved.host || '127.0.0.1';
  const port = Number(resolved.port) || 0;
  const socket = new Socket();
  try {
    const native = TcpSocket.connect({host, port}, () => {
      socket.connecting = false;
      socket.emit('connect');
      resolvedListener?.(socket);
    });
    socket.attach(native);
  } catch (error) {
    setTimeout(() => socket.emit('error', error), 0);
  }
  if (resolved.timeout) {
    socket.setTimeout(resolved.timeout);
  }
  return socket;
}

/** `connect` 的别名。 */
export function createConnection(
  options: SocketOptions | number | string,
  connectListener?: ((socket: Socket) => void) | SocketOptions,
  listener?: (socket: Socket) => void,
): Socket {
  return connect(options, connectListener as any, listener);
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 判断是不是 IPv4 地址。 */
export function isIPv4(input: string): boolean {
  return IPV4_PATTERN.test(String(input || ''));
}

/** 判断是不是 IPv6 地址。 */
export function isIPv6(input: string): boolean {
  const text = String(input || '');
  return text.includes(':') && /^[0-9a-f:.]+$/i.test(text);
}

/** 判断地址类型：4 / 6 / 0。 */
export function isIP(input: string): number {
  if (isIPv4(input)) {
    return 4;
  }
  if (isIPv6(input)) {
    return 6;
  }
  return 0;
}

export default {
  Socket,
  Server,
  createServer,
  connect,
  createConnection,
  isIP,
  isIPv4,
  isIPv6,
};
