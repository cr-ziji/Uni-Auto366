// Bound completed captures, independently of requests currently being processed.
//
// 上限按手机来定：桌面端留 200 条 / 64 MB 无所谓，手机上这块常驻内存会跟
// WebView、Hermes 抢同一份预算，低端机很容易被系统回收（表现为切回来要重启）。
// 24 MB / 120 条仍然够翻最近的记录，也够完整下载一条中等大小的响应。
class TrafficCache extends Map {
  constructor({ maxEntries = 120, maxBytes = 24 * 1024 * 1024 } = {}) {
    super();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.retainedBytes = 0;
    this.weights = new Map();
    this.cleanups = new Set();
  }
  set(id, value) {
    this.delete(id);
    const bytes = (value.captureBody?.size || value.originalResponse?.byteLength || 0)
      + 2 * ((value.requestBody?.length || 0) + (value.responseBody?.length || 0));
    value.captureBody?.retain();
    super.set(id, value);
    this.weights.set(id, bytes);
    this.retainedBytes += bytes;
    // Keep a single oversize response downloadable. In-flight requests are not part of this budget.
    while (this.size > 1 && (this.size > this.maxEntries || this.retainedBytes > this.maxBytes)) {
      this.delete(this.keys().next().value);
    }
    return this;
  }
  delete(id) {
    const capture = this.get(id)?.captureBody;
    if (capture) {
      const cleanup = capture.release().catch(() => {}).finally(() => this.cleanups.delete(cleanup));
      this.cleanups.add(cleanup);
    }
    this.retainedBytes -= this.weights.get(id) || 0;
    this.weights.delete(id);
    return super.delete(id);
  }
  async dispose() {
    this.clear();
    await Promise.all(this.cleanups);
  }
  clear() {
    for (const id of this.keys()) this.delete(id);
    this.weights.clear();
    this.retainedBytes = 0;
  }
}
module.exports = TrafficCache;
