/**
 * Node `https` 兼容层（React Native）。
 *
 * TLS 由原生 `Auto366Net` 提供，使用系统信任库：
 *  - 客户端：原生 `SSLContext` / Network.framework 直接握手；
 *  - 服务端：原生层从 APK `res/raw` 或 iOS App bundle 读取 PKCS#12，
 *    证书不经过 JS，也不需要 `patch-tcp-socket`。
 *
 * HTTPS 中间人由 `modules/proxy` 使用的 `http-mitm-proxy` 替身完成：
 * CONNECT 在原生层终止 TLS，再以 `isSSL = true` 的普通 HTTP 连接回调给
 * polyfill，接口与桌面版一致。
 *
 * 接口与 `http` 完全一致，只是默认端口变成 443、并且默认走 TLS。
 */
import {
  Agent,
  createHttpModule,
  globalAgent,
  HttpModule,
  METHODS,
  NodeClientRequest,
  NodeRequestListener,
  NodeServer,
  STATUS_CODES,
} from './http';

export type {
  HeaderValue,
  NodeClientRequest,
  NodeClientResponse,
  NodeIncomingMessage,
  NodeRequestListener,
  NodeServer,
  NodeServerAddress,
  NodeServerResponse,
} from './http';

export interface HttpsServerOptions {
  /** 原生 PKCS#12 资源名（Android `res/raw` / iOS bundle 文件名，不带扩展名）。 */
  keystore?: string | {resource: string; password?: string};
  /** PKCS#12 密码（`keystore` 为字符串时使用）。 */
  password?: string;
  /** 与 `http.createServer` 的 `requestTimeout` / `keepAliveTimeout` 一致。 */
  requestTimeout?: number;
  keepAliveTimeout?: number;
}

const httpsModule: HttpModule = createHttpModule({
  defaultPort: 443,
  defaultProtocol: 'https:',
  tls: true,
});

/** 创建 HTTPS 服务端（需要原生 keystore 资源）。 */
export function createServer(
  options: HttpsServerOptions,
  handler?: NodeRequestListener,
): NodeServer;
export function createServer(handler?: NodeRequestListener): NodeServer;
export function createServer(
  optionsOrHandler?: any,
  maybeHandler?: NodeRequestListener,
): NodeServer {
  return httpsModule.createServer(optionsOrHandler, maybeHandler);
}

/** 发起 HTTPS 请求。 */
export function request(...args: any[]): NodeClientRequest {
  return httpsModule.request(...args);
}

/** 发起 HTTPS GET 请求。 */
export function get(...args: any[]): NodeClientRequest {
  return httpsModule.get(...args);
}

export {Agent, globalAgent, METHODS, STATUS_CODES};

export default {
  createServer,
  request,
  get,
  Agent,
  globalAgent,
  METHODS,
  STATUS_CODES,
};
