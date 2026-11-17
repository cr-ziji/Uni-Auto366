const http = require('http');
const https = require('https');
const fs = require('fs-extra');
const path = require('path');
const StreamZip = require('node-stream-zip');
const archiver = require('archiver');
// 这个文件里的方法会被挂到 InjectionManager.prototype 上，作用域仍属于本模块，
// 所以日志器必须在这里声明（之前只在 index.js 声明，下载容错分支引用它会直接 ReferenceError）。
const moduleLog = require('../logging').create('注入');
const {isMobile} = require('../app/platform');
const {applyInjectScript} = require('./zip');

module.exports = {
/** 流是否被提前关闭（移动端 socket 语义导致，见 downloadWithTimeout）。 */
isPrematureCloseError(error) {
    if (!error) return false;
    return error.code === 'ERR_STREAM_PREMATURE_CLOSE' || /premature close/i.test(String(error.message || ''));
  },
/** 只读文件头四个字节判断 ZIP，避免把整包读进主进程内存。 */
async isZipFile(filePath) {
    try {
      const file = await fs.promises.open(filePath, 'r');
      try {
        const header = Buffer.alloc(4);
        const { bytesRead } = await file.read(header, 0, 4, 0);
        return bytesRead === 4 && header.readUInt32LE(0) === 0x04034b50;
      } finally { await file.close(); }
    } catch (error) {
      return false;
    }
  },
/**
 * 完整 ZIP 判定：头是本地文件头，尾部 64KB 内必须有中央目录结束记录（EOCD）。
 * 只查文件头会把"下到一半被断开"的截断包当成完整包，解压时才报一个看不懂的错。
 */
async isCompleteZip(filePath) {
    let size = 0;
    try {
      const stat = await fs.promises.stat(filePath);
      size = stat.size;
      if (size < 22) return false;
      const file = await fs.promises.open(filePath, 'r');
      try {
        const header = Buffer.alloc(4);
        const head = await file.read(header, 0, 4, 0);
        if (head.bytesRead !== 4 || header.readUInt32LE(0) !== 0x04034b50) return false;
        const tailSize = Math.min(size, 65557);
        const tail = Buffer.alloc(tailSize);
        const tailRead = await file.read(tail, 0, tailSize, size - tailSize);
        const buffer = tail.subarray(0, tailRead.bytesRead);
        for (let i = 0; i + 4 <= buffer.length; i++) {
          if (buffer.readUInt32LE(i) === 0x06054b50) return true;
        }
        return false;
      } finally { await file.close(); }
    } catch (error) {
      return false;
    }
  },
async describeZip(file) {
    // 注入包在下载阶段会被反复读取；按 mtime/size 缓存 md5，避免每次下载
    // 都在 JS 线程里重新哈希几十上百 MB（安卓上这会让响应迟迟发不出去）。
    const stat = await fs.stat(file);
    const key = `${fs.realpathSync?.(file) || file}|${stat.size}|${stat.mtimeMs}`;
    if (!this._zipHashCache) this._zipHashCache = new Map();
    const cached = this._zipHashCache.get(key);
    if (cached) return cached;
    const hash = require('crypto').createHash('md5');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
    const result = { md5: hash.digest('hex'), size };
    this._zipHashCache.set(key, result);
    while (this._zipHashCache.size > 8) this._zipHashCache.delete(this._zipHashCache.keys().next().value);
    return result;
  },
async downloadWithTimeout(downloadUrl, savePath, timeout = 30000, redirects = 0, deadline = Date.now() + timeout, signal, onRedirect) {
    const url = new URL(downloadUrl);
    if (!['http:', 'https:'].includes(url.protocol) || redirects > 5) throw new Error('下载地址无效或重定向过多');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('下载超时');
    let request, response, created = false;
    const timer = setTimeout(() => {
      const error = new Error('下载超时');
      request?.destroy(error);
      response?.destroy(error);
    }, remaining);
    try {
      response = await new Promise((resolve, reject) => {
        request = (url.protocol === 'https:' ? https : http).get(url, { signal }, resolve);
        request.once('error', reject);
      });
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.destroy();
        request.destroy();
        clearTimeout(timer);
        const next = new URL(response.headers.location, url).href;
        onRedirect?.(next);
        return await this.downloadWithTimeout(next, savePath, timeout, redirects + 1, deadline, signal, onRedirect);
      }
      if (response.statusCode !== 200) { response.resume(); throw new Error('下载失败: HTTP ' + response.statusCode); }
      created = true;
      try {
        // 移动端这个包紧接着就交给注入流程，落盘只是白花一次整包 base64 桥写。
        await require('stream/promises').pipeline(response, fs.createWriteStream(savePath, {persist: !isMobile}));
      } catch (error) {
        // 移动端的响应流由原生 socket 回调驱动：正文读满后底层连接的 close 可能
        // 先于 'end' 到达，pipeline 的 end-of-stream 判定于是报 Premature close，
        // 而文件其实已经写完。只有内容确实不是完整 ZIP 时才算真的失败。
        if (!this.isPrematureCloseError(error)) throw error;
        const size = await fs.stat(savePath).then(stat => stat.size).catch(() => 0);
        if (!await this.isCompleteZip(savePath)) {
          const incomplete = new Error(`下载中断（已接收 ${size} 字节，ZIP 不完整）`);
          incomplete.code = 'E_DOWNLOAD_INCOMPLETE';
          throw incomplete;
        }
        moduleLog.warn(`下载响应提前关闭，但文件已完整写入（${size} 字节），继续处理`);
      }
      if (!await this.isZipFile(savePath)) throw new Error('下载的文件不是有效的ZIP格式');
      return savePath;
    } catch (error) {
      request?.destroy(); response?.destroy();
      if (created) await fs.remove(savePath).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
  },
/**
 * 下载外层：被截断（Premature close / socket hang up）属于移动网络的瞬态失败，
 * 重下一次通常就好；第二次仍失败就原样抛出，由调用方标注失败阶段。
 */
async downloadWithRetry(downloadUrl, savePath, timeout = 30000, signal, onRedirect) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.downloadWithTimeout(downloadUrl, savePath, timeout, 0, Date.now() + timeout, signal, onRedirect);
      } catch (error) {
        lastError = error;
        // 用户主动停止、第二次尝试、或明确的业务错误（HTTP 4xx/5xx）不再重试。
        if (signal?.aborted || attempt === 2 || !this.isRetryableDownloadError(error)) throw error;
        moduleLog.warn(`下载失败（${error.message}），重试一次`);
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }
    throw lastError;
  },
isRetryableDownloadError(error) {
    if (!error) return false;
    if (error.code === 'E_DOWNLOAD_INCOMPLETE') return true;
    return /socket hang up|ECONNRESET|network|terminated|\bEOF\b/i.test(String(error.message || ''));
  },

extractZip(zipPath, extractDir) {
    return new Promise((resolve, reject) => {
      try {
        const zip = new StreamZip({ file: zipPath, storeEntries: true });
        zip.on('ready', () => {
          zip.extract(null, extractDir, (err, count) => {
            zip.close();
            if (err) reject(err);
            else resolve(count);
          });
        });
        zip.on('error', (err) => {
          zip.close();
          reject(err);
        });
      } catch (error) {
        reject(error);
      }
    });
  },

async findAllHtmlFiles(dir) {
    const results = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        results.push(...await this.findAllHtmlFiles(fullPath));
      } else if (entry.name.endsWith('.html') || entry.name.endsWith('.htm')) {
        results.push(fullPath);
      }
    }
    return results;
  },

async injectScriptIntoHtml(htmlFilePath, scriptFileName) {
    const content = await fs.readFile(htmlFilePath, 'utf-8');
    // 注入规则和原地改写（zip.js）必须完全一致，否则两条路径行为不同。
    await fs.writeFile(htmlFilePath, applyInjectScript(content, scriptFileName), 'utf-8');
  },

repackZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      // 桌面端的 archiver 在 output 'close' 时才算写完；移动端的 polyfill 写完
      // 会同时发 finish/close。两个事件都记，由 finalize 之后统一结算。
      let closed = false;
      let notifyClosed = null;
      const handleClosed = () => {
        closed = true;
        if (notifyClosed) notifyClosed();
      };
      const waitClosed = () => new Promise(done => { if (closed) done(); else notifyClosed = done; });

      output.on('close', handleClosed);
      output.on('finish', handleClosed);
      output.on('error', error => { archive.abort(); reject(error); });
      archive.on('error', error => { output.destroy(); reject(error); });

      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize()
        .then(waitClosed)
        .then(async () => {
          // 空包（只有 ZIP 目录尾，22 字节）说明打包时一个文件都没读到：继续
          // 往下走只会把空包塞给页面，这里直接失败并说明原因。
          const size = await fs.stat(outputPath).then(stat => stat.size).catch(() => 0);
          if (size <= 22) throw new Error(`重新打包结果为空（${size} 字节）`);
          resolve(outputPath);
        })
        .catch(error => { output.destroy(); reject(error); });
    });
  }
};
