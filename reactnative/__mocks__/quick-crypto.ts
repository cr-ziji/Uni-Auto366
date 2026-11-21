/**
 * Jest 替身：`react-native-quick-crypto`。
 *
 * 原生模块在测试环境不存在，但 Node 自带 `crypto` 是同一套 API（quick-crypto
 * 本来就是照着 Node 的接口实现的），所以直接转发过去。
 */
import * as nodeCrypto from 'crypto';

export const createHash = nodeCrypto.createHash;
export const createCipheriv = nodeCrypto.createCipheriv;
export const createDecipheriv = nodeCrypto.createDecipheriv;
export const randomBytes = nodeCrypto.randomBytes;
export const randomUUID = nodeCrypto.randomUUID;

export default {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
};
