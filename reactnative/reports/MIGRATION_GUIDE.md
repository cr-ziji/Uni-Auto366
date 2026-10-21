# Auto366 迁移指南（Electron → React Native）

本文描述 `D:\program\Uni-Auto366`（Electron 桌面版）迁移到
`D:\program\Uni-Auto366\reactnative`（React Native 0.88.0 / Android + iOS）的实现方式与运行时契约。

## 0. 核心原则

迁移严格遵循 **E2RN（Electron to React Native）** 思想：

1. **原样复用**：桌面端 `main.js` 与 `modules/**` **一行不改**，由 Metro 直接打进 RN bundle。
   桌面端代码通过 `require()` 拿到的仍是它熟悉的那套 API。
2. **Polyfill 而非重写**：所有平台差异都由 `src/polyfills/node/*`（Node 内置模块）与
   `src/shims/electron/*`（Electron API）提供，**不存在** `src/modules/**` 这样的业务代码副本。
3. **显式暴露差异**：移动端做不到的能力（MITM 解密、TUN、进程级加速、证书导入、
   原生 TTS、应用内自动更新）不做静默降级，统一登记在 [`E2RN_TODOS.md`](./E2RN_TODOS.md)。

> 参考实现：`D:\program\e2rn-test\vscode-1.141.0\reactnative`（VS Code 1.141 的 E2RN 移植），
> 本目录的目录结构、ModuleMapper、reports 组织方式与其保持一致。

## 0.1 技术栈（2026-10 升级到最新稳定版）

| 组件 | 版本 |
| --- | --- |
| React Native | **0.88.0**（New Architecture only，Hermes） |
| React | 19.3.1 |
| Metro | 0.87.1（`@react-native/metro-config` 0.88.0） |
| CLI | `@react-native-community/cli` 20.2.0 |
| Babel | `@babel/core` 7.29.7 + `@react-native/babel-preset` 0.88.0 |
| TypeScript | 6.0.3（`@react-native/typescript-config` 0.88.0） |
| Jest | 29.7.0（`@react-native/jest-preset` 0.88.0） |
| ESLint / Prettier | 8.57.1 / 3.9.10 |
| 原生依赖 | `react-native-webview` 14.0.1、`react-native-fs` 2.20.0、`react-native-tcp-socket` 6.4.3、`react-native-url-polyfill` 4.0.0 |
| Android | Gradle 9.4.1、AGP（`com.android.tools.build:gradle`）、Kotlin 2.2.0、compileSdk 37、targetSdk 36、minSdk 24、NDK 27.1.12297006 |
| iOS | Swift `AppDelegate` + `SceneDelegate`（`RCTDefaultReactNativeFactoryDelegate`）、`RCTNewArchEnabled=true` |

升级带来的改动：

- `android/` 与 `ios/` 整体替换为 0.88 模板（包名/工程名统一改回 `com.auto366` / `Auto366`）；
  iOS 从 Objective-C `AppDelegate` 改为 **Swift + SceneDelegate**。
- `StatusBar.backgroundColor` 在 0.88 被移除（edge-to-edge）→ 已删除该属性。
- `StyleSheet.absoluteFillObject` 不再导出 → 改为显式 `position/top/left/right/bottom`。
- `@react-native/typescript-config` 只导出包根 → `extends` 改为 `"@react-native/typescript-config"`；
  TS 6 弃用 `baseUrl` → 删除未使用的 `paths` 并加 `ignoreDeprecations`。
- Jest preset 由 `react-native` 改为 `@react-native/jest-preset`（0.88 已移除 `react-native/jest-preset.js`）。
- 新增 `@types/node`（polyfill 代码依赖 `Buffer`/`stream`/`NodeJS` 等 Node 全局类型）。
- **New Architecture**：RN 0.88 只支持新架构；`react-native-fs` / `react-native-tcp-socket`
  仍是旧式 NativeModule，依赖 RN 的 **TurboModule interop 层**运行（未做真机验证，见 TODO）。

> ⚠️ **Metro 缓存陷阱**：Metro 的 transform 缓存 key **不包含** `babel.config.js` 与本目录的自定义
> Babel 插件。修改 `babel.config.js` / `babel-plugin-e2rn-dirname.js` 后必须
> `npx react-native start --reset-cache`（或删除 `%TEMP%\metro-cache`），否则旧产物会被复用。


## 1. 目录结构

```
reactnative/
├── App.tsx                     # RN 外壳：启动原 main.js + 渲染窗口管理器
├── index.js                    # AppRegistry 注册
├── babel.config.js             # ModuleMapper（electron 别名）+ 虚拟 __dirname 插件
├── metro.config.js             # watchFolders + Node 内置模块映射 + blockList
├── babel-plugin-e2rn-dirname.js# 把桌面端的 __dirname/__filename 改写成 /app/...
├── e2rn.config.json            # 迁移配置（入口、preload、渲染页）
├── scripts/build-web-assets.js # 把 Web 资源内嵌进 JS bundle
├── src/
│   ├── polyfills/node/         # Node 内置模块 polyfill
│   │   ├── fs.ts               #   fs / fs.promises / original-fs（内存镜像 + 同步 API）
│   │   ├── fs-extra.ts         #   fs-extra
│   │   ├── http.ts https.ts net.ts
│   │   ├── crypto.ts zlib.ts url.ts util.ts os.ts path.ts
│   │   ├── node-stream-zip.ts archiver.ts stream-promises.ts
│   │   ├── child_process.ts process.ts console.ts timers.ts uuid.ts
│   │   └── unsupported.ts
│   ├── shims/electron/         # Electron API 替身（app/BrowserWindow/ipcMain/...）
│   ├── runtime/                # 运行时
│   │   ├── EventBus.ts         #   进程内事件总线（ipcMain ⇄ ipcRenderer）
│   │   ├── WindowManagerBridge.ts #  WebView ⇄ RN 消息桥
│   │   ├── windowStore.ts windowState.ts webviewRegistry.ts
│   │   ├── preload.ts protocol.ts
│   │   ├── http/               #   HTTP/1.1 协议核心（parse/server/client）
│   │   └── web/assetServer.ts  #   本地 Web 资源服务器
│   ├── components/WindowManager/  # 窗口 → react-native-webview
│   ├── components/preloadBridge.ts # 注入页面的桥脚本
│   ├── bootstrap/E2RNMainBootstrap.ts # 启动流程
│   ├── auto366-main/entry.ts   # 入口
│   ├── stubs/                  # 桌面专属 npm 包的替身
│   │   ├── http-mitm-proxy.ts  #   代理核心的替身（真实实现）
│   │   ├── electron-updater.ts posthog-node.ts supabase.ts sherpa-onnx.ts
│   ├── web-assets/             # 内嵌 Web 资源（assets.json）+ 只读虚拟 FS
│   └── types/globals.d.ts
├── __tests__/                  # polyfill 单元测试
└── reports/                    # 本目录
```

## 2. 启动流程

`App.tsx` → `src/auto366-main/entry.ts` → `src/bootstrap/E2RNMainBootstrap.ts`：

| 顺序 | 动作 | 原因 |
| --- | --- | --- |
| 1 | `installProcessGlobals()` | RN 自带的 `process` 太简陋；桌面端要用 `process.cwd()`、`process.on('uncaughtException')`、`process.resourcesPath` |
| 2 | `installNodeGlobals()` | `Buffer` / `setImmediate` / `TextDecoder` 在 Node 是**全局变量**，桌面端不 require 直接用 |
| 3 | `await hydrateFileSystem()` | 桌面端大量使用**同步** fs API，必须先把可写沙盒镜像进内存 |
| 4 | `await startAssetServer()` | `BrowserWindow.loadFile()` 要把页面 URL 解析到本地资源服务器 |
| 5 | `markAppReady()` | 桌面端 `main.js` 卡在 `app.whenReady().then(...)`，RN 没有对应的生命周期事件，必须由 bootstrap 主动 resolve |
| 6 | `require('../../../main.js')` | **原样**加载桌面端主进程，之后的一切都是桌面端自己的逻辑 |

> ⚠️ 第 5 步曾遗漏，导致真机启动后**一片空白**：`app.whenReady()` 永远 pending，
> `main.js` 的 `whenReady` 回调（创建窗口、注册 IPC、启动代理）从不执行。
> `app.isReady()` 也必须是**方法**（桌面端写的是 `app.isReady()`），不能实现成 getter。

## 3. 运行时契约

### 3.1 虚拟根 `/app`

桌面端用 `__dirname` 拼绝对路径（`modules/register.js`、`modules/config/index.js`、
`modules/window/index.js`、`modules/injection/window/index.js`）。
`babel-plugin-e2rn-dirname.js` 在**打包期**把它们改写成虚拟路径：

```
<electronRoot>/modules/register.js   →  __dirname === '/app/modules'
<electronRoot>/main.js                →  __filename === '/app/main.js'
```

`/app` 同时是 Web 资源虚拟文件系统的根，也是 `app.getAppPath()` 的返回值，
因此 `modules/rules/loader.js` 读取 `<appPath>/rulesets` 时能命中内嵌的规则集。

> 实现细节：`babel-plugin-e2rn-dirname.js` 的 visitor 收到的是 Babel 的 **NodePath**
> （标识符在 `path.node` 上），替换必须用 `path.replaceWith()`；
> `PluginPass` 并没有 `replaceWith()` 方法。

### 3.2 路径映射

| 桌面端 | 移动端 |
| --- | --- |
| `os.homedir()` | RNFS `DocumentDirectoryPath` |
| `process.cwd()` | `<DocumentDir>/.Auto366`（`appDataDirectory`） |
| `app.getPath('userData')` | `appDataDirectory` |
| `app.getPath('temp')` | `<appData>/temp` |
| `app.getAppPath()` | `/app`（只读 bundle 根） |
| `process.resourcesPath` | `/app/resources`（打包后 Electron 的 resources 目录） |

### 3.3 文件系统（`fs` polyfill）

React Native 没有同步文件 API，而桌面端重度依赖同步调用（`writeFileSync` + `renameSync` 等）。
因此 polyfill 采用**内存镜像**方案：

- 进程级 `Map<string, Buffer>` 是可写沙盒的权威来源；
- 同步/异步写入**先更新镜像**，再异步落盘到 RNFS（按路径排队，保证顺序）；
- 读取顺序：镜像 → bundle 资源（`/app` 虚拟根或数据根下的相对路径）→ 抛 `ENOENT`；
- `/app/**` 的读取必须返回**原始字节**（`readAsset(path, 'buffer')`）；
  早期实现误传了 `'base64'`，导致 `readFileSync(..., 'utf-8')` 返回 base64 文本，
  `JSON.parse` 报 `Unexpected character: e`（规则集全部导入失败）；
- `hydrateFileSystem()` 在启动时把数据根下的既有文件读入镜像；
- `fs.promises`、`FileHandle`、`createReadStream/WriteStream`、`fs.constants` 均已实现。

`scripts/build-web-assets.js` 生成 manifest 时必须**保留目录层级**
（`resources/agreements/version.json` 不能塌缩成 `version.json`），
并且**不能排除 `.md`**：`resources/agreements/privacy.md` / `terms.md` 是协议正文。

### 3.4 IPC（可信来源）

桌面端 `modules/register.js` 会对 IPC 事件做**可信来源校验**
（要求 `event.senderFrame.url` 以 `file:` 开头且指向应用自身页面）。
shim 在合成事件时把 `event.senderFrame.url` 置为：

- 主窗口：`file:///app/index.html`
- 注入窗口：`file:///app/modules/injection/window/index.html`

因此**桌面端的校验逻辑原样通过**，无需修改原文件。

渲染进程侧的 `ipcRenderer` 通过 `window.ReactNativeWebView.postMessage` 与 RN 侧通信，
消息格式见 `src/runtime/protocol.ts`（通道 `__E2RN_BRIDGE__`，协议版本 1，调用超时 30s）。

### 3.5 preload 注入

`preload/index.js` + `preload/bridge.js` 以**字节一致**的方式内联在
`src/runtime/preload.ts` 中，外面套一层微型 CommonJS loader 与 `electron` 桩，
在页面脚本之前注入 WebView。页面里因此仍然存在 `window.electronAPI`。

### 3.6 窗口与缩放

桌面 UI 固定为 1400×900（专业模式）/ 875×1010（简洁模式）。
移动端以原尺寸渲染 WebView，再整体 `scale` 到可用空间并居中
（`src/components/WindowManager/viewport.ts`），保证布局与桌面端一致。

## 4. ModuleMapper

`metro.config.js` 中的 `builtins` 表把桌面端的裸 `require` 映射到 polyfill / stub：

| 桌面端模块 | 实现 | 说明 |
| --- | --- | --- |
| `fs` `fs/promises` `original-fs` | `src/polyfills/node/fs.ts` | 内存镜像 + 同步 API |
| `fs-extra` | `src/polyfills/node/fs-extra.ts` | 递归 copy/remove |
| `path` `os` `events` `buffer` `stream` `querystring` `assert` `string_decoder` | npm polyfill / 自研 | |
| `util` | `src/polyfills/node/util.ts` | **必须用自研实现**：npm `util@0.12` 没有 `formatWithOptions()`，桌面端日志模块会在 `catch` 里把每条日志降级成“无法序列化日志内容” |
| `url` `crypto` `zlib` `timers` `console` `process` | `src/polyfills/node/*` | `fileURLToPath`、AES-128-CBC、gzip |
| `http` `https` `net` | `src/polyfills/node/*` + `src/runtime/http/*` | 基于 `react-native-tcp-socket` |
| `child_process` | `src/polyfills/node/child_process.ts` | 惰性 no-op |
| `uuid` `node-stream-zip` `archiver` `stream/promises` | `src/polyfills/node/*` | fflate 实现 |
| `electron` `@e2rn/electron` | `src/shims/electron/index.ts` | 进程内替身 |
| `http-mitm-proxy` | `src/stubs/http-mitm-proxy.ts` | **真实实现**（明文全拦截 / HTTPS 隧道） |
| `electron-updater` | `src/stubs/electron-updater.ts` | 报告“无可用更新” |
| `posthog-node` | `src/stubs/posthog-node.ts` | 只记录不上报 |
| `@supabase/supabase-js` | `src/stubs/supabase.ts` | 只实现 storage 接口 |
| `sherpa-onnx-node` | `src/stubs/sherpa-onnx.ts` | 抛明确错误，降级到其它 TTS 引擎 |

桌面端的 `node_modules` 被 `blockList` 屏蔽（原生插件、electron-builder 等），
Babel 注入的 `@babel/runtime` 通过 `extraNodeModules` 显式映射。

## 5. 构建与验证

```bash
npm install
npm run assets          # 重新生成 src/web-assets/assets.json
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm test                # jest（polyfill 单元测试）
npm run android         # 需要 Android SDK
npm run ios             # 需要 Xcode
```

真机验证（Android，2026-10）：

```bash
# 1. 安装
npx react-native run-android
# 2. 抓 JS 日志（避免 logcat 噪声把启动日志挤掉）
adb logcat -v brief ReactNativeJS:V *:S
```

启动成功的日志序列：

```
[e2rn] web assets are served from http://127.0.0.1:<port>
[e2rn] the Auto366 main process has been started
[统计] [Analytics] 初始化成功, distinctId: <uuid>
[规则] 内置规则集导入完成
[界面] DOM 加载完成，开始初始化应用...
[界面] 应用初始化完成
```

Metro 打包自检：

```bash
npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/a.bundle
```

改过 `babel.config.js`、自定义 Babel 插件或 `metro.config.js` 后，先清缓存再打包/启动
（Metro 的 transform 缓存键**不包含** `babel.config.js`，不清缓存会继续用旧产物）：

```bash
npx react-native start --reset-cache     # 或删除 %TEMP%\metro-cache
```

## 6. 已知限制

见 [`E2RN_TODOS.md`](./E2RN_TODOS.md)；模块级兼容性见 [`E2RN_COMPATIBILITY.md`](./E2RN_COMPATIBILITY.md)；
原生模块清单见 [`NATIVE_MODULES_REPORT.md`](./NATIVE_MODULES_REPORT.md)。
