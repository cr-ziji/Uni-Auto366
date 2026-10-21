# E2RN 兼容性报告

本表逐项列出桌面端（`D:\program\Uni-Auto366`）对 Node / Electron 能力的依赖，
以及移动端（`reactnative/`）的实现状态。

基线：React Native 0.88.0（New Architecture only）· React 19.3.1 · Metro 0.87.1。
`react-native-fs` / `react-native-tcp-socket` 为旧式 NativeModule，
在新架构下通过 TurboModule interop 运行（未真机验证）。

图例：✅ 完全等价 · ⚠️ 有降级或限制 · ❌ 不支持

## 1. Node 内置模块

| 模块 | 桌面端用法 | 移动端实现 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| `fs` | 同步读写为主（`readFileSync` / `writeFileSync` / `renameSync` / `existsSync` / `mkdirSync` / `readdirSync` / `statSync` / `copyFileSync` / `unlinkSync` / `rmSync` / `mkdtempSync` / `openSync`+`readSync`+`writeSync` / `createReadStream` / `createWriteStream`） | `src/polyfills/node/fs.ts`：内存镜像 + RNFS 落盘 | ✅ | 同步语义通过内存镜像实现；镜像外的同步读抛 `ENOENT` |
| `fs/promises` | `appendFile` `lstat` `mkdir` `mkdtemp` `open` `opendir` `readdir` `rm` `stat` | 同上（`fs.promises`） | ✅ | |
| `fs-extra` | `ensureDir(Sync)` `outputJsonSync` `readJsonSync` `pathExists` `remove(Sync)` `copy(Sync)` `copyFile(Sync)` | `src/polyfills/node/fs-extra.ts` | ✅ | `copy`/`remove` 支持目录递归 |
| `path` | `join` `resolve` `dirname` `basename` `extname` `relative` `isAbsolute` | `path-browserify` | ✅ | POSIX 语义 |
| `os` | `homedir()` `tmpdir()` `platform()` `cpus()` `totalmem()` | `src/polyfills/node/os.ts` | ✅ | `homedir()` → Documents 目录 |
| `crypto` | `createHash('md5')` `randomBytes` `randomUUID` `createCipheriv/createDecipheriv('aes-128-cbc')` | `src/polyfills/node/crypto.ts`（md5/sha256 + aes-js） | ⚠️ | 仅实现 md5/sha256/AES-128-CBC；随机数非密码学安全（RN 无原生 crypto） |
| `zlib` | `gzip` `gunzip` `inflate` `brotliDecompress` | `src/polyfills/node/zlib.ts`（fflate） | ⚠️ | brotli 不支持，抛明确错误 |
| `url` | `parse` `fileURLToPath` `URL` | `src/polyfills/node/url.ts` | ✅ | `file:///app/index.html` → `/app/index.html` |
| `util` | `format` `formatWithOptions` `inspect` `promisify` `callbackify` `types` `TextDecoder` | `src/polyfills/node/util.ts` | ✅ | 覆盖 npm `util@0.12` 的全部成员（含 `debuglog`/`_extend`），并补上 `formatWithOptions`、`TextDecoder/TextEncoder`；`inspect` 为简化实现 |
| Node 全局对象 | `Buffer` `setImmediate` `TextDecoder` `global` | `src/polyfills/node/globals.ts`（`installNodeGlobals()`） | ✅ | 桌面端不 `require` 直接用，必须在加载 `main.js` 前装到 `globalThis` |
| `stream` / `stream/promises` | `pipeline` | `stream-browserify` + `src/polyfills/node/stream-promises.ts` | ✅ | |
| `string_decoder` | `StringDecoder` | npm `string_decoder` | ✅ | |
| `http` / `https` | `createServer` `request` `get`，绝对形式请求、`for await (const chunk of req)`、`res.writeHead/write/end` | `src/polyfills/node/http.ts` + `src/runtime/http/*`（react-native-tcp-socket） | ⚠️ | 无 keep-alive 复用（`Connection: close`）；HTTPS 走 TLS 直连 |
| `net` | 未直接使用 | `src/polyfills/node/net.ts` | ⚠️ | 仅保留占位 API |
| `child_process` | `fork`（TTS worker、答案学习）、`exec`/`spawn`（加速、证书导入、TUN） | `src/polyfills/node/child_process.ts`（惰性） | ❌ | 无法派生进程；相关功能已在 TODO 中登记 |
| `process` | `cwd()` `on('uncaughtException'/'unhandledRejection')` `env` `platform` | `src/polyfills/node/process.ts` + `installProcessGlobals()` | ✅ | `cwd()` → 数据根 |
| `uuid` | `v4()` | `src/polyfills/node/uuid.ts` | ✅ | |
| `node-stream-zip` | 事件式 `new StreamZip({file, storeEntries:true})`；异步式 `new StreamZip.async({file})` | `src/polyfills/node/node-stream-zip.ts`（fflate） | ⚠️ | 同步式 `entries()` 返回数组、异步式返回按名索引对象（与桌面一致）；条目名自行消毒 |
| `archiver` | `archiver('zip', {zlib:{level:9}})` `.directory()` `.append()` `.finalize()` | `src/polyfills/node/archiver.ts`（fflate） | ⚠️ | 不支持流式增量压缩，一次性打包 |

## 2. Electron API

| API | 桌面端用法 | 移动端实现 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| `app` | `whenReady` `isReady` `getPath` `getAppPath` `getVersion` `on('before-quit'/'activate'/'window-all-closed')` `quit` `relaunch` | `src/shims/electron/app.ts` | ✅ | `whenReady()` 由 bootstrap 的 `markAppReady()` resolve；`getAppPath()` → `/app` |
| `BrowserWindow` | `loadFile` `show` `hide` `close` `setMenu(null)` `setSize` `setAlwaysOnTop` `webContents.send` `isDestroyed` | `src/shims/electron/browserWindow.ts` + `src/components/WindowManager` | ✅ | 由 `react-native-webview` 承载渲染进程 |
| `webContents` | `send` `on('did-finish-load')` | `src/shims/electron/webContents.ts` | ✅ | |
| `ipcMain` | `handle` `on`（全部经过 `modules/register.js` 的可信来源包装） | `src/shims/electron/ipcMain.ts` + `EventBus` | ✅ | `event.senderFrame.url` 合成自 `/app/...` |
| `ipcRenderer` | `invoke` `send` `on` `removeListener` | `src/shims/electron/ipcRenderer.ts` + `WindowManagerBridge` | ✅ | 经 WebView 消息桥 |
| `contextBridge` | `exposeInMainWorld('electronAPI', {...})` | `src/shims/electron/contextBridge.ts` + 注入脚本 | ✅ | preload 源码字节一致 |
| `dialog` | `showErrorBox` `showSaveDialog` `showOpenDialog` | `src/shims/electron/dialog.ts` | ⚠️ | 一律返回 `canceled: true`，没有系统文件选择器 |
| `shell` | `openExternal` | `src/shims/electron/shell.ts` | ✅ | 走 RN `Linking` |
| `screen` | `getPrimaryDisplay().scaleFactor` | `src/shims/electron/screen.ts` | ⚠️ | 固定 `scaleFactor = 2` |
| `nativeTheme` / `Menu` / `Tray` / `Notification` / `clipboard` / `powerMonitor` / `globalShortcut` / `protocol` / `session` / `systemPreferences` / `autoUpdater` | 少量使用 | `src/shims/electron/misc.ts` | ⚠️ | 均为安全 no-op |

## 3. 桌面专属 npm 包

| 包 | 桌面端用途 | 移动端实现 | 状态 |
| --- | --- | --- | --- |
| `http-mitm-proxy` | 代理核心：明文全量拦截 + HTTPS MITM | `src/stubs/http-mitm-proxy.ts` | ⚠️ 明文 ✅；HTTPS 改为 CONNECT 盲隧道（不解密） |
| `electron-updater` | GitHub Release 自动更新 | `src/stubs/electron-updater.ts` | ⚠️ 始终报告“无可用更新” |
| `posthog-node` | 使用统计上报 | `src/stubs/posthog-node.ts` | ⚠️ 仅记录日志，不上报 |
| `@supabase/supabase-js` | 答案文件上传分享 | `src/stubs/supabase.ts` | ⚠️ 仅实现 storage 接口（上传/下载/公开 URL） |
| `sherpa-onnx-node` | 本地语音合成 | `src/stubs/sherpa-onnx.ts` | ❌ 抛错，降级到 chestnut / glm-tts |

## 4. 桌面源码的裸 `require` 全量核对

对 `main.js`、`modules/**`、`preload/**` 做了静态扫描，全部裸 `require` 均已被
ModuleMapper 覆盖（`electron`、`fs`、`fs-extra`、`fs/promises`、`path`、`os`、`crypto`、
`http`、`https`、`zlib`、`util`、`stream`、`stream/promises`、`string_decoder`、`url`、
`uuid`、`node-stream-zip`、`archiver`、`child_process`、`http-mitm-proxy`、
`electron-updater`、`posthog-node`、`@supabase/supabase-js`、`sherpa-onnx-node`）。

## 5. Web UI

- 资源在打包期由 `scripts/build-web-assets.js` 内嵌为 `src/web-assets/assets.json`（92 个文件 / 2.07 MB）。
- 运行时由 `src/runtime/web/assetServer.ts` 在 `127.0.0.1` 的临时端口上提供，
  WebView 从该地址加载，页面里的相对路径与 `fetch()` 行为与桌面端一致。
- 渲染进程通过 `window.electronAPI` 与主进程通信，桥协议见 `src/runtime/protocol.ts`。
