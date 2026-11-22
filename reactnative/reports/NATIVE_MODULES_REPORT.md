# 原生模块报告

迁移过程中引入 / 依赖的原生模块清单。

## 0. 技术栈基线

React Native **0.88.0**（New Architecture only，Hermes）· React 19.3.1 · Metro 0.87.1 ·
CLI 20.2.0 · Android Gradle 9.4.1 / Kotlin 2.2.0 / compileSdk 37 / minSdk 26
NDK 27.1.12297006 · iOS Swift AppDelegate + SceneDelegate（`RCTNewArchEnabled=true`）。

## 1. 已安装的 npm 原生模块

| 模块 | 版本 | 用途 | Android | iOS | 备注 |
| --- | --- | --- | --- | --- | --- |
| `Auto366Net`（自研） | — | TCP 服务端/客户端、TLS、CONNECT 隧道、MITM | ✅ | ✅（模拟器编译） | Android Kotlin `ServerSocket` / `SSLContext` + iOS Network.framework。新架构兼容，证书直接从 `res/raw` / App bundle 读取，无需任何补丁。Android 已通过 40 MiB 定长/chunked、Range、HTTPS 20 MiB 传输验证；iOS 已编译通过，端到端待验 |
| `Auto366Files`（自研） | — | 文件选择 / 保存 / 打开 / 分享 / 同步读 | ✅ | ✅（模拟器编译） | Android `SAF` + `FileProvider`，iOS `UIDocumentPicker` + `UIDocumentInteractionController`。同一套 JS 协议（`src/runtime/native/files.ts`）：`pickFiles` / `pickSaveTarget` / `writeToUri` / `saveToDownloads` / `openFile` / `shareFile` / `readFileBase64Sync`。iOS 用「文件夹选择器」实现保存目标，字节由 `writeToUri` 后置写入 |
| `react-native-fs` | 2.20.0 | 文件系统（fs polyfill 的落盘后端） | ✅ | ✅ | 真机已验证（Android）：镜像 hydrate、日志落盘、配置读写正常。旧式 NativeModule，靠新架构的 TurboModule interop 运行 |
| `react-native-webview` | 14.0.1 | 承载桌面端渲染进程 | ✅ | ✅ | 真机已验证（Android）：页面加载、preload 注入、`postMessage` 双向通信正常；`injectedJavaScriptBeforeContentLoaded` 等 prop 在 14.x 均保留 |
| `react-native-url-polyfill` | 4.0.0 | `URL` / `URLSearchParams` | ✅ | ✅ | 4.x 的 API 与 2.x 一致（`/auto` 入口保留） |
| `react-native-nitro-modules` | 0.37.2 | Nitro 运行时（quick-crypto / unzip / zlib 的底座） | ✅ | ✅（模拟器已验证启动） | **必须 ≥ 0.37**：RN 0.88 的 `RCTTurboModuleWithJSIBindings` 只认 `installJSIBindingsWithRuntime:callInvoker:`，0.35.x 只有单参数版本，RN 的 `respondsToSelector` 判定失败 → JS 报 `Failed to install Nitro: ... was not called` |
| `react-native-nitro-unzip` | 0.6.0 | 原生解压（`node-stream-zip` 后端） | ✅ | ✅ | 0.6.0 才依赖 `SSZipArchive ~> 2.6`；0.5.0 要求 2.5 的 API，与 lock 里解析到的 2.6.0 冲突，iOS 编不过 |
| `react-native-nitro-zlib` | 0.3.1 | 原生 gzip/deflate | ✅ | ✅ | peer 声明仍是 `^0.35`，但与 0.37.2 一起编译链接通过（Nitro 为静态库，无动态 ABI） |

其它纯 JS 依赖：`fflate` 0.8.3（zip/inflate）、`aes-js` 3.1.2（AES-128-CBC）、
`path-browserify` 1.0.1、`stream-browserify` 3.0.0、`buffer` 6.0.3、`events` 3.3.0、
`string_decoder` 1.3.0、`assert` 2.1.0、`querystring-es3` 0.2.1。
`util` **不再**使用 npm 包，改为 `src/polyfills/node/util.ts`（npm `util@0.12` 缺 `formatWithOptions`）。

> 新架构说明：RN 0.88 已移除旧架构。网络层使用自研的 `Auto366Net`
> （Kotlin / Swift 原生模块），不再需要 `react-native-tcp-socket` 或它的 keystore
> 补丁。

> **Nitro 版本坑（已踩过）**：iOS 上 `Failed to install Nitro:
> installJSIBindingsWithRuntime: was not called - JSI Bindings could not be installed!`
> 不是证书 / 新架构开关的问题，而是 `react-native-nitro-modules` 太旧 —— RN 0.88 在
> `RCTTurboModuleManager` 里只对实现了 `installJSIBindingsWithRuntime:callInvoker:`
> 的模块安装 JSI bindings，0.35.x 只有单参数版本，于是该方法永远不会被调用。
> 升级到 0.37.x 即可；同时 `react-native-nitro-unzip` 必须升到 0.6.0（它的 0.5.0
> 依赖 SSZipArchive 2.5 的 API，而 lock 文件解析到 2.6.0，iOS 编译直接失败）。

## 2. 桌面端原生能力的移动端处置

| 桌面端能力 | 依赖的原生能力 | 移动端处置 |
| --- | --- | --- |
| MITM 代理（自签 CA + HTTPS 解密） | Node `crypto` X509 + `child_process` 导入 CA | ✅ 已实现：openssl 预生成 CA/叶子证书，PKCS#12 同时打进 APK 和 iOS App bundle；原生 `Auto366Net` 用 `SSLContext` / Network.framework 终止 TLS，JS 只处理解密后的 HTTP 并复用明文代理钩子链。客户端需手动安装导出的 CA |
| 进程级加速（openspeed / speed） | `child_process` 拉起外部程序 | ❌ 不可用，功能下线 |
| TUN 模式 | 外部 tun2socks 进程 + 路由表 | ❌ 不可用 |
| 系统代理设置 | 注册表 / `networksetup` | ⚠️ 移动端无法设置系统代理，改为应用内代理 |
| 证书安装 | `child_process` 调用系统命令 | ❌ 不可用 |
| 本地 TTS（sherpa-onnx） | onnxruntime 原生库 | ❌ 不可用，降级到在线 TTS |
| 自动更新 | electron-updater（下载 + 替换 .app/.exe） | ⚠️ 改为跳转应用市场 |
| 文件对话框 | Electron 原生对话框 | ✅ 已实现（自研 `Auto366Files`）：打开走系统文档选择器（选中的文件复制进缓存，返回沙盒路径）；保存走 Android `ACTION_CREATE_DOCUMENT` / iOS 文件夹选择器，`fs` 落盘后由 `writeToUri` 写入用户选定位置；打开/分享走 `FileProvider` / `UIDocumentInteractionController` |
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
`com.facebook.fresco`、RNFS / webview 自动链接；自研原生模块由
`android/app/src/main/java/com/auto366/mobile/` 提供（`net/Auto366NetModule.kt`
传输层、`files/Auto366FilesModule.kt` 文件对话框），通过 `MainApplication.kt`
手动注册 `Auto366NetPackage` / `Auto366FilesPackage`。文件分享依赖
`AndroidManifest.xml` 里的 `androidx.core.content.FileProvider`
（authority `${applicationId}.fileprovider`）与 `res/xml/file_paths.xml`。

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
<!-- 导出的文件落在 <Documents>/Downloads/Auto366，让它在「文件」App 里可见 -->
<key>UIFileSharingEnabled</key><true/>
<key>LSSupportsOpeningDocumentsInPlace</key><true/>
```

`RCTNewArchEnabled=true`；App 入口改为 Swift：

- `ios/Auto366/AppDelegate.swift`（`@main`）
- `ios/Auto366/SceneDelegate.swift`（`RCTDefaultReactNativeFactoryDelegate`，
  通过 `RCTReactNativeFactory.startReactNative(withModuleName: "Auto366", ...)` 启动）

Podfile 默认使用静态库（`use_frameworks!` 仅在设置 `USE_FRAMEWORKS` 环境变量时启用），
兼容 `react-native-webview`。两个 Swift 模块都通过 `RCT_EXTERN_MODULE` 注册：

| Swift | 桥接文件 | 说明 |
| --- | --- | --- |
| `Auto366Net.swift` | `Auto366NetBridge.m` | Network.framework TCP/TLS + CONNECT 隧道 |
| `Auto366Files.swift` | `Auto366FilesBridge.m` | `UIDocumentPicker` 选择/保存、`UIDocumentInteractionController` 打开/分享、`RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD` 同步读 |

`project.pbxproj` 里已设置
`SWIFT_OBJC_BRIDGING_HEADER = "Auto366/Auto366-Bridging-Header.h"`（引入了
`RCTBridgeModule.h` / `RCTEventEmitter.h` / `RCTUtils.h`，最后一个用于
`RCTPresentedViewController()` 取最上层控制器），并把 `auto366_mitm.p12`
加入 Copy Bundle Resources。

## 5. 未引入的原生模块（有意省略）

- `react-native-svg`、`react-native-reanimated` 等 UI 库：桌面端 UI 在 WebView 内，
  RN 侧只画一个全屏容器，不需要。
- `react-native-fs` 之外的存储库：与桌面端 `fs` 语义差异大，反而增加 polyfill 复杂度。
- VPN / TUN 类原生库：见 `E2RN_TODOS.md` 第 2 项（`child_process` / TUN 不可用），
  属于产品级决策。HTTPS 解密**不需要** VPN：`Auto366Net` 在本机终止 TLS 即可
  （见 `MIGRATION_GUIDE.md` §3.7）。
