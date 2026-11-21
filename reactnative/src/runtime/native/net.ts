/**
 * 原生 TCP / TLS 传输层。
 *
 * 代理、HTTP 服务端与 HTTP 客户端都通过这里访问网络。真正的 socket、
 * TLS 握手、CONNECT 隧道和 MITM 都在 Android / iOS 原生模块
 * `Auto366Net` 里完成，JS 侧只负责 HTTP 协议解析与业务钩子。
 *
 * 和 `react-native-tcp-socket` 的关键区别：
 *
 *  - TLS 服务端由原生 `SSLContext` / Network.framework 直接建在**同一条**
 *    客户端连接上，不再经过「本机 loopback TLS 服务端 + JS 双向转发密文」，
 *    大文件（ZIP）不会因为两段转发和背压问题被截断；
 *  - PKCS#12 由原生直接读取，不再需要 `patch-tcp-socket`；
 *  - `tunnel()` 在原生层完成字节搬运，CONNECT 后的 TLS 握手包不会在 JS
 *    事件队列里丢失；
 *  - 连接建立 / TLS 握手成功后才会触发回调，`write()` 不会再遇到
 *    “Socket is closed”。
 */
import {Buffer} from 'buffer';
import {EventEmitter} from 'events';
import {NativeEventEmitter, NativeModules} from 'react-native';
import {decodeBase64 as decodeBase64Native} from './base64';

/** 原生模块名，Android `Auto366NetModule` / iOS `Auto366Net`。 */
const MODULE_NAME = 'Auto366Net';

const EVENT_CONNECTION = 'Auto366Net.connection';
const EVENT_DATA = 'Auto366Net.data';
const EVENT_CLOSE = 'Auto366Net.close';
const EVENT_ERROR = 'Auto366Net.error';
const EVENT_TIMEOUT = 'Auto366Net.timeout';
const EVENT_SERVER_ERROR = 'Auto366Net.serverError';

export interface NativeTlsOptions {
  /** Android `res/raw` 资源名，或 iOS bundle 里的 p12 文件名（不带扩展名）。 */
  resource: string;
  /** PKCS#12 密码。 */
  password?: string;
}

export interface NativeServerOptions {
  /** 监听地址，默认 0.0.0.0。 */
  host?: string;
  /** 监听端口，0 表示随机端口。 */
  port?: number;
  /** 传入后同时启动一个只监听 127.0.0.1 的 TLS 服务端，供 CONNECT 使用。 */
  tls?: NativeTlsOptions;
}

export interface NativeServerInfo {
  port: number;
  tlsPort: number;
  hasTls: boolean;
}

export interface NativeTunnelOptions {
  host: string;
  port: number;
  /** CONNECT 首部之后同一批到达的字节（TLS ClientHello 等）。 */
  rest?: Buffer | string | null;
  /** 连接到本机 TLS 服务端（HTTPS 中间人），而不是目标主机。 */
  useTls?: boolean;
}

interface NativeModule {
  listen(
    serverId: string,
    host: string,
    port: number,
    tlsResource: string | null,
    tlsPassword: string | null,
  ): Promise<NativeServerInfo>;
  closeServer(serverId: string): Promise<void>;
  connect(
    socketId: string,
    host: string,
    port: number,
    tls: boolean,
    servername: string | null,
    timeoutMs: number,
  ): Promise<void>;
  resume(socketId: string): Promise<void>;
  suspend(socketId: string): void;
  write(socketId: string, base64: string): void;
  /** 异步写入：原生层真正写完（或排入系统发送缓冲）后 resolve。旧构建可能没有。 */
  writeAsync?(socketId: string, base64: string): Promise<void>;
  shutdown(socketId: string): void;
  close(socketId: string): void;
  setTimeout(socketId: string, milliseconds: number): void;
  setNoDelay(socketId: string, value: boolean): void;
  tunnel(
    socketId: string,
    host: string,
    port: number,
    restBase64: string | null,
    useTls: boolean,
  ): Promise<void>;
}

/** 原生模块在 Jest / 未编译原生层的环境里不存在，调用时给出明确错误。 */
function native(): NativeModule {
  const instance = (NativeModules as any)[MODULE_NAME] as NativeModule | undefined;
  if (!instance) {
    throw new Error(
      `[Auto366Net] 原生传输模块不可用：请重新安装包含 ${MODULE_NAME} 的 Android/iOS 构建`,
    );
  }
  return instance;
}

/** `true` 表示当前运行环境包含原生传输模块。 */
export function isNativeNetAvailable(): boolean {
  return !!(NativeModules as any)[MODULE_NAME];
}

let nextSocketId = 0;
function createSocketId(prefix: string): string {
  nextSocketId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextSocketId.toString(36)}`;
}

/** 单次跨原生桥写入的字节上限（base64 后约 87 KiB）。 */
const MAX_NATIVE_WRITE = 64 * 1024;
/** 最多同时有多少个分片在等待原生 `writeAsync` 完成。 */
const MAX_NATIVE_IN_FLIGHT = 4;

function decodeBase64(text: string | null | undefined): Buffer {
  return text ? decodeBase64Native(text) : Buffer.alloc(0);
}

/**
 * 把 `Uint8Array` 切片变成真正的 `Buffer`，并且**不复制**底层字节。
 *
 * RN 的 `Buffer.subarray()` 返回普通 `Uint8Array`；它的 `toString()` 不接受
 * 编码参数，直接交给原生层会编码出错误内容。用同一个 `ArrayBuffer` 重新
 * 包一层 `Buffer` 即可获得正确的 `toString('base64')`，同时避免为整个 ZIP
 * 再分配一份等大的内存。
 */
function asBufferView(view: Uint8Array): Buffer {
  if (Buffer.isBuffer(view)) {
    return view;
  }
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/** 把原生层抛过来的字符串补成 Node 风格的错误对象。 */
export function normalizeNativeError(error: any): Error {
  if (error instanceof Error) {
    return error;
  }
  const message =
    typeof error === 'string'
      ? error
      : String((error && (error.message || error.error)) || error);
  const normalized: any = new Error(message);
  if (error && typeof error === 'object') {
    if (error.code) {
      normalized.code = error.code;
    }
    if (error.stack) {
      normalized.stack = error.stack;
    }
  }
  if (!normalized.code) {
    if (/EADDRINUSE|address already in use/i.test(message)) {
      normalized.code = 'EADDRINUSE';
    } else if (/EACCES|permission denied/i.test(message)) {
      normalized.code = 'EACCES';
    } else if (/ECONNREFUSED|connection refused/i.test(message)) {
      normalized.code = 'ECONNREFUSED';
    } else if (/ECONNRESET|connection reset/i.test(message)) {
      normalized.code = 'ECONNRESET';
    } else if (/ENOTFOUND|unable to resolve host|host not found|no such host/i.test(message)) {
      normalized.code = 'ENOTFOUND';
    } else if (/ETIMEDOUT|timed out|timeout/i.test(message)) {
      normalized.code = 'ETIMEDOUT';
    }
  }
  return normalized as Error;
}

/** 原生 socket 的 JS 视图，形状与 `react-native-tcp-socket` 的 socket 接近。 */
export class NativeSocket extends EventEmitter {
  readonly id: string;
  readonly isSSL: boolean;
  /** 底层 socket 上的额外字段（代理用）。 */
  readonly serverId: string;
  private closed = false;
  /**
   * CONNECT 期间暂时缓存原生 `data` 事件。
   *
   * 从 JS 决定把连接交给隧道，到原生层真正挂上桥接之间有一小段时间；期间
   * 到达的字节（通常就是 TLS ClientHello）如果直接 emit 给已 `hijack` 的
   * HTTP 服务端就会被丢掉。先缓存，`tunnel()` 时并入 `rest` 一起交给原生层。
   */
  private holdingData = false;
  private heldChunks: Buffer[] = [];
  /**
   * 待写出的字节队列。
   *
   * 原生桥是异步的：如果一次性把整个 ZIP 的 base64 丢过去，队列里会同时
   * 存在上百 MB 的字符串。这里按 64 KiB 切片、最多 4 片并发，只有原生
   * `writeAsync` 返回后才继续，内存峰值就是调用方持有的那一个 Buffer。
   */
  private writeQueue: Buffer[] = [];
  private writeHead = 0;
  private writeInFlight = 0;
  private writeFailed = false;
  private ending = false;

  constructor(id: string, isSSL: boolean, serverId = '') {
    super();
    this.id = id;
    this.isSSL = isSSL;
    this.serverId = serverId;
  }

  write(chunk: any): boolean {
    if (this.closed || this.writeFailed) {
      return false;
    }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '');
    if (!data.length) {
      return true;
    }
    // 单次跨桥写入必须分片：ZIP 注入时整包可能有几十上百 MB，base64 之后
    // 是一个更大的 JS 字符串，Android 的 bridge / Java 堆会直接 OOM，
    // 表现为写一半失败、客户端收到截断的 ZIP 后重新下载。
    //
    // 注意不能直接把 `subarray()` 的结果放进队列：在 RN 的 Buffer 实现里
    // `subarray()` 返回的是普通 `Uint8Array`，它的 `toString()` 不接受编码
    // 参数，会变成 "72,84,..." 这样的十进制字节串，原生层按 base64 解码后
    // 就得到完全错误的字节。这里包成零拷贝的 Buffer 视图再入队。
    for (let offset = 0; offset < data.length; offset += MAX_NATIVE_WRITE) {
      this.writeQueue.push(
        asBufferView(data.subarray(offset, offset + MAX_NATIVE_WRITE)),
      );
    }
    this.pumpWrites();
    return !this.closed && !this.writeFailed;
  }

  /** 尽量把队列里的分片交给原生层；原生完成一片后再补一片。 */
  private pumpWrites(): void {
    if (this.closed || this.writeFailed) {
      return;
    }
    let instance: NativeModule;
    try {
      instance = native();
    } catch (error) {
      this.writeFailed = true;
      this.fail(error);
      return;
    }
    const asyncWrite = (instance as any).writeAsync as
      | ((socketId: string, base64: string) => Promise<void>)
      | undefined;
    if (typeof asyncWrite !== 'function') {
      // 旧原生构建没有 writeAsync：退化为同步写入（仍然分片）。
      while (this.writeHead < this.writeQueue.length && !this.writeFailed) {
        const slice = this.writeQueue[this.writeHead++];
        try {
          instance.write(this.id, slice.toString('base64'));
        } catch (error) {
          this.writeFailed = true;
          this.fail(error);
        }
      }
      this.settleWrites();
      return;
    }
    while (
      this.writeInFlight < MAX_NATIVE_IN_FLIGHT &&
      this.writeHead < this.writeQueue.length
    ) {
      const slice = this.writeQueue[this.writeHead++];
      this.writeInFlight += 1;
      const settle = (error?: any) => {
        if (error) {
          this.writeFailed = true;
          this.writeInFlight -= 1;
          this.destroy(normalizeNativeError(error));
          return;
        }
        this.writeInFlight -= 1;
        this.pumpWrites();
      };
      try {
        Promise.resolve(asyncWrite.call(instance, this.id, slice.toString('base64')))
          .then(() => settle(), settle);
      } catch (error) {
        settle(error);
      }
    }
    this.settleWrites();
  }

  /** 队列排空后清理引用；如果调用过 `end()` 再真正半关闭。 */
  private settleWrites(): void {
    if (this.writeHead < this.writeQueue.length || this.writeInFlight > 0) {
      if (this.writeHead > 512 && this.writeHead * 2 > this.writeQueue.length) {
        this.writeQueue = this.writeQueue.slice(this.writeHead);
        this.writeHead = 0;
      }
      return;
    }
    this.writeQueue = [];
    this.writeHead = 0;
    if (this.ending && !this.closed) {
      this.ending = false;
      try {
        native().shutdown(this.id);
      } catch (error) {
        this.fail(error);
      }
    }
  }

  /**
   * 半关闭写方向：响应正文已经写完，等对端读到 EOF 后关闭。
   *
   * 不能直接 `close()`，否则大响应（ZIP）可能在原生发送队列排空前就被
   * RST 掉；也不能立刻 shutdown，队列里的分片还没发完。
   */
  end(): void {
    if (this.closed || this.ending) {
      return;
    }
    this.ending = true;
    this.pumpWrites();
  }

  /** 立即断开（TLS 握手失败、请求取消等）。 */
  destroy(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.writeQueue = [];
    this.writeHead = 0;
    this.ending = false;
    try {
      native().close(this.id);
    } catch {
      // 原生模块已卸载时忽略
    }
    if (error) {
      this.raise(error);
    }
  }

  setTimeout(milliseconds: number): void {
    if (this.closed) {
      return;
    }
    try {
      native().setTimeout(this.id, Number(milliseconds) || 0);
    } catch (error) {
      this.fail(error);
    }
  }

  setNoDelay(value: boolean): void {
    if (this.closed) {
      return;
    }
    try {
      native().setNoDelay(this.id, value !== false);
    } catch {
      // 无原生模块时忽略
    }
  }

  /**
   * CONNECT 隧道：把这条连接交给原生层，和本机 TLS 服务端（MITM）或目标
   * 主机（盲隧道）双向转发。
   */
  tunnel(options: NativeTunnelOptions): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('socket is closed'));
    }
    // 把决定隧道之前缓存的字节和 CONNECT 首部后的剩余字节拼在一起。
    const held = this.heldChunks;
    this.heldChunks = [];
    this.holdingData = false;
    const restParts: Buffer[] = [];
    if (options.rest) {
      restParts.push(
        Buffer.isBuffer(options.rest)
          ? options.rest
          : Buffer.from(String(options.rest), 'utf8'),
      );
    }
    restParts.push(...held);
    const rest = restParts.length
      ? Buffer.concat(restParts).toString('base64')
      : null;
    return native()
      .tunnel(this.id, options.host, options.port, rest, !!options.useTls)
      .catch(error => {
        throw normalizeNativeError(error);
      });
  }

  /** 暂停把 `data` 事件交给 HTTP 层，字节暂存在本地。 */
  holdData(): void {
    this.holdingData = true;
  }

  /**
   * 让原生层先暂停读循环。
   *
   * 必须在 `tunnel()` 之前调用：之后到达的字节由原生层排队，`tunnel()`
   * 挂上桥接时直接回放，不会因为 JS 事件队列的延迟而丢失。
   */
  suspend(): void {
    try {
      native().suspend(this.id);
    } catch {
      // 原生模块不可用时由 `tunnel()` 报告错误。
    }
  }

  /** 原生 `data` 事件入口：必要时先缓存。 */
  _receiveData(data: Buffer): void {
    if (this.holdingData) {
      this.heldChunks.push(data);
      return;
    }
    this.emit('data', data);
  }

  private fail(error: any): void {
    if (this.closed) {
      return;
    }
    this.raise(error);
  }

  /** 报告错误；调用方已经确认连接仍然有效（或正在销毁）。 */
  private raise(error: any): void {
    const normalized = normalizeNativeError(error);
    if (this.listenerCount('error') > 0) {
      this.emit('error', normalized);
    } else {
      console.warn('[Auto366Net] socket 错误:', normalized);
    }
  }

  /** 原生层关闭时由全局事件分发调用。 */
  _markClosed(): void {
    this.closed = true;
  }
}

/** 原生 TCP / TLS 服务端。 */
export class NativeServer extends EventEmitter {
  readonly id: string;
  private readonly options: NativeServerOptions;
  private readonly onConnection: (socket: NativeSocket) => void;
  private boundHost = '0.0.0.0';
  private boundPort = 0;
  private tlsPort = 0;
  private tlsAvailable = false;
  private closing = false;

  constructor(
    options: NativeServerOptions,
    onConnection: (socket: NativeSocket) => void,
  ) {
    super();
    this.id = createSocketId('server');
    this.options = options || {};
    this.onConnection = onConnection;
    servers.set(this.id, this);
  }

  /** 是否成功启动了 MITM 用的本机 TLS 服务端。 */
  get hasTls(): boolean {
    return this.tlsAvailable;
  }

  /** `HttpServer.listen()` 兼容入口。 */
  listen(port: number, host = '0.0.0.0'): Promise<void> {
    this.boundHost = host || this.options.host || '0.0.0.0';
    const requestedPort = Number(port) || this.options.port || 0;
    const tls = this.options.tls;
    let pending: Promise<NativeServerInfo>;
    try {
      pending = native().listen(
        this.id,
        this.boundHost,
        requestedPort,
        tls ? tls.resource : null,
        tls ? tls.password || null : null,
      );
    } catch (error) {
      servers.delete(this.id);
      return Promise.reject(normalizeNativeError(error));
    }
    return pending
      .then(info => {
        this.boundPort = info.port;
        this.tlsPort = info.tlsPort || 0;
        this.tlsAvailable = !!info.hasTls;
        this.emit('listening');
      })
      .catch(error => {
        servers.delete(this.id);
        throw normalizeNativeError(error);
      });
  }

  address(): {address: string; family: string; port: number} | null {
    if (!this.boundPort) {
      return null;
    }
    return {
      address: this.boundHost,
      family: this.boundHost.includes(':') ? 'IPv6' : 'IPv4',
      port: this.boundPort,
    };
  }

  close(): Promise<void> {
    if (this.closing) {
      return Promise.resolve();
    }
    this.closing = true;
    servers.delete(this.id);
    let pending: Promise<void>;
    try {
      pending = native().closeServer(this.id);
    } catch {
      return Promise.resolve().then(() => {
        this.emit('close');
      });
    }
    return pending
      .catch(() => undefined)
      .then(() => {
        this.emit('close');
      });
  }

  /** 原生 connection 事件入口。 */
  _handleConnection(socket: NativeSocket): void {
    this.onConnection(socket);
  }
}

const servers = new Map<string, NativeServer>();
const sockets = new Map<string, NativeSocket>();

let emitter: NativeEventEmitter | null = null;

function ensureEmitter(): NativeEventEmitter {
  if (emitter) {
    return emitter;
  }
  const instance = native();
  emitter = new NativeEventEmitter(instance as any);
  emitter.addListener(EVENT_CONNECTION, (event: any) => {
    const server = servers.get(event.serverId);
    if (!server) {
      try {
        instance.close(event.socketId);
      } catch {
        // 忽略
      }
      return;
    }
    const socket = new NativeSocket(
      event.socketId,
      !!event.isSSL,
      event.serverId,
    );
    sockets.set(socket.id, socket);
    try {
      server._handleConnection(socket);
    } finally {
      // 先让 JS 挂好 data/close/error 监听，再开始读取，避免首包丢失。
      instance.resume(event.socketId).catch(error => {
        socket.emit('error', normalizeNativeError(error));
      });
    }
  });
  emitter.addListener(EVENT_DATA, (event: any) => {
    const socket = sockets.get(event.socketId);
    if (!socket) {
      return;
    }
    const data = decodeBase64(event.data);
    if (data.length) {
      socket._receiveData(data);
    }
  });
  emitter.addListener(EVENT_CLOSE, (event: any) => {
    const socket = sockets.get(event.socketId);
    if (!socket) {
      return;
    }
    sockets.delete(event.socketId);
    socket._markClosed();
    socket.emit('close');
  });
  emitter.addListener(EVENT_TIMEOUT, (event: any) => {
    sockets.get(event.socketId)?.emit('timeout');
  });
  emitter.addListener(EVENT_ERROR, (event: any) => {
    const socket = event.socketId ? sockets.get(event.socketId) : undefined;
    const error = normalizeNativeError(event);
    if (socket) {
      if (socket.listenerCount('error') > 0) {
        socket.emit('error', error);
      } else {
        console.warn('[Auto366Net] socket 错误:', error);
      }
      return;
    }
    console.warn('[Auto366Net] 原生错误:', error);
  });
  emitter.addListener(EVENT_SERVER_ERROR, (event: any) => {
    const server = servers.get(event.serverId);
    const error = normalizeNativeError(event);
    if (server) {
      server.emit('error', error);
    } else {
      console.warn('[Auto366Net] 服务端错误:', error);
    }
  });
  return emitter;
}

/**
 * 创建原生服务端（形状兼容 `react-native-tcp-socket` 的 `createServer`）。
 *
 * `options.tls` 存在时，原生层会在同一次监听里额外启动 loopback TLS 服务端；
 * 代理收到的 CONNECT 通过 `socket.tunnel({useTls: true})` 接入。
 */
export function createNativeServer(
  options: NativeServerOptions,
  onConnection: (socket: NativeSocket) => void,
): NativeServer {
  ensureEmitter();
  return new NativeServer(options || {}, onConnection);
}

/** 建立普通 TCP 连接；回调在连接成功后才触发。 */
export function connectTcp(
  host: string,
  port: number,
  callback?: () => void,
  timeoutMs = 0,
): NativeSocket {
  ensureEmitter();
  const socketId = createSocketId('client');
  const socket = new NativeSocket(socketId, false);
  sockets.set(socketId, socket);
  native()
    .connect(socketId, host, Number(port) || 80, false, null, Number(timeoutMs) || 0)
    .then(() => {
      callback?.();
      return native().resume(socketId);
    })
    .catch(error => {
      if (socket.listenerCount('error') > 0) {
        socket.emit('error', normalizeNativeError(error));
      } else {
        console.warn('[Auto366Net] 连接失败:', error);
      }
      socket.destroy();
      // 原生层没有登记这条连接，不会发 close 事件；这里直接回收 JS 视图。
      sockets.delete(socketId);
    });
  return socket;
}

/** 建立 TLS 连接；回调在 TLS 握手完成后才触发。 */
export function connectTls(
  host: string,
  port: number,
  servername: string | undefined,
  callback?: () => void,
  timeoutMs = 0,
): NativeSocket {
  ensureEmitter();
  const socketId = createSocketId('client');
  const socket = new NativeSocket(socketId, true);
  sockets.set(socketId, socket);
  native()
    .connect(
      socketId,
      host,
      Number(port) || 443,
      true,
      servername || host,
      Number(timeoutMs) || 0,
    )
    .then(() => {
      callback?.();
      return native().resume(socketId);
    })
    .catch(error => {
      if (socket.listenerCount('error') > 0) {
        socket.emit('error', normalizeNativeError(error));
      } else {
        console.warn('[Auto366Net] TLS 连接失败:', error);
      }
      socket.destroy();
      // 原生层没有登记这条连接，不会发 close 事件；这里直接回收 JS 视图。
      sockets.delete(socketId);
    });
  return socket;
}

/** 供测试或诊断使用：当前打开的 socket / server 数量。 */
export function stats(): {servers: number; sockets: number} {
  return {servers: servers.size, sockets: sockets.size};
}
