/**
 * base64 编解码（原生实现）。
 *
 * RNFS 只肯用 base64 字符串搬运二进制，所以 `fs` 的每次读写都要过一遍 base64。
 * 之前用的是 `buffer` 包里的 JS 实现，实测（PLY110 / Hermes）非常慢：
 *
 *   | 数据量 | JS 解码 | 原生解码 | JS 编码 | 原生编码 |
 *   |   1 MB |  413 ms |   11 ms |  127 ms |    3 ms |
 *   |   8 MB | 3288 ms |   91 ms |  960 ms |   24 ms |
 *
 * 读一个 30 MB 的课件包，光解码就十几秒 —— 比解压本身还贵。这里统一换成
 * `react-native-quick-base64`（simdutf），解码后直接把结果包成 Buffer，不再
 * 多一次拷贝。
 */
import {Buffer} from 'buffer';

interface Base64Codec {
  toByteArray(text: string): Uint8Array;
  fromByteArray(bytes: Uint8Array): string;
}

let codec: Base64Codec | null = null;

/** 首次用到时才去拿原生模块，避免启动阶段摸原生。 */
function native(): Base64Codec {
  if (codec) {
    return codec;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('react-native-quick-base64');
  const api = (mod?.default ?? mod) as Partial<Base64Codec> | undefined;
  if (!api || typeof api.toByteArray !== 'function' || typeof api.fromByteArray !== 'function') {
    throw new Error('[e2rn] react-native-quick-base64 未安装或未链接，base64 不可用');
  }
  codec = api as Base64Codec;
  return codec;
}

/**
 * 解码成 Buffer。
 *
 * 直接包住原生返回的内存（`Buffer.from(arrayBuffer, offset, length)` 不拷贝），
 * 8 MB 数据省掉一次 4 ms 级别的整块复制，也少占一份内存。
 */
export function decodeBase64(text: string): Buffer {
  if (!text) {
    return Buffer.alloc(0);
  }
  const bytes = native().toByteArray(text);
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/** 编码成 base64 字符串（空数据直接给空串，省一次原生调用）。 */
export function encodeBase64(data: Uint8Array | Buffer): string {
  if (!data || data.length === 0) {
    return '';
  }
  return native().fromByteArray(data as Uint8Array);
}
