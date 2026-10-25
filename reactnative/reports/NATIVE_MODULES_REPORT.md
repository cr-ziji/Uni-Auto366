# 原生模块报告

迁移过程中引入 / 依赖的原生模块清单。

## 0. 技术栈基线

React Native **0.88.0**（New Architecture only，Hermes）· React 19.3.1 · Metro 0.87.1 ·
CLI 20.2.0 · Android Gradle 9.4.1 / Kotlin 2.2.0 / compileSdk 37 / minSdk 24 /
NDK 27.1.12297006 · iOS Swift AppDelegate + SceneDelegate（`RCTNewArchEnabled=true`）。

## 1. 已安装的 npm 原生模块

| 模块 | 版本 | 用途 | Android | iOS | 备注 |
| --- | --- | --- | --- | --- | --- |
| `react-native-fs` | 2.20.0 | 文件系统（fs polyfill 的落盘后端） | ✅ | ✅ | 真机已验证（Android）：镜像 hydrate、日志落盘、配置读写正常。旧式 NativeModule，靠新架构的 TurboModule interop 运行 |
| `react-native-tcp-socket` | 6.4.3 | TCP 服务端/客户端（HTTP 代理与资源服务器） | ✅ | ✅ | 真机已验证（Android）：本地资源服务器、代理监听、HTTPS 中间人的原生 TLS 服务端均正常。旧式模块 + interop；**必须**运行 `scripts/patch-tcp-socket.js`（`postinstall` 自动）才能加载带密码的 PKCS#12 keystore |
| `react-native-webview` | 14.0.1 | 承载桌面端渲染进程 | ✅ | ✅ | 真机已验证（Android）：页面加载、preload 注入、`postMessage` 双向通信正常；`injectedJavaScriptBeforeContentLoaded` 等 prop 在 14.x 均保留 |
| `react-native-url-polyfill` | 4.0.0 | `URL` / `URLSearchParams` | ✅ | ✅ | 4.x 的 API 与 2.x 一致（`/auto` 入口保留） |

其它纯 JS 依赖：`fflate` 0.8.3（zip/inflate）、`aes-js` 3.1.2（AES-128-CBC）、
`path-browserify` 1.0.1、`stream-browserify` 3.0.0、`buffer` 6.0.3、`events` 3.3.0、
`string_decoder` 1.3.0、`assert` 2.1.0、`querystring-es3` 0.2.1。
`util` **不再**使用 npm 包，改为 `src/polyfills/node/util.ts`（npm `util@0.12` 缺 `formatWithOptions`）。

> 新架构说明：RN 0.88 已移除旧架构。`react-native-fs` 与 `react-native-tcp-socket` 未提供
> TurboModule spec，依赖 RN 的 **旧模块 interop 层**工作 —— **Android 真机已验证可用**，
> iOS 尚未验证。若 iOS 出现问题，替换方案：
> `react-native-fs` → `react-native-blob-util` + 自建沙盒，`react-native-tcp-socket` → 自研 JSI/Swift 模块。

## 2. 桌面端原生能力的移动端处置

| 桌面端能力 | 依赖的原生能力 | 移动端处置 |
| --- | --- | --- |
| MITM 代理（自签 CA + HTTPS 解密） | Node `crypto` X509 + `child_process` 导入 CA | ✅ 已实现：openssl 预生成 CA/叶子证书，PKCS#12 打进 APK，`react-native-tcp-socket` 的 `createTLSServer` 终止 TLS，复用明文代理钩子链。客户端需手动安装导出的 CA |
| 进程级加速（openspeed / speed） | `child_process` 拉起外部程序 | ❌ 不可用，功能下线 |
| TUN 模式 | 外部 tun2socks 进程 + 路由表 | ❌ 不可用 |
| 系统代理设置 | 注册表 / `networksetup` | ⚠️ 移动端无法设置系统代理，改为应用内代理 |
| 证书安装 | `child_process` 调用系统命令 | ❌ 不可用 |
| 本地 TTS（sherpa-onnx） | onnxruntime 原生库 | ❌ 不可用，降级到在线 TTS |
| 自动更新 | electron-updater（下载 + 替换 .app/.exe） | ⚠️ 改为跳转应用市场 |
| 文件对话框 | Electron 原生对话框 | ⚠️ 需接 `react-native-document-picker` |
| 剪贴板 | Electron clipboard | ⚠️ 可用 RN `Clipboard` 补齐 |

## 3. Android 权限与配置

`android/app/src/main/AndroidManifest.xml` 已包含：

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

`<application>` 已设置 `android:usesCleartextTraffic="true"`（明文 HTTP 代理必需）。
模板默认用 `${usesCleartextTraffic}` 占位符，RN Gradle 插件在 **release 变体会置为 false**，
会直接关掉明文流量，因此这里改成硬编码 `true`。

`android/gradle.properties`：

| 开关 | 值 | 说明 |
| --- | --- | --- |
| `newArchEnabled` | `true` | RN 0.88 只支持新架构 |
| `hermesEnabled` | `true` | Hermes 引擎 |
| `edgeToEdgeEnabled` | `true` | 允许内容延伸到系统栏后方（`StatusBar.backgroundColor` 已随之移除） |
| `android.builtInKotlin` / `android.newDsl` | `false` | 规避 AGP 9 内置 Kotlin 行为 |

Gradle 依赖：`com.facebook.react:react-android`（RN 0.88.0）、
`com.facebook.fresco`、RNFS / tcp-socket / webview 自动链接。

## 4. iOS 配置

`ios/Auto366/Info.plist` 已包含：

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key><true/>
  <key>NSAllowsLocalNetworking</key><true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>用于启动本地代理服务与资源服务器</string>
```

`RCTNewArchEnabled=true`；App 入口改为 Swift：

- `ios/Auto366/AppDelegate.swift`（`@main`）
- `ios/Auto366/SceneDelegate.swift`（`RCTDefaultReactNativeFactoryDelegate`，
  通过 `RCTReactNativeFactory.startReactNative(withModuleName: "Auto366", ...)` 启动）

Podfile 中 `use_frameworks!` 已启用（可通过 `USE_FRAMEWORKS` 环境变量切换 linkage），
以兼容 `react-native-tcp-socket` 与 `react-native-webview` 的静态链接。

## 5. 未引入的原生模块（有意省略）

- `react-native-svg`、`react-native-reanimated` 等 UI 库：桌面端 UI 在 WebView 内，
  RN 侧只画一个全屏容器，不需要。
- `react-native-fs` 之外的存储库：与桌面端 `fs` 语义差异大，反而增加 polyfill 复杂度。
- VPN / TUN 类原生库：见 `E2RN_TODOS.md` 第 2 项（`child_process` / TUN 不可用），
  属于产品级决策。HTTPS 解密**不需要** VPN：用 `react-native-tcp-socket` 的原生
  TLS 服务端在本机终止 TLS 即可（见 `MIGRATION_GUIDE.md` §3.7）。
