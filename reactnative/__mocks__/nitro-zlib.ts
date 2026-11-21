/**
 * Jest 替身：`react-native-nitro-zlib`。
 *
 * 测试环境没有原生库，但 Node 自带的 `zlib` 语义完全一致（同一个 Node API，
 * 连 brotli 都有），所以直接把调用转过去。这样单测跑的是真实压缩实现，
 * 不需要任何 JS 版的 zlib。
 */
import {Buffer} from 'buffer';
import nodeZlib from 'zlib';

const forward = (name: keyof typeof nodeZlib) => (data: any) =>
  Buffer.from((nodeZlib[name] as any)(Buffer.from(data)));

export const gzipSync = forward('gzipSync');
export const gunzipSync = forward('gunzipSync');
export const deflateSync = forward('deflateSync');
export const inflateSync = forward('inflateSync');
export const deflateRawSync = forward('deflateRawSync');
export const inflateRawSync = forward('inflateRawSync');
export const brotliCompressSync = forward('brotliCompressSync');
export const brotliDecompressSync = forward('brotliDecompressSync');

export default {
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  brotliCompressSync,
  brotliDecompressSync,
};
