const http = require('http');
const https = require('https');
const fs = require('fs-extra');
const path = require('path');
const StreamZip = require('node-stream-zip');
const archiver = require('archiver');

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
        await require('stream/promises').pipeline(response, fs.createWriteStream(savePath));
      } catch (error) {
        // 移动端的响应流由原生 socket 回调驱动：正文读满后底层连接的 close 可能
        // 先于 'end' 到达，pipeline 的 end-of-stream 判定于是报 Premature close，
        // 而文件其实已经写完。只有内容确实不是 ZIP 时才算真的失败。
        if (!this.isPrematureCloseError(error) || !await this.isZipFile(savePath)) throw error;
        moduleLog.warn('下载响应提前关闭，但文件已完整写入，继续处理');
      }
      if (!await this.isZipFile(savePath)) throw new Error('下载的文件不是有效的ZIP格式');
      return savePath;
    } catch (error) {
      request?.destroy(); response?.destroy();
      if (created) await fs.remove(savePath).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
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
    let content = await fs.readFile(htmlFilePath, 'utf-8');

    // 听说页会在正文脚本里立刻加载 jquery.recordwave.js / exam-pc-v1.js。
    // 若仍用 createElement 异步追加，录音库可能先缓存真实 getUserMedia，
    // 后续再替换 navigator.mediaDevices 已经来不及。直接放到 body 起始处，
    // 利用普通 script 的解析阻塞语义保证假麦克风先完成接管。
    if (scriptFileName === 'auto-listening.js') {
      const directTag = `<script src="./${scriptFileName}"></script>`;
      if (!content.includes(directTag)) {
        content = content.replace(/<body(\s[^>]*)?>/i, (bodyTag) => bodyTag + directTag);
      }
      await fs.writeFile(htmlFilePath, content, 'utf-8');
      return;
    }

    const injectCode = `var s = document.createElement('script');s.src='./${scriptFileName}';document.body.appendChild(s);`;

    if (content.includes('loadFile.load()')) {
      content = content.replace(
        /\.then\s*\(\s*function\s*\(\s*\)\s*\{/g,
        '.then(function(){' + injectCode
      );
    } else {
      content = content.replace(
        /<\/body>/i,
        '<script>' + injectCode + '</script></body>'
      );
    }

    await fs.writeFile(htmlFilePath, content, 'utf-8');
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
