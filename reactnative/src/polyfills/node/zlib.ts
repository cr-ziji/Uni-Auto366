/**
 * Node `zlib` polyfill for React Native.
 *
 * 全部工作交给 `react-native-nitro-zlib`：核心是 Rust 的 flate2 / brotli，经 Nitro
 * 直接桥到 C++。以前那版用纯 JS 的 fflate，几十 MB 的课件包要整包 inflate 一遍，
 * Hermes 上动辄几秒；原生实现则是毫秒级，而且**支持 brotli** —— 代理拿到
 * `Content-Encoding: br` 的响应终于能解开。
 *
 * 这里不再保留 JS 兜底：兜底会在原生模块没链上时悄悄变慢，而且性能只有零头。
 * 真缺了原生模块就直接报错，问题在第一次用到 zlib 时暴露。
 */

import {Buffer} from 'buffer';

/**
 * 方法集按 Node 语义：`deflateSync` / `inflateSync` 带 zlib 包装，
 * `*RawSync` 是裸 deflate（ZIP 条目用这个）。
 */
interface ZlibBackend {
  gzipSync(data: Uint8Array): Uint8Array;
  gunzipSync(data: Uint8Array): Uint8Array;
  deflateSync(data: Uint8Array): Uint8Array;
  inflateSync(data: Uint8Array): Uint8Array;
  deflateRawSync(data: Uint8Array): Uint8Array;
  inflateRawSync(data: Uint8Array): Uint8Array;
  brotliCompressSync(data: Uint8Array): Uint8Array;
  brotliDecompressSync(data: Uint8Array): Uint8Array;
}

let resolved: ZlibBackend | null = null;

/** 首次用到 zlib 时才去拿原生模块，避免在启动阶段摸原生。 */
function backend(): ZlibBackend {
  if (resolved) {
    return resolved;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nitro = require('react-native-nitro-zlib') as Partial<ZlibBackend> | undefined;
  if (!nitro || typeof nitro.gunzipSync !== 'function' || typeof nitro.brotliDecompressSync !== 'function') {
    throw new Error('[e2rn] react-native-nitro-zlib 未安装或未链接，zlib 不可用');
  }
  resolved = nitro as ZlibBackend;
  return resolved;
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

function toBuffer(result: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(result) ? result : Buffer.from(result);
}

export function gzipSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().gzipSync(toBytes(data)));
}

export function gunzipSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().gunzipSync(toBytes(data)));
}

export function deflateSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().deflateSync(toBytes(data)));
}

export function inflateSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().inflateSync(toBytes(data)));
}

export function deflateRawSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().deflateRawSync(toBytes(data)));
}

export function inflateRawSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().inflateRawSync(toBytes(data)));
}

/** ZIP 条目是裸 deflate；保留 `unzlibSync` 这个名字给调用方按 zlib 语义解。 */
export function unzlibSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().inflateSync(toBytes(data)));
}

export function brotliCompressSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().brotliCompressSync(toBytes(data)));
}

export function brotliDecompressSync(data: string | Uint8Array): Buffer {
  return toBuffer(backend().brotliDecompressSync(toBytes(data)));
}

/**
 * 回调式 API。原生包的 "async" 只是 `setTimeout` 包一层同步调用，并不在线程池
 * 里跑，所以这里直接在同步实现上套回调 —— 行为和开销都一致，也少一条分支。
 */
function asCallback(run: () => Buffer, callback: (error: Error | null, result?: Buffer) => void): void {
  try {
    callback(null, run());
  } catch (error) {
    callback(error as Error);
  }
}

export function gzip(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  asCallback(() => gzipSync(data), callback);
}

export function gunzip(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  asCallback(() => gunzipSync(data), callback);
}

export function deflate(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  asCallback(() => deflateSync(data), callback);
}

export function inflate(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  asCallback(() => inflateSync(data), callback);
}

export function brotliCompress(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  asCallback(() => brotliCompressSync(data), callback);
}

export function brotliDecompress(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  asCallback(() => brotliDecompressSync(data), callback);
}

/** The compression constants of Node (only the values that are used). */
export const constants = {
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  ZLIB_VERNUM: 0x4e30,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_PARAM_SIZE_HINT: 5,
};

export default {
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  unzlibSync,
  brotliCompressSync,
  brotliDecompressSync,
  gzip,
  gunzip,
  deflate,
  inflate,
  brotliCompress,
  brotliDecompress,
  constants,
};
