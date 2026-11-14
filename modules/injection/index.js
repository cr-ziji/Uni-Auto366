const moduleLog = require('../logging').create('注入');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {isMobile} = require('../app/platform');

class InjectionManager {
  constructor(options) {
    Object.assign(this, options);
    this.dynamicInjectTemp = new Map();
    this.workDirectories = new Set();
    this.queue = Promise.resolve();
    this.start();
  }
  start() { this.stopped = false; this.abortController = new AbortController(); }
  enqueue(operation) {
    const job = this.queue.then(() => this.stopped ? null : operation());
    this.queue = job.catch(() => {});
    return job;
  }
  async stop() {
    this.stopped = true;
    this.abortController.abort();
    clearTimeout(this.closeTimer);
    await this.queue.catch(() => {});
    clearTimeout(this.closeTimer);
    this.closeProgressWindow();
    this.dynamicInjectTemp.clear();
    if (require('../config').get('keep-cache-files') !== 'true') {
      for (const directory of this.workDirectories) await this.removeWorkDirectory(directory);
    }
    this.workDirectories.clear();
  }
  async removeWorkDirectory(directory) {
    const root = path.resolve(this.tempDir, 'dynamic-inject');
    if (path.dirname(path.resolve(directory)) !== root) throw new Error('无效注入缓存目录');
    await fs.remove(directory);
    this.workDirectories.delete(directory);
  }
  cacheKey(rule, url) {
    const parsed = new URL(url);
    return JSON.stringify([rule.id, parsed.host, this.downloadIdentity(url)]);
  }
  downloadIdentity(url) {
    const parsed = new URL(url);
    // 只去掉已知 CDN 鉴权字段；文件 ID、版本等业务参数仍参与关联。
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:signature|expires|key-pair-id|auth_key|token|x-amz-.+|x-oss-.+|x-cos-.+)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.pathname + '?' + parsed.searchParams.toString();
  }
  cachedDownload(rule, url) {
    const exact = this.dynamicInjectTemp.get(this.cacheKey(rule, url));
    if (exact) return exact;
    const identity = this.downloadIdentity(url);
    const matches = [...this.dynamicInjectTemp.values()].filter(entry => entry.ruleId === rule.id
      && entry.urls?.some(candidate => this.downloadIdentity(candidate) === identity
        && (new URL(candidate).host === new URL(url).host || this.ruleEngine.urlMatchesPattern(url, rule.urlZip))));
    // CDN 域名变化可以关联同一路径；有多个候选时不返回任意一个包。
    return matches.length === 1 ? matches[0] : null;
  }
  scheduleClose(delay) {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.closeProgressWindow(), delay);
  }
  async pruneCache() {
    for (const [key, value] of this.dynamicInjectTemp) {
      // 移动端的条目没有落盘文件，只有内存里的包，不能按 zipPath 是否存在判断。
      const alive = Date.now() - value.timestamp <= 300000
        && (Boolean(value.zipBuffer) || await fs.pathExists(value.zipPath));
      if (alive) continue;
      this.dynamicInjectTemp.delete(key);
      if (require('../config').get('keep-cache-files') !== 'true') await this.removeWorkDirectory(value.directory);
    }
  }
  /** 移动端缓存的是整包字节，别让学生连着开几个大课件就把内存吃光。 */
  trimZipBuffers(limit = 128 * 1024 * 1024) {
    const buffered = [...this.dynamicInjectTemp.entries()].filter(([, value]) => value.zipBuffer);
    let total = buffered.reduce((sum, [, value]) => sum + value.zipBuffer.length, 0);
    if (total <= limit) return;
    // Map 保持插入顺序，从最旧的开始丢，保留最近用过的包。
    for (const [key, value] of buffered) {
      if (total <= limit) break;
      this.dynamicInjectTemp.delete(key);
      total -= value.zipBuffer.length;
    }
  }
}
Object.assign(InjectionManager.prototype, require('./archive'), require('./window'), require('./zip'), {
_replaceFileInfoFields(bodyStr, md5, fileSize) {
    bodyStr = bodyStr.replace(/"filemd5"\s*:\s*"[^"]*"/g, `"filemd5":"${md5}"`);
    bodyStr = bodyStr.replace(/"objectMD5"\s*:\s*"[^"]*"/g, `"objectMD5":"${md5}"`);
    bodyStr = bodyStr.replace(/"filesize"\s*:\s*\d+/g, `"filesize":${fileSize}`);
    bodyStr = bodyStr.replace(/"filesize"\s*:\s*"\d+"/g, `"filesize":"${fileSize}"`);
    bodyStr = bodyStr.replace(/"objectSize"\s*:\s*\d+/g, `"objectSize":${fileSize}`);
    bodyStr = bodyStr.replace(/"objectSize"\s*:\s*"\d+"/g, `"objectSize":"${fileSize}"`);
    return bodyStr;
  },


async applyZipImplantRules(url, responseBody) {
    try {
      for (const ruleset of this.rulesManager.getRules()) {
        if (!ruleset.enabled) continue;
        for (const rule of ruleset.rules) {
          if (!this.ruleEngine.isRuleEffective(rule, ruleset)) continue;
          if (rule.type === 'zip-implant') {
            if (!await fs.pathExists(rule.zipImplant)) {
              continue;
            }

            const zipUrlMatches = this.ruleEngine.urlMatchesPattern(url, rule.urlZip);

            const fileinfoUrlMatches = rule.urlFileinfo ? this.ruleEngine.urlMatchesPattern(url, rule.urlFileinfo) : true;

            const isFileInfoRequest = this.ruleEngine._isFileInfoRequest(url);

            const isFileDownloadRequest = this.ruleEngine._isFileDownloadRequest(url);

            if (isFileInfoRequest && fileinfoUrlMatches) {
              if (rule.targetFileName) {
                const extractedFileName = this.extractFileNameFromResponse(responseBody, url);
                if (!extractedFileName || !this.ruleEngine.fileNameMatchesPattern(extractedFileName, rule.targetFileName)) {
                  continue;
                }
              }

              const { md5, size: fileSize } = await this.describeZip(rule.zipImplant);

              responseBody = this._replaceFileInfoFields(responseBody.toString(), md5, fileSize);

              if (this.analyticsManager) {
                this.analyticsManager.capture('zip_implant_applied', { rule_type: 'fileinfo' });
              }

              if (rule.maxTriggers !== undefined) {
                rule.currentTriggers = (rule.currentTriggers || 0) + 1;
                this.rulesManager.saveRules();
              }

              return Buffer.from(responseBody);
            }
            else if (zipUrlMatches && isFileDownloadRequest) {
              if (this.analyticsManager) {
                this.analyticsManager.capture('zip_implant_applied', { rule_type: 'download' });
              }

              if (rule.maxTriggers !== undefined) {
                rule.currentTriggers = (rule.currentTriggers || 0) + 1;
                this.rulesManager.saveRules();
              }

              return await fs.readFile(rule.zipImplant);
            }
          }
        }
      }
    } catch (error) {
      moduleLog.error('应用zip注入规则失败:', error);
    }

    return responseBody;
  },

async applyDynamicInjectRules(url, responseBody) {
    try {
      const isFileInfoRequest = this.ruleEngine._isFileInfoRequest(url);
      const isFileDownloadRequest = this.ruleEngine._isFileDownloadRequest(url);

      for (const ruleset of this.rulesManager.getRules()) {
        if (!ruleset.enabled) continue;
        for (const rule of ruleset.rules) {
          if (rule.type !== 'zip-implant-dynamic') continue;
          if (!this.ruleEngine.isRuleEffective(rule, ruleset) && !(rule.enabled && isFileDownloadRequest)) continue;

          const fileinfoUrlMatches = rule.urlFileinfo ? this.ruleEngine.urlMatchesPattern(url, rule.urlFileinfo) : false;
          const zipUrlMatches = rule.urlZip ? this.ruleEngine.urlMatchesPattern(url, rule.urlZip) : false;

          if (isFileInfoRequest && fileinfoUrlMatches) {
            if (this.analyticsManager) {
              this.analyticsManager.capture('dynamic_inject_applied', { phase: 'fileinfo' });
            }
            const job = this.enqueue(async () => {
              await this.pruneCache();
              clearTimeout(this.closeTimer);
              return this.handleDynamicInjectFileInfo(url, responseBody, rule);
            });
            return (await job) ?? responseBody;
          }

          if (zipUrlMatches && isFileDownloadRequest) {
            if (this.analyticsManager) {
              this.analyticsManager.capture('dynamic_inject_applied', { phase: 'download' });
            }
            const result = await this.enqueue(() => this.handleDynamicInjectZipDownload(url, rule));
            if (result !== null) return result;
          }
        }
      }
    } catch (error) {
      moduleLog.error('应用动态注入规则失败:', error);
      this.sendProgress('error', '动态注入失败: ' + error.message);
      this.closeProgressWindow();
    }
    return responseBody;
  },

async handleDynamicInjectFileInfo(url, responseBody, rule) {
    let injectDir, cached = false;
    // 出错时把阶段带进日志：下载/解压/注入/打包 失败的原因完全不同，
    // 只报 "动态注入失败" 时无法判断该查哪一步。
    let stage = '解析响应';
    const startedAt = Date.now();
    let downloadMs = 0;
    try {
      let bodyStr = responseBody.toString();
      let jsonData;
      try {
        jsonData = JSON.parse(bodyStr);
      } catch (e) {
        return responseBody;
      }

      let objectName = jsonData.objectName || jsonData.object_name || '';
      if (jsonData.data) {
        objectName = objectName || jsonData.data.objectName || jsonData.data.object_name || '';
      }

      if (rule.targetFileName && !this.ruleEngine.fileNameMatchesPattern(objectName, rule.targetFileName)) {
        return responseBody;
      }

      let downloadUrl = jsonData.downloadUrl || jsonData.download_url || '';
      if (jsonData.data) {
        downloadUrl = downloadUrl || jsonData.data.downloadUrl || jsonData.data.download_url || '';
      }

      if (!downloadUrl) {
        this.safeIpcSend('rule-log', moduleLog.event({ type: 'error', message: `动态注入: 未找到downloadUrl` }));
        return responseBody;
      }

      this.showProgressWindow();

      const requestKey = this.cacheKey(rule, downloadUrl);
      this.sendProgress('downloading', '正在下载原始ZIP...', 10);

      const timeout = rule.downloadTimeout || 30000;
      injectDir = path.join(this.tempDir, 'dynamic-inject', crypto.randomUUID());
      this.workDirectories.add(injectDir);
      await fs.ensureDir(injectDir);

      const originalZipPath = path.join(injectDir, 'original.zip');
      const injectedZipPath = path.join(injectDir, 'injected.zip');
      const urls = [downloadUrl];
      stage = '下载原始ZIP';
      await this.downloadWithRetry(downloadUrl, originalZipPath, timeout, this.abortController.signal, redirected => urls.push(redirected));
      downloadMs = Date.now() - startedAt;

      // 先读脚本：原地注入和回退路径都要用，放在解压之前可以少做无用功。
      this.sendProgress('injecting', '正在注入脚本...', 30);
      stage = '读取注入脚本';
      const scripts = await this.loadInjectScripts(rule);
      if (scripts.length === 0) {
        this.safeIpcSend('rule-log', moduleLog.event({ type: 'error', message: `动态注入: 未找到有效注入脚本` }));
        this.closeProgressWindow();
        return responseBody;
      }

      stage = '注入脚本';
      let injected;
      let zipBuffer = null;
      try {
        // 不做整包解压/重压缩：只改 .html，其余条目连同压缩字节原样拷贝。
        injected = await this.rewriteZipFile(originalZipPath, scripts);
        if (isMobile) {
          // 移动端每次 writeFile 都要把整包 base64 过一次桥，直接留内存更划算；
          // 内存占用和写盘后的 fileMirror 一样，没有额外代价。
          zipBuffer = injected.buffer;
        } else {
          await fs.writeFile(injectedZipPath, injected.buffer);
        }
      } catch (error) {
        if (!error || error.code !== 'E_ZIP_UNSUPPORTED') throw error;
        moduleLog.warn('ZIP 结构不支持原地注入，回退到解压/重打包：', error.message);
        this.sendProgress('extracting', '正在解压ZIP...', 50);
        injected = await this.injectZipByExtract(originalZipPath, injectDir, scripts);
        zipBuffer = null;
      }

      if (!injected || injected.htmlCount === 0) {
        this.safeIpcSend('rule-log', moduleLog.event({ type: 'warning', message: '动态注入: 未找到HTML文件' }));
        this.closeProgressWindow();
        return responseBody;
      }
      if (this.stopped) return responseBody;

      const injectedMd5 = injected.md5;
      const injectedSize = injected.size;
      this.sendProgress('modifying', '正在修改响应...', 90);
      const previous = this.dynamicInjectTemp.get(requestKey);
      this.dynamicInjectTemp.set(requestKey, {
        zipPath: injectedZipPath, zipBuffer, directory: injectDir, md5: injectedMd5,
        size: injectedSize, timestamp: Date.now(), downloadUrl, objectName, ruleId: rule.id, urls,
      });
      cached = true;
      if (previous && require('../config').get('keep-cache-files') !== 'true') await this.removeWorkDirectory(previous.directory);
      if (zipBuffer) {
        // 注入包已在内存里，原包没必要继续占着镜像内存。
        await this.removeWorkDirectory(injectDir);
        injectDir = null;
        this.trimZipBuffers();
      }

      bodyStr = this._replaceFileInfoFields(bodyStr, injectedMd5, injectedSize);

      if (rule.maxTriggers !== undefined) {
        rule.currentTriggers = (rule.currentTriggers || 0) + 1;
        this.rulesManager.saveRules();
      }

      this.safeIpcSend('rule-log', moduleLog.event({
        type: 'success',
        // 带耗时：手机上"慢"通常卡在下载或注入其中一段，分开报才看得清。
        message: `动态注入完成: ${objectName} → ${injected.htmlCount}个HTML已注入（下载 ${downloadMs}ms / 注入 ${Date.now() - startedAt - downloadMs}ms）`,
        ruleId: rule.id,
        ruleName: rule.name
      }));

      this.sendProgress('done', '动态注入完成', 100);
      this.scheduleClose(1500);

      return Buffer.from(bodyStr);
    } catch (error) {
      moduleLog.error('处理动态注入fileinfo失败:', error);
      this.safeIpcSend('rule-log', moduleLog.event({ type: 'error', message: `动态注入失败（${stage}）: ${error.message}` }));
      this.sendProgress('error', '失败: ' + error.message);
      this.scheduleClose(3000);
      return responseBody;
    } finally {
      if (injectDir && !cached) await this.removeWorkDirectory(injectDir).catch(error => moduleLog.warn('清理注入缓存失败：', error));
    }
  },

async handleDynamicInjectZipDownload(url, rule) {
    // 同一规则可对应多个下载，不能只按规则 ID 返回最后一个 ZIP。
    await this.pruneCache();
    const entry = this.cachedDownload(rule, url);
    if (entry) {
      this.safeIpcSend('rule-log', moduleLog.event({
        type: 'success',
        message: `动态注入: 返回已注入的ZIP (${entry.md5})`,
        ruleId: rule.id,
        ruleName: rule.name
      }));
      // 移动端注入结果只留在内存里，省掉一次整包 base64 桥写。
      return entry.zipBuffer ?? await fs.readFile(entry.zipPath);
    }

    this.safeIpcSend('rule-log', moduleLog.event({
      type: 'warning',
      message: '动态注入: 未找到已处理的ZIP，返回原始响应'
    }));
    return null;
  },

async resolveInjectScripts(rule) {
    const scripts = Array.isArray(rule.injectScripts) && rule.injectScripts.length
      ? rule.injectScripts : [rule.injectScript || path.join('rulesets', 'auto-listening', 'auto-listening.js')];
    const paths = [];
    for (const script of scripts) {
      const resolved = path.resolve(this.appPath, script);
      if (await fs.pathExists(resolved)) paths.push(resolved);
      else if (await fs.pathExists(script)) paths.push(script);
    }
    return paths;
  },

/** 读出注入脚本内容（已带上运行时配置前缀），注入流程两条路径共用。 */
async loadInjectScripts(rule) {
    const scriptPaths = await this.resolveInjectScripts(rule);
    if (!scriptPaths || scriptPaths.length === 0) return [];
    // 注入的脚本跑在页面里，拿不到主进程的配置。bucket 端口是可以改的
    // （见 setBucketPort），脚本里写死端口一旦用户改过就全链路失联，
    // 所以在脚本头部塞一段运行时配置，让它自己读。
    const runtimePrelude =
      '/* Auto366 注入运行时配置（由代理层在注入时写入） */\n' +
      'window.__A366__ = ' + JSON.stringify({
        bucket: 'http://127.0.0.1:' + this.getPort(),
        bucketPort: this.getPort(),
      }) + ';\n';
    const scripts = [];
    for (const scriptPath of scriptPaths) {
      scripts.push({
        name: path.basename(scriptPath),
        content: runtimePrelude + await fs.readFile(scriptPath, 'utf8'),
      });
    }
    return scripts;
  },

/**
 * 回退路径：ZIP 结构原地改不了时（ZIP64/加密/未知压缩方式）才解压重打包。
 * 移动端这条路很慢，正常情况下不会走到。
 */
async injectZipByExtract(originalZipPath, injectDir, scripts) {
    const extractDir = path.join(injectDir, 'extracted');
    await fs.ensureDir(extractDir);
    await this.extractZip(originalZipPath, extractDir);

    const htmlFiles = await this.findAllHtmlFiles(extractDir);
    if (htmlFiles.length === 0) return {htmlCount: 0, md5: '', size: 0};

    for (const htmlFile of htmlFiles) {
      if (this.stopped) return {htmlCount: 0, md5: '', size: 0};
      for (const script of scripts) {
        await this.injectScriptIntoHtml(htmlFile, script.name);
        await fs.writeFile(path.join(path.dirname(htmlFile), script.name), script.content, 'utf8');
      }
    }

    const injectedZipPath = path.join(injectDir, 'injected.zip');
    await this.repackZip(extractDir, injectedZipPath);
    const {md5, size} = await this.describeZip(injectedZipPath);
    return {md5, size, htmlCount: htmlFiles.length};
  },
});
module.exports = InjectionManager;
