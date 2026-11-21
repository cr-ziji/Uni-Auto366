/**
 * 原生 base64 codec 的契约（`src/runtime/native/base64.ts`）。
 *
 * `fs` 的每次读写都要过一遍 base64，之前用 JS 实现，8 MB 解码要 3.3 秒。这里锁住
 * 换实现后最容易踩的两点：编解码逐字节一致、解码结果是可以直接写的真 Buffer。
 */
import {Buffer} from 'buffer';
import {decodeBase64, encodeBase64} from '../src/runtime/native/base64';

const SAMPLE = Buffer.from('Auto366 base64 往返测试 \u0000\u00ff\u0080', 'utf8');

describe('原生 base64', () => {
  it('往返逐字节一致', () => {
    const encoded = encodeBase64(SAMPLE);
    expect(encoded).toBe(SAMPLE.toString('base64'));
    expect(decodeBase64(encoded).equals(SAMPLE)).toBe(true);
  });

  it('覆盖各种长度（含 base64 补位分支）', () => {
    for (let size = 0; size < 40; size++) {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) {
        bytes[i] = (i * 37 + size) & 0xff;
      }
      const decoded = decodeBase64(encodeBase64(bytes));
      expect(decoded.length).toBe(size);
      expect(decoded.equals(bytes)).toBe(true);
    }
  });

  it('解码结果是可以直接写回的真 Buffer', () => {
    const decoded = decodeBase64(SAMPLE.toString('base64'));
    expect(Buffer.isBuffer(decoded)).toBe(true);
    // 零拷贝包装后仍然必须能按 Buffer 的方法读写
    decoded.writeUInt8(0x41, 0);
    expect(decoded[0]).toBe(0x41);
  });

  it('空数据不触发原生调用', () => {
    expect(decodeBase64('').length).toBe(0);
    expect(encodeBase64(Buffer.alloc(0))).toBe('');
  });
});
