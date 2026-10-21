/**
 * Node `https` 兼容层（React Native）。
 *
 * TLS 由 `react-native-tcp-socket` 的原生实现提供，使用系统信任库：
 *  - 客户端：`TcpSocket.connectTLS({host, port, ca, key, cert})`；
 *  - 服务端：`TcpSocket.createTLSServer({keystore})`，`keystore` 必须是打包进
 *    assets 的原生 keystore 资源（RN 的 TLS 服务端只支持原生 keystore，
 *    不支持 PEM），没有它就无法启动 HTTPS 服务端。
 *
 * 桌面版把自签根证书装进系统证书库，从而能在中间人代理里解密 HTTPS。
 * 移动端没有这个能力（见 E2RN_TODOS.md），因此代理对 HTTPS 只能做 CONNECT 隧道。
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
  /** 原生 keystore 资源（`require('./keystore.json')` 之类）。 */
  keystore?: any;
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
