/**
 * Jest 替身：`react-native-nitro-unzip`。
 *
 * ZIP 解压/打包是原生实现，测试环境里没有。默认一律报错，免得测试悄悄"通过"
 * 却在设备上崩；需要验证接线（参数、清理、事件顺序）的用例自己用
 * `jest.mock('react-native-nitro-unzip', ...)` 换掉它。
 */
function unavailable(): never {
  throw new Error('[jest] react-native-nitro-unzip 在测试环境不可用，请在该用例里 mock 它');
}

export function getUnzip(): never {
  return unavailable();
}

export default {getUnzip};
