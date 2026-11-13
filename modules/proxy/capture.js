const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// 一个响应的临时存储。请求、历史记录和保存对话框各持有一个引用。
class CaptureBody {
  constructor({ limit = 8 * 1024 * 1024, previewLimit = 256 * 1024 } = {}) {
    this.limit = limit;
    this.previewLimit = previewLimit;
    this.size = 0;
    this.chunks = [];
    this.previewChunks = [];
    this.previewSize = 0;
    this.references = 1;
    this.pending = Promise.resolve();
    this.file = null;
  }
  append(chunk) {
    // 原生 HTTP 客户端有时会给出 `Uint8Array`（RN 的 Buffer.subarray()
    // 返回的就是普通 Uint8Array），统一成 Buffer，后面的 `copy()` /
    // `Buffer.concat()` 才可用。
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.pending = this.pending.then(async () => {
      if (this.references === 0) throw new Error('响应捕获已取消');
      const remaining = this.previewLimit - this.previewSize;
      if (remaining > 0) {
        const preview = Buffer.from(payload.subarray(0, remaining));
        this.previewChunks.push(preview); this.previewSize += preview.length;
      }
      this.size += payload.length;
      if (!this.file && this.size <= this.limit) { this.chunks.push(payload); return; }
      if (!this.file) {
        this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'auto366-capture-'));
        this.file = path.join(this.directory, 'body.bin');
        this.handle = await fs.open(this.file, 'wx');
        for (const buffered of this.chunks) await this.write(buffered);
        this.chunks = [];
      }
      await this.write(payload);
    });
    return this.pending;
  }
  async write(chunk) {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < payload.length) {
      const { bytesWritten } = await this.handle.write(payload, offset, payload.length - offset);
      if (!bytesWritten) throw new Error('响应临时文件写入失败');
      offset += bytesWritten;
    }
  }
  async finish() {
    await this.pending;
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.close();
  }
  buffer() {
    if (this.file) throw new Error('大响应应从磁盘读取');
    return Buffer.concat(this.chunks, this.size);
  }
  preview() { return Buffer.concat(this.previewChunks, this.previewSize); }
  retain() {
    if (!this.references) throw new Error('响应已经释放');
    this.references++;
    return this;
  }
  release() {
    if (this.references > 0) this.references--;
    if (this.references > 0) return Promise.resolve();
    if (!this.cleanup) this.cleanup = this.pending.catch(() => {}).then(async () => {
      this.chunks = []; this.previewChunks = [];
      if (this.handle) { await this.handle.close().catch(() => {}); this.handle = null; }
      if (this.directory) {
        // 目录只来自上面的 mkdtemp，清理前仍验证边界。
        if (path.dirname(this.directory) !== os.tmpdir() || !path.basename(this.directory).startsWith('auto366-capture-')) throw new Error('无效捕获目录');
        await fs.rm(this.directory, { recursive: true, force: true });
      }
    });
    return this.cleanup;
  }
}
module.exports = CaptureBody;
