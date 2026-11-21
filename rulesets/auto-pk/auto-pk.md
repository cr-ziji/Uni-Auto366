# auto-pk

## 文件说明

### auto-pk.zip

- 已预打包预注入完成的zip文件
- 包含 auto-pk.js 和注入完成的html文件
- 可直接替换响应体使用
- 未上传原因：文件过大且存在安全风险(可在官网社区规则集获取)
- 如需使用，可通过抓包自定义脚本

### auto-pk.js

- 注入所需的JS脚本
- 答案直接从页面 Vue 组件状态读取（`vm.word` / `vm.en2cn`），不依赖词库，也不做文字相似度猜测
- 内置浮动控制台，自动创建，默认不启动（点“开始”后才会自动作答）
  - 鼠标 / 触控都可拖动，可折叠、隐藏（隐藏后右下角保留“PK”圆钮）
  - 显示已答 / 正确 / 错误 / 正确率，以及作答日志
  - 正确率滑杆：未命中时随机点一个错误选项
  - 间隔输入框：题目出现后等待多久再作答（0 / 150 / 500 快捷按钮）
  - “跳过动画”开关：缩短作答动画并提前收掉 +1 / 错误提示，让下一题更快出现；默认关闭
  - “提交时间”开关 + 分/秒输入：把提交用时同步给本地服务，由代理层改写提交里的 `submitJson.duration`（毫秒）和 `wordInfos[].answerTime`；默认关闭，随时可开可关
    - 覆盖 `wordsbtl/student/submit`（普通 PK）和 `word-king/submit`（词王争霸），改包逻辑在 `modules/proxy/time-modifier.js`
    - 页面层拦不到 Electron 客户端发出的提交请求，所以脚本只负责把「启用 / 秒数」POST 到本地服务 `/pk-time`（用 `text/plain` 发送 JSON，避免 CORS 预检）
  - 正确率、间隔、跳过动画、提交时间保存在 localStorage，下次进入自动恢复
    - 保存键：`a366_pk_accuracy` / `a366_pk_interval` / `a366_pk_skip_anim` / `a366_pk_time_enabled` / `a366_pk_time_seconds`
    - 提交时间兼容旧控制台的 `pkTimeModEnabled` / `pkTimeModSeconds`，老设置不用重填
- 注入规则：<script src="./auto-pk.js"></script>
