/**
 * `zlib` polyfill 的契约。
 *
 * 设备上走 `react-native-nitro-zlib`（Rust 实现，含 brotli）；单测里通过
 * `__mocks__/nitro-zlib.ts` 换成 Node 自带的 zlib —— 同一个 Node API，语义和
 * 原生实现一致，所以这里验的就是真实行为。
 *
 * 重点锁住 `*RawSync` 与带 zlib 包装的那两个不能混：`modules/injection/zip.js`
 * 处理 ZIP 条目用的是裸 deflate。
 */
import zlib from '../src/polyfills/node/zlib';
import {Buffer} from 'buffer';

const SAMPLE = 'Auto366 压缩测试 payload '.repeat(8);

describe('zlib polyfill', () => {
  it('gzip 往返', () => {
    const packed = zlib.gzipSync(SAMPLE);
    expect(Buffer.isBuffer(packed)).toBe(true);
    expect(packed.length).toBeLessThan(Buffer.byteLength(SAMPLE));
    expect(zlib.gunzipSync(packed).toString('utf8')).toBe(SAMPLE);
  });

  it('deflate 往返（zlib 包装）', () => {
    const packed = zlib.deflateSync(SAMPLE);
    expect(zlib.inflateSync(packed).toString('utf8')).toBe(SAMPLE);
    // zlib 包装有 CMF/FLG 头（0x78），裸 deflate 没有
    expect(packed[0]).toBe(0x78);
  });

  it('裸 deflate 往返，且与 zlib 包装互不通用', () => {
    const raw = zlib.deflateRawSync(SAMPLE);
    expect(raw[0]).not.toBe(0x78);
    expect(zlib.inflateRawSync(raw).toString('utf8')).toBe(SAMPLE);
    // 把裸流当 zlib 流解必须失败，否则说明两个函数被混成了同一个实现
    expect(() => zlib.inflateSync(raw)).toThrow();
  });

  it('brotli 可用（之前 fflate 版本这里是抛错的）', () => {
    const packed = zlib.brotliCompressSync(SAMPLE);
    expect(zlib.brotliDecompressSync(packed).toString('utf8')).toBe(SAMPLE);
  });

  it('回调式 API 与同步版本结果一致', done => {
    zlib.gzip(SAMPLE, (error, packed) => {
      expect(error).toBeNull();
      expect(packed?.toString('base64')).toBe(zlib.gzipSync(SAMPLE).toString('base64'));
      done();
    });
  });
});
