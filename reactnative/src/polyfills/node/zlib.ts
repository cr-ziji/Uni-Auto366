/**
 * Node `zlib` polyfill for React Native, backed by `fflate` (pure JS).
 *
 * `brotli` is intentionally not faked — the ported proxy reports the missing
 * capability instead of silently returning garbage (see E2RN_TODOS.md).
 */
import {
  gunzipSync as fflateGunzip,
  gzipSync as fflateGzip,
  inflateSync as fflateInflate,
  unzlibSync as fflateUnzlib,
  deflateSync as fflateDeflate,
} from 'fflate';
import {Buffer} from 'buffer';

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

export function gzipSync(data: string | Uint8Array): Buffer {
  return Buffer.from(fflateGzip(toBytes(data)));
}

export function gunzipSync(data: string | Uint8Array): Buffer {
  return Buffer.from(fflateGunzip(toBytes(data)));
}

export function deflateSync(data: string | Uint8Array): Buffer {
  return Buffer.from(fflateDeflate(toBytes(data)));
}

export function inflateSync(data: string | Uint8Array): Buffer {
  return Buffer.from(fflateInflate(toBytes(data)));
}

export function unzlibSync(data: string | Uint8Array): Buffer {
  return Buffer.from(fflateUnzlib(toBytes(data)));
}

export function gzip(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  try {
    callback(null, gzipSync(data));
  } catch (error) {
    callback(error as Error);
  }
}

export function gunzip(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  try {
    callback(null, gunzipSync(data));
  } catch (error) {
    callback(error as Error);
  }
}

export function deflate(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  try {
    callback(null, deflateSync(data));
  } catch (error) {
    callback(error as Error);
  }
}

export function inflate(data: string | Uint8Array, callback: (error: Error | null, result?: Buffer) => void): void {
  try {
    callback(null, inflateSync(data));
  } catch (error) {
    callback(error as Error);
  }
}

export function brotliCompressSync(): never {
  throw new Error('[e2rn] zlib.brotliCompressSync is not supported on React Native');
}

export function brotliDecompressSync(): never {
  throw new Error('[e2rn] zlib.brotliDecompressSync is not supported on React Native');
}

export function brotliCompress(): never {
  throw new Error('[e2rn] zlib.brotliCompress is not supported on React Native');
}

export function brotliDecompress(): never {
  throw new Error('[e2rn] zlib.brotliDecompress is not supported on React Native');
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
  unzlibSync,
  gzip,
  gunzip,
  deflate,
  inflate,
  brotliCompressSync,
  brotliDecompressSync,
  brotliCompress,
  brotliDecompress,
  constants,
};
