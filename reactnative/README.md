# Auto366 — React Native 外壳

这是 Auto366 桌面应用（Electron）的 React Native 外壳：桌面端源码 **原样** 运行在
Android / iOS 上，平台差异由 polyfill 与 shim 吸收。

技术栈：React Native **0.88.0**（New Architecture）· React 19.3.1 · Metro 0.87.1 ·
CLI 20.2.0 · TypeScript 6.0.3。

## 快速开始

```bash
npm install          # 安装依赖（postinstall 会给 tcp-socket 打 keystore 密码补丁）
npm run assets       # 把 Web 资源内嵌进 src/web-assets/assets.json（生成物）
npm run certs        # 生成 HTTPS 中间人证书与 p12 keystore（需要 openssl，已有则跳过）
npm start            # 启动 Metro
npm run android      # 需要 Android SDK
npm run ios          # 需要 Xcode
```

## 校验命令

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # jest：fs 镜像 / HTTP 解析 / 视口缩放
```

HTTPS 中间人端到端验证（真机代理启动后）：

```bash
adb forward tcp:15291 tcp:5291
node scripts/mitm-e2e-test.js --host fs.up366.cn --path /
```

客户端要信任 `<documents>/.Auto366/Auto366-MITM-CA.pem`（应用内「安装证书」
只会导出并提示手动安装）。详见
[`reports/MIGRATION_GUIDE.md`](./reports/MIGRATION_GUIDE.md) §3.7。

> 改过 `babel.config.js` 或 `babel-plugin-e2rn-dirname.js` 后，必须清 Metro 缓存
> （`npx react-native start --reset-cache` 或删除 `%TEMP%\metro-cache`），
> 否则 Metro 会复用旧的 transform 结果。

## 它是怎么工作的

1. `App.tsx` 调用 `src/auto366-main/entry.ts` → `src/bootstrap/E2RNMainBootstrap.ts`；
2. bootstrap 安装 `process` 垫片、hydrate 文件系统镜像、启动本地 Web 资源服务器；
3. 之后 `require('<electronRoot>/main.js')` 加载**未经修改**的桌面端主进程；
4. 桌面端创建的每个 `BrowserWindow` 变成一个 `react-native-webview`；
5. 渲染进程通过注入的 preload 与主进程通信，行为与桌面端一致。

详细说明见 [`reports/MIGRATION_GUIDE.md`](./reports/MIGRATION_GUIDE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`reports/MIGRATION_GUIDE.md`](./reports/MIGRATION_GUIDE.md) | 架构、启动流程、运行时契约、ModuleMapper |
| [`reports/E2RN_COMPATIBILITY.md`](./reports/E2RN_COMPATIBILITY.md) | Node / Electron / npm 包逐项兼容性 |
| [`reports/E2RN_TODOS.md`](./reports/E2RN_TODOS.md) | 已知限制与后续方案 |
| [`reports/NATIVE_MODULES_REPORT.md`](./reports/NATIVE_MODULES_REPORT.md) | 原生模块与权限清单 |

## 目录速览

```
src/polyfills/node/    Node 内置模块 polyfill（fs/http/crypto/path/...）
src/shims/electron/    Electron API 替身（app/BrowserWindow/ipcMain/...）
src/runtime/           事件总线、窗口桥、HTTP 引擎、本地资源服务器
src/components/        RN 侧的窗口与 WebView 宿主
src/stubs/             桌面专属 npm 包的替身
src/bootstrap/         启动流程
src/web-assets/        内嵌 Web 资源
```
