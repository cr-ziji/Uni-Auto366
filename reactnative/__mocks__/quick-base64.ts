/**
 * Jest 替身：`react-native-quick-base64`。
 *
 * 原生 codec 在测试环境没有，用 Node 的 Buffer 顶替 —— 输出逐字节一致，
 * 差别只是速度（测试里也不在乎）。
 */
import {Buffer} from 'buffer';

export function toByteArray(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

export function fromByteArray(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export default {toByteArray, fromByteArray};
