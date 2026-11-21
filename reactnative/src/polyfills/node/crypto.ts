/**
 * Node `crypto` polyfill for React Native, backed by `react-native-quick-crypto`.
 *
 * 之前 MD5 / SHA-256 是纯 JS 实现：注入流程要给几十 MB 的 ZIP 算一次 md5，在
 * Hermes 上要一两秒，成了整条链路的瓶颈。现在交给原生（OpenSSL/NCrypto，经
 * Nitro 直连），同样的活儿是毫秒级；AES-128-CBC（u3enc 答案格式）也一并走原生。
 *
 * **填充语义保持不变**：`createCipheriv` 关掉自动填充，由调用方自己按 PKCS#7
 * 补齐（见 `modules/answers/crypto.js`）。桌面端 Node 默认开自动填充，两边产出的
 * 密文长度本来就不同；这次沿用移动端既有行为，不顺手改格式。
 */
import {Buffer} from 'buffer';

interface QuickCrypto {
  createHash(algorithm: string): any;
  createCipheriv(algorithm: string, key: any, iv: any): any;
  createDecipheriv(algorithm: string, key: any, iv: any): any;
  randomBytes(size: number): Buffer;
  randomUUID(): string;
}

let resolved: QuickCrypto | null = null;

/** 首次用到时才去拿原生模块，避免启动阶段就摸原生。 */
function backend(): QuickCrypto {
  if (resolved) {
    return resolved;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('react-native-quick-crypto');
  const api = (mod?.default ?? mod) as QuickCrypto | undefined;
  if (!api || typeof api.createHash !== 'function' || typeof api.createCipheriv !== 'function') {
    throw new Error('[e2rn] react-native-quick-crypto 未安装或未链接，crypto 不可用');
  }
  resolved = api;
  return resolved;
}

function toBuffer(data: string | Uint8Array | Buffer): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

export function createHash(algorithm: string): any {
  return backend().createHash(algorithm);
}

/** AES-CBC 加密器：不做自动填充，调用方自己补齐（与改造前一致）。 */
export function createCipheriv(algorithm: string, key: string | Uint8Array, iv: string | Uint8Array): any {
  const cipher = backend().createCipheriv(algorithm, toBuffer(key), toBuffer(iv));
  if (typeof cipher.setAutoPadding !== 'function') {
    throw new Error('[e2rn] crypto: 原生 createCipheriv 不支持 setAutoPadding，拒绝在语义不确定的情况下加密');
  }
  cipher.setAutoPadding(false);
  return cipher;
}

/** AES-CBC 解密器：与 Node 默认一致，自动去掉 PKCS#7 填充。 */
export function createDecipheriv(algorithm: string, key: string | Uint8Array, iv: string | Uint8Array): any {
  return backend().createDecipheriv(algorithm, toBuffer(key), toBuffer(iv));
}

export function randomBytes(size: number): Buffer {
  return backend().randomBytes(size);
}

export function randomUUID(): string {
  return backend().randomUUID();
}

/** 便捷方法：直接拿摘要（原来纯 JS 版本也导出这两个）。 */
export function md5(input: string | Uint8Array): Buffer {
  return Buffer.from(createHash('md5').update(toBuffer(input)).digest());
}

export function sha256(input: string | Uint8Array): Buffer {
  return Buffer.from(createHash('sha256').update(toBuffer(input)).digest());
}

export default {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  md5,
  sha256,
};
