/**
 * 运行平台判断。
 *
 * 桌面版由 Electron 提供 `win32` / `darwin` / `linux`；移动端由 React Native
 * 外壳提供真实的 `android` / `ios`（见 `reactnative/src/polyfills/node/process.ts`）。
 * 桌面专属能力（窗口按钮、独立窗口、TUN 增强模式、进程加速）都依赖这里的结果
 * 来决定是否启用，避免在手机上启动必然失败的流程。
 */
const MOBILE_PLATFORMS = new Set(['android', 'ios']);

const platform = process.platform;
const isMobile = MOBILE_PLATFORMS.has(platform);
const isWindows = platform === 'win32';

/** 移动端没有独立窗口、进程和系统托盘，相关能力需要整体关闭。 */
function unsupported(feature) {
  return `${feature}仅支持桌面端（当前平台：${platform}）`;
}

module.exports = {
  platform,
  isMobile,
  isWindows,
  unsupported
};
