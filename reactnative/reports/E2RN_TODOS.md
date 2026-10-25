# 迁移待办 / 已知限制

按优先级排列。每项都注明**触发条件**和**建议的移动端实现**。

## P0 — 影响核心功能

### 1. HTTPS 流量无法解密 → ✅ 已实现（2026-10，Android 真机验证）
- **现状**：`src/stubs/http-mitm-proxy.ts` 现在真的做 HTTPS 中间人，不再是盲隧道。
  - 代理启动时用 `react-native-tcp-socket` 的 `createTLSServer()` 在本机 loopback
    上另起一个 TLS 服务端；证书来自打进 APK 的
    `android/app/src/main/res/raw/auto366_mitm.p12`（`scripts/generate-mitm-cert.js`
    用 openssl 生成：CA + 叶子证书，SAN 覆盖 `*.up366.cn` / `*.up366.com` /
    `*.cyril.zone` 等，见脚本里的 `DNS_NAMES`）。
  - 收到 `CONNECT host:443` 后回 `200 Connection Established`，把这条连接的密文
    原样转发给本机 TLS 服务端；TLS 在 RN 侧终止后得到明文 HTTP，复用与明文代理
    **完全相同**的钩子链（`onRequest` / `onRequestData` / `onRequestEnd` /
    `onResponse` / `onResponseData` / `onResponseEnd`），只是 `ctx.isSSL = true`，
    `captureUrl` 拼成 `https://...`。
  - 上游请求由 `src/runtime/http/client.ts` 重新建立真正的 TLS 连接，因此规则
    匹配、抓包、正文改写看到的都是明文。
  - keystore 缺失 / TLS 服务端启动失败时**自动退回** CONNECT 盲隧道（只转发
    密文、不触发响应钩子），代理整体仍可用。
- **必要补丁**：`scripts/patch-tcp-socket.js`（`postinstall` 自动执行、幂等）。
  `react-native-tcp-socket` 原本把 PKCS#12 密码写死成空串，而 Android 的
  BouncyCastle **无法**打开空密码的 keystore（加密库报 `password empty`，未加密
  报 `OpenSSLRSAPrivateCrtKey cannot be cast to ...`）。补丁让 TLS options 可以
  携带密码，keystore 密码固定为 `auto366-mitm`
  （`src/mitm/ca-certificate.ts` 的 `MITM_KEYSTORE_PASSWORD`）。
- **客户端仍需信任根证书**：App 不能静默写系统信任库，`modules/proxy/cert.js`
  的替身 `src/shims/proxy-cert.ts` 改为把 CA 导出到
  `<documents>/.Auto366/Auto366-MITM-CA.pem` 并提示手动安装
  （设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书）。装好之前，被代理的
  HTTPS 客户端会报证书不受信任。
- **验证**：`node scripts/mitm-e2e-test.js`（先 `adb forward tcp:15291 tcp:5291`）
  走完整 CONNECT → TLS 握手（校验 `CN=Auto366 MITM` 由本地 CA 签发）→ 上游响应，
  输出 `PASS` 即通过。已实测 `fs.up366.cn`（404）、`study-api.up366.cn`（200）、
  `/api/v1/config`（302），以及同一代理下的明文 HTTP。
- **剩余限制**：只有一张叶子证书 + 固定 SAN 列表，拦截 SAN 之外的域名会证书不匹配
  （桌面版按域名动态签发）。需要时把域名加进 `scripts/generate-mitm-cert.js` 的
  `DNS_NAMES`，重跑 `npm run certs` 并重新打包。

### 2. `child_process` 不可用
- **现状**：`src/polyfills/node/child_process.ts` 为惰性 no-op。
- **影响功能**：
  - `modules/answers/learning.js`：答案学习用的 `fork` worker 失效；
  - `modules/acceleration/*`：进程级加速（openspeed / speed）失效；
  - TUN 模式启动脚本失效。
  - 证书导入不走这里：桌面版用 `child_process` 调 `certutil` / `security`，
    移动端由 `src/shims/proxy-cert.ts` 改成“导出 PEM + 提示手动安装”。
- **方案**：进程内 worker 改写为 JS 任务（`modules/answers/learning.js` 的解析逻辑可内联）；
  加速功能在移动端改为“应用内代理加速”或直接下线。

## P1 — 功能降级

### 3. 系统对话框
- `dialog.showSaveDialog` / `showOpenDialog` / `showErrorBox` 在 shim 中返回 `canceled: true`。
- **方案**：接入 `react-native-document-picker` / `react-native-share`；错误框用 RN `Alert`。

### 4. 应用内自动更新
- `electron-updater` stub 永远返回 `update-not-available`。
- **方案**：改用 `react-native-app-updater` 或直接跳转到应用市场（`Linking`）。

### 5. 统计上报（PostHog）
- `posthog-node` stub 只写日志，不发送。
- **方案**：改用 `posthog-react-native`，或在获得用户同意后由 RN 侧直接上报。

### 6. Supabase storage
- `@supabase/supabase-js` stub 只实现 storage 接口，未覆盖 realtime / auth。
- **方案**：若业务只用文件上传下载，当前实现够用；否则引入 `@supabase/supabase-js` 的 RN 版本。

### 7. 本地语音合成
- `sherpa-onnx-node` stub 抛错；已有 `chestnut` / `glm-tts` 通道可兜底。
- **方案**：确认产品可接受降级；否则引入 sherpa-onnx 的 Android/iOS 原生包。

### 8. 缩放因子 / 多显示器
- `screen.getPrimaryDisplay().scaleFactor` 固定为 2；
  桌面端的多屏与 `setAlwaysOnTop` 在移动端无意义。

## P2 — 体验与工程

### 9. 旧架构模块在新架构下的 interop
- `react-native-fs` 2.20.0 与 `react-native-tcp-socket` 6.4.3 仍是旧式 NativeModule，
  RN 0.88 只支持新架构，两者依赖 RN 的 **TurboModule interop 层**运行。
- **状态**：Android 真机已验证可用（文件读写、本地服务器、TLS 服务端均正常）。
  iOS 未验证；若出现问题，替换方案见 `NATIVE_MODULES_REPORT.md`
  （`react-native-blob-util` / 自研原生模块）。

### 10. 端口与网络接口
- 本地资源服务器**优先**监听固定端口 `17866`（`src/runtime/web/assetServer.ts` 的
  `PREFERRED_PORT`），只有该端口被占用时才回退到随机端口。
  固定端口是为了让页面 origin 稳定（`http://127.0.0.1:17866`），否则每次冷启动
  端口变化，WebView 的 `localStorage`（协议同意状态、设置等）会全部丢失。
- 部分系统省电策略会杀掉监听；**方案**：在 `AppState` 变为后台时暂停，恢复时重启
  并刷新 WebView URL。

### 11. WebView 缓存
- `react-native-webview` 的缓存策略与 Electron 不同，长会话可能出现旧资源。
- **方案**：加载时带版本查询参数；`assets.json` 已含内容哈希，可直接用作版本号。

### 12. 内存占用
- 页面按桌面宽度（1400 CSS px）布局，由 WebView 自己按屏幕宽度缩放
  （`<meta name="viewport">` + `scalesPageToFit`，见 `src/components/WindowManager/viewport.ts`），
  RN 侧**不再**用 `transform` 缩放。这样 WebView 的合成层是屏幕尺寸而不是
  1400×900 dp（3x 屏约 4200×2700 物理像素），闪屏与内存峰值都明显下降。
  低端机仍需评估长列表页面的 DOM 内存。

### 13. 后台运行
- 桌面端关闭最后一个窗口会退出；移动端切后台进程可能被系统回收。
- **方案**：`AppState` 监听 + 持久化会话状态，恢复后重建窗口。

### 14. Metro 缓存不感知 babel 配置
- Metro 的 transform 缓存 key 不包含 `babel.config.js` 与自定义 Babel 插件，
  改完必须 `--reset-cache`，否则会用到旧产物（本次升级中曾因此误判 `__dirname` 改写未生效）。

### 15. TypeScript 7 / ESLint 9+ 尚未跟进
- 当前 TypeScript 6.0.3（RN 0.88 模板锁定版本）、ESLint 8.57.1（RN eslint-config 支持 8/9）。
  npm 上的 TypeScript 7（tsgo）与 ESLint 10 尚未适配本工程。

### 16. 未完成的验证
- 真机（Android）已完成：
  - 页面加载、`app.whenReady()` 生命周期、内置规则集导入、Analytics、
    本地资源服务器、WebView↔RN 双向 IPC；
  - 启动闪屏（WebView 按屏幕尺寸布局 + viewport 缩放，横竖屏都不留黑边）；
  - 图标字体（`document.fonts` 中 `bootstrap-icons` 为 `loaded`）；
  - `localStorage` 持久化（固定端口 + `am force-stop` 后重启仍保留）；
  - HTTPS 中间人（`scripts/mitm-e2e-test.js`，CONNECT → TLS → 上游响应）。
- 仍待验证：规则命中并触发动作、答案上传/下载、杀进程后状态恢复、iOS 全流程。

### 17. 扩展规则市场请求被 CORS 拦截
- `renderer/pages/extensions/index.js` 直接 `fetch('https://366.cyril.qzz.io/api/rulesets')`。
- 该服务固定返回 `Access-Control-Allow-Origin: https://366.cyril.zone`，
  既不匹配桌面的 `file://`（`Origin: null`）也不匹配移动端的 `http://127.0.0.1:<port>`。
- **结论**：与桌面端行为一致（同源策略导致 `Failed to fetch`），不是迁移缺陷。
- **方案**（若要修复）：在本地资源服务器上加 `/__remote` 反向代理，
  用注入脚本改写 `fetch`/`XHR` 指向本地代理，由 RN 侧发起 HTTPS 请求。

### 18. 生成物未纳入版本控制
- `src/web-assets/assets.json` 与 `src/web-assets/files/**` 由
  `scripts/build-web-assets.js` 生成，`.gitignore` 已排除。
- 全新 clone 后若跳过 `npm run assets`，Metro 会报
  `Unable to resolve module ./assets.json`（`npm start` / `npm run android`
  的 `pre*` 钩子已自动生成，直接 `npx react-native run-android` 才会踩到）。

## 验收清单（真机可用后执行）

- [x] `npm run android` 启动，主页显示（Android 真机，2026-10）
- [x] 页面填满可用区域（按宽度缩放，无黑边），预留系统安全区域（横屏左右各约 20dp）
- [x] 启动闪屏不闪烁（WebView 按屏幕尺寸布局 + viewport 缩放）
- [x] `window.electronAPI` 可用，注入窗口正常打开
- [x] 内置规则集导入完成（5 个内置规则集）
- [x] 图标字体加载正常（`bootstrap-icons:loaded`）
- [x] 本地资源服务器 + WebView 页面加载正常（固定端口 `17866`）
- [x] `localStorage` 重启后保留（协议同意状态不再重复弹出）
- [x] 代理监听 + HTTPS 中间人（CONNECT → TLS 终止 → 上游响应，`scripts/mitm-e2e-test.js` PASS）
- [ ] IPC `invoke` 与 `send` 全链路（renderer 初始化已跑通，其余待验）
- [ ] 明文 HTTP / HTTPS 规则命中并触发动作（需要真实业务请求）
- [ ] 客户端安装根证书后，业务 App 内的 HTTPS 请求可被解密
- [ ] 答案上传/下载走通（Supabase storage）
- [ ] 杀进程后重启，状态可恢复
- [ ] iOS 全流程
