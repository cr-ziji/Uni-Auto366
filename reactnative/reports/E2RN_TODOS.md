# 迁移待办 / 已知限制

按优先级排列。每项都注明**触发条件**和**建议的移动端实现**。

## P0 — 影响核心功能

### 1. HTTPS 流量无法解密（MITM 缺失）
- **现状**：桌面端 `http-mitm-proxy` 会安装自签 CA 并解密 HTTPS，模块
  `modules/proxy/handlers.js` 依赖 `onResponse` / `onResponseData` / `onResponseEnd`
  回调做规则匹配。移动端无 CA 导入能力（`child_process` 不可用），
  `src/stubs/http-mitm-proxy.ts` 改为 **CONNECT 盲隧道**：只转发密文，
  不触发上述回调。
- **影响**：仅 HTTPS 规则（订阅/游戏等）不生效；明文 HTTP 规则完全可用。
- **方案**：① 用户手动安装根证书（需系统级操作，成本高）；
  ② 改走 VPN 模式（`VpnService` / `NEVPNManager`）在系统层拦截，
  需原生开发，工作量最大但能力最完整；
  ③ 明确产品定位为“仅明文/应用内流量代理”。

### 2. `child_process` 不可用
- **现状**：`src/polyfills/node/child_process.ts` 为惰性 no-op。
- **影响功能**：
  - `modules/answers/learning.js`：答案学习用的 `fork` worker 失效；
  - `modules/acceleration/*`：进程级加速（openspeed / speed）失效；
  - 证书导入、TUN 模式启动脚本失效。
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

### 9. 旧架构模块在新架构下的 interop 风险
- `react-native-fs` 2.20.0 与 `react-native-tcp-socket` 6.4.3 仍是旧式 NativeModule，
  RN 0.88 只支持新架构，两者依赖 RN 的 **TurboModule interop 层**运行。
- **状态**：未在真机验证。若运行时报 `TurboModuleRegistry.getEnforcing(...) could not be found`，
  替换方案见 `NATIVE_MODULES_REPORT.md`（`react-native-blob-util` / 自研原生模块）。

### 10. 端口与网络接口
- 本地资源服务器监听 `127.0.0.1` 的临时端口；部分系统省电策略会杀掉监听。
- **方案**：在 `AppState` 变为后台时暂停，恢复时重启并刷新 WebView URL。

### 11. WebView 缓存
- `react-native-webview` 的缓存策略与 Electron 不同，长会话可能出现旧资源。
- **方案**：加载时带版本查询参数；`assets.json` 已含内容哈希，可直接用作版本号。

### 12. 内存占用
- 桌面端页面 1400×900 缩放到手机上虽然渲染分辨率低，但 DOM 仍按 1400×900 布局。
  低端机需评估 WebView 内存峰值。

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
- 真机（Android）已完成首轮冒烟：页面加载、`app.whenReady()` 生命周期、
  内置规则集导入、Analytics、本地资源服务器、WebView↔RN 双向 IPC 均正常
  （见 `reports/screenshot-android.png`）。
- 仍待验证：代理监听与规则命中、答案提交、文件上传下载、iOS 侧全部流程。

### 17. 扩展规则市场请求被 CORS 拦截
- `renderer/pages/extensions/index.js` 直接 `fetch('https://366.cyril.qzz.io/api/rulesets')`。
- 该服务固定返回 `Access-Control-Allow-Origin: https://366.cyril.zone`，
  既不匹配桌面的 `file://`（`Origin: null`）也不匹配移动端的 `http://127.0.0.1:<port>`。
- **结论**：与桌面端行为一致（同源策略导致 `Failed to fetch`），不是迁移缺陷。
- **方案**（若要修复）：在本地资源服务器上加 `/__remote` 反向代理，
  用注入脚本改写 `fetch`/`XHR` 指向本地代理，由 RN 侧发起 HTTPS 请求。

## 验收清单（真机可用后执行）

- [x] `npm run android` 启动，主页显示（Android 真机，2026-10）
- [x] 主界面 1400×900 布局缩放正确，无横向滚动条
- [x] `window.electronAPI` 可用，注入窗口正常打开
- [x] 内置规则集导入完成（5 个内置规则集）
- [x] 本地资源服务器 + WebView 页面加载正常
- [ ] IPC `invoke` 与 `send` 全链路（renderer 初始化已跑通，其余待验）
- [ ] 明文 HTTP 规则命中并触发动作
- [ ] 答案上传/下载走通（Supabase storage）
- [ ] 杀进程后重启，状态可恢复
- [ ] iOS 全流程
