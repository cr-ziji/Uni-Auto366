const moduleLog = require('../logging').create('代理');
const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');
const { v4: uuidv4 } = require('uuid');
const Proxy = require('http-mitm-proxy').Proxy;
const CaptureBody = require('./capture');

module.exports = {
  async finishStreamedCapture(capture, info, url, learningInfo) {
    const name = this._resolveDownloadFileName(info, url);
    const isFile = /application\/octet-stream|application\/(x-)?zip|binary\/octet-stream|image/.test(info.contentType || '');
    info.responseBody = isFile ? name : this.isTextualContentType(info.contentType)
      ? capture.preview().toString('utf8') + '\n[大响应仅显示前 256 KiB，可下载完整原文]'
      : '[二进制响应，' + capture.size + ' 字节]';
    info.bodySize = capture.size;
    info.ruleMatched = this.ruleEngine.urlMentionedByEnabledRules(url);
    this.safeIpcSend('traffic-log', info);
    // 仅主进程保存磁盘引用，不传给 renderer。
    this.trafficCache.set(info.uuid, { ...info, captureBody: capture });
    if (this._looksLikeZip(capture.preview()) && (isFile || this.ruleEngine._isFileDownloadRequest(url))) {
      let extracted;
      const keep = require('../config').get('keep-cache-files') === 'true';
      let zipPath = capture.file;
      if (keep) {
        await fs.ensureDir(this.tempDir);
        zipPath = path.join(this.tempDir, info.uuid + '-' + this._safeFileName(name));
        await fs.copyFile(capture.file, zipPath);
      }
      try {
        extracted = await this.extractZipFile(zipPath, this.ansDir, info.uuid);
        if (learningInfo) await this.learnArchive(learningInfo, extracted);
      }
      finally {
        if (!keep && extracted?.extractDir) await fs.remove(extracted.extractDir);
      }
    }
  },
  async learnArchive(info, extracted) {
    try { await this.answerLearning?.observeArchive?.(info, extracted); }
    catch (error) { moduleLog.warn('ZIP AI 候选读取失败：', error.message); }
  },
  /**
   * 响应已经完整发给客户端之后的后台处理：流量记录、ZIP 解压、答案提取。
   *
   * 必须和 `onResponseEnd` 里的 `callback()` 解耦：安卓上解压/解析一个几十
   * MB 的 ZIP 可能要几十秒，如果压着响应结束标记不发，客户端的下载器会
   * 超时并重新下载。
   */
  async finishBufferedResponse({ buffer, text, decompressFailed, requestInfo, fullUrl, learningRequestBody, requestTruncated, responseBodyRules }) {
    const textual = this.isTextualContentType(requestInfo.contentType);
    const isJson = /application\/json/.test(requestInfo.contentType);
    const isFile = /application\/octet-stream|application\/(x-)?zip|binary\/octet-stream|image/.test(requestInfo.contentType || '');
    const downloadName = this._resolveDownloadFileName(requestInfo, fullUrl);
    if (decompressFailed) {
      requestInfo.responseBody = text;
    }
    else if (isJson) {
      try {
        requestInfo.responseBody = JSON.stringify(JSON.parse(text), null, 2);
      } catch (e) {
        requestInfo.responseBody = text;
      }
    }
    else if (isFile) {
      requestInfo.responseBody = downloadName;
    }
    else {
      requestInfo.responseBody = textual ? text : `[二进制响应，${buffer.length} 字节]`;
    }
    requestInfo.bodySize = buffer.length;
    requestInfo.ruleMatched = this.ruleEngine.urlMentionedByEnabledRules(fullUrl);
    this.safeIpcSend('traffic-log', requestInfo);
    if (buffer.length >= 8 * 1024 * 1024) {
      this.safeIpcSend('rule-log', moduleLog.event({
        type: 'info',
        message: `ZIP 响应已完整发送：${(buffer.length / 1048576).toFixed(1)} MiB`,
        url: fullUrl,
        details: `状态 ${requestInfo.statusCode}，${requestInfo.responseHeaders?.['content-length'] ? 'Content-Length ' + requestInfo.responseHeaders['content-length'] : 'chunked'}`,
      }));
    }
    // 大响应（ZIP）不常驻内存：Android 上多留一份上百 MB 的 Buffer 会让
    // 下一次下载直接 OOM。历史记录只保留文件名/大小。
    if (buffer.length <= 32 * 1024 * 1024) requestInfo.originalResponse = buffer;
    this.trafficCache.set(requestInfo.uuid, requestInfo);

    let extracted_answers = {};

    // 答案提取：以 ZIP 魔数为准，不再要求文件名里必须带 "zip"
    // （Content-Type 和文件名都会变，魔数不会；再用下载请求特征挡掉无关的 zip 类文件）
    if (this._looksLikeZip(buffer) && (isFile || this.ruleEngine._isFileDownloadRequest(fullUrl))) {
      let filePath = null;
      try {
        await fs.ensureDir(this.tempDir);
        await fs.ensureDir(this.ansDir);
        filePath = path.join(this.tempDir, requestInfo.uuid + '-' + this._safeFileName(downloadName));
        // Extraction must not depend on the history entry surviving concurrent requests.
        await fs.writeFile(filePath, buffer);
        extracted_answers = await this.extractZipFile(filePath, this.ansDir, requestInfo.uuid);
        if (!requestTruncated && !decompressFailed) await this.learnArchive({ ...requestInfo, requestBody: learningRequestBody }, extracted_answers);
      } catch (error) {
        moduleLog.error('答案提取失败:', error);
        this.safeIpcSend('process-error', { error: `答案提取失败: ${error.message}` });
        extracted_answers = {};
      }

      if (filePath) {
        let shouldKeepCache = false;
        try {
          shouldKeepCache = (require('../config').get('keep-cache-files') === 'true');
        } catch (error) {
          shouldKeepCache = false;
        }

        if (!shouldKeepCache) {
          // 用提取器实际使用的解压目录，避免这里自行推断路径导致残留
          const extractDir = extracted_answers && extracted_answers.extractDir;
          await fs.rm(filePath, { force: true }).catch(() => { });
          if (extractDir && extractDir !== filePath) {
            await fs.rm(extractDir, { recursive: true, force: true }).catch(() => { });
          }
        }
      }
    }

    const handledByAnswerRule = responseBodyRules.includes(3)
      && this.ruleEngine.dispatchAnswers(fullUrl, buffer, extracted_answers) === true;

    // Existing parsers/rules keep priority. Learning never delays the intercepted response.
    if (!requestTruncated && !decompressFailed && !extracted_answers.answers?.length && !handledByAnswerRule && this.answerLearning) {
      this.answerLearning.observe({ ...requestInfo, requestBody: learningRequestBody }).catch(error => {
        this.safeIpcSend('rule-log', moduleLog.event({ type: 'warning', message: '[AI 答案获取] ' + error.message }));
      });
    }
  },
startProxyPromise() {
    return new Promise((resolve, reject) => {
      // 执行maxTriggers数据迁移（幂等，仅首次生效）
      this.rulesManager.migrateMaxTriggers(this.appPath);

      // 创建新的代理实例
      this.proxy = new Proxy();

      this.proxy.onError((ctx, err) => {
        ctx?._releaseCapture?.().catch(() => {});
        this._speedRelease(ctx);  // 网络保护: 请求出错也要恢复加速, 防止卡在 1×
        moduleLog.error('代理出错:', err);
      });

      this.proxy.onRequest((ctx, callback) => {
        // Keep the legacy URL used by existing rule patterns; captures retain the actual scheme.
        const protocol = "http";
        const fullUrl = `${protocol}://${ctx.clientToProxyRequest.headers.host}${ctx.clientToProxyRequest.url}`;
        const captureUrl = `${ctx.isSSL ? 'https' : 'http'}://${ctx.clientToProxyRequest.headers.host}${ctx.clientToProxyRequest.url}`;

        const isAnswerCaptureEnabled = this.answerCaptureEnabled;

        let requestInfo = {
          method: ctx.clientToProxyRequest.method,
          url: captureUrl,
          host: ctx.clientToProxyRequest.headers.host,
          timestamp: new Date().toISOString(),
          isHttps: !!ctx.isSSL,
          requestHeaders: ctx.clientToProxyRequest.headers,
          uuid: uuidv4(),
        }

        if (!isAnswerCaptureEnabled) {
          return callback();
        }

        // 进程加速网络保护: 该 up366 请求在飞期间把倍率瞬时压回 1×, 响应结束再恢复,
        // 避免加速把 renderer 请求超时掐断(题目进不去/交卷失败)。与下方 onResponseEnd 配对。
        this._speedHold(ctx);

        let requestBody = [], responseBody = [], learningRequestBody = '';
        let requestBytes = 0, requestTruncated = false, captureBody = null, captureReleased = false, processingResponse = false;
        // 完整注入包（静态 ZIP 注入 / 已生成的动态注入包）：命中时上游正文会被整体替换。
        let replacement = null;
        const releaseCapture = async () => {
          if (!captureBody || captureReleased) return;
          captureReleased = true;
          await captureBody.release();
        };
        ctx._releaseCapture = () => processingResponse ? Promise.resolve() : releaseCapture();
        ctx.clientToProxyRequest.once?.('aborted', () => ctx._releaseCapture().catch(() => {}));
        ctx.proxyToClientResponse.once?.('close', () => {
          if (!processingResponse) releaseCapture().catch(() => {});
        });
        const hasPostChangeTimeRule = this.getPostChangeTimeRules(fullUrl, ctx.clientToProxyRequest.method).length > 0;
        const hasPkTimeMod = this.shouldApplyPkTimeMod(fullUrl, ctx.clientToProxyRequest.method);
        const hasListenTime = this.shouldApplyListenTime(fullUrl, ctx.clientToProxyRequest.method);
        const hasFillTime = this.shouldApplyFillTime(fullUrl, ctx.clientToProxyRequest.method);
        // 需要拦截改写 body 的任一情形：post-change-time 规则 或 PK时间修改 或 听力时间修改 或 填空时间修改
        const needBufferBody = hasPostChangeTimeRule || hasPkTimeMod || hasListenTime || hasFillTime;

        ctx.onRequestData((ctx, chunk, callback) => {
          requestBytes += chunk.length;
          if (needBufferBody || requestBytes <= 2 * 1024 * 1024) requestBody.push(chunk);
          else requestTruncated = true;
          if (needBufferBody) return callback(null, null);
          return callback(null, chunk);
        })
        ctx.onRequestEnd(async (ctx, callback) => {
          try {
            if (requestTruncated) {
              requestInfo.requestBody = '[请求正文超过 2 MiB，已原样转发，省略正文记录]';
              requestBody = [];
              return callback();
            }
            let bodyBuffer = Buffer.concat(requestBody);
            requestBody = [];
            const reqEncoding = ctx.clientToProxyRequest.headers['content-encoding'];

            // 解压请求体（如果客户端发送了压缩数据）
            let body;
            if (reqEncoding) {
              const { text, decompressFailed } = await this.decompressBuffer(bodyBuffer, reqEncoding);
              if (decompressFailed) {
                requestInfo.requestBody = text;
                if (needBufferBody) ctx.proxyToServerRequest.write(bodyBuffer);
                return callback();
              }
              body = text;
            } else {
              body = bodyBuffer.toString();
            }
            // Preserve the original form/JSON shape for fingerprinting before display formatting.
            learningRequestBody = body;

            if (hasPostChangeTimeRule) {
              const rules = this.getPostChangeTimeRules(fullUrl, ctx.clientToProxyRequest.method);
              const rule = rules[0];
              const modifiedBody = this.applyPostChangeTime(body, rule, fullUrl, ctx.clientToProxyRequest.headers['content-type']);
              this.writeModifiedFormBody(ctx, modifiedBody, requestInfo);
              return callback();
            }

            // ===== 时间修改：改写 submit 提交用时 =====
            if (hasPkTimeMod) {
              const modifiedBody = this.applyPkTimeMod(body, fullUrl, ctx.clientToProxyRequest.headers['content-type']);
              this.writeModifiedFormBody(ctx, modifiedBody, requestInfo);
              return callback();
            }

            // ===== 听力时间修改：改写听力作业提交用时 =====
            if (hasListenTime) {
              const modifiedBody = this.applyListenTime(body, fullUrl, ctx.clientToProxyRequest.headers['content-type']);
              this.writeModifiedFormBody(ctx, modifiedBody, requestInfo);
              return callback();
            }

            // ===== 填空时间修改：改写填空作业提交用时 =====
            if (hasFillTime) {
              const isGzipFillSubmit = fullUrl.includes('task/score/gzip/submit');
              if (isGzipFillSubmit) {
                // gzip/submit 的请求体是应用层 gzip 压缩的二进制流（无 content-encoding 头），
                // 需要先 gunzip 得到明文，才能交给 applyFillTimeMod 解析改写。
                const fillTimeProcess = (plainBody) => {
                  const modifiedBody = this.applyFillTimeMod(plainBody, fullUrl, ctx.clientToProxyRequest.headers['content-type']);
                  zlib.gzip(Buffer.from(modifiedBody, 'utf-8'), (err, compressed) => {
                    if (err) {
                      this.safeIpcSend('rule-log', moduleLog.event({ type: 'error', message: `[填空时间] gzip压缩失败: ` + err.message, url: fullUrl }));
                      this.writeModifiedFormBody(ctx, modifiedBody, requestInfo);
                    } else {
                      ctx.proxyToServerRequest.removeHeader('transfer-encoding');
                      ctx.proxyToServerRequest.setHeader('content-encoding', 'gzip');
                      ctx.proxyToServerRequest.setHeader('content-length', compressed.length);
                      ctx.proxyToServerRequest.write(compressed);
                      if (requestInfo) {
                        try { requestInfo.requestBody = JSON.stringify(JSON.parse(modifiedBody), null, 2); }
                        catch (e) { requestInfo.requestBody = modifiedBody; }
                      }
                    }
                    return callback();
                  });
                };
                // 先尝试 gunzip 解压请求体；若失败则按明文处理（兼容非压缩提交）
                zlib.gunzip(bodyBuffer, (gzErr, decompressed) => {
                  if (!gzErr && decompressed) {
                    fillTimeProcess(decompressed.toString('utf-8'));
                  } else {
                    fillTimeProcess(body);
                  }
                });
                return;
              } else {
                // 特殊提交接口（如 /submit/v2）：普通请求体，直接改写后写回，不做 gzip 解压/重压缩
                const modifiedBody = this.applyFillTimeMod(body, fullUrl, ctx.clientToProxyRequest.headers['content-type']);
                this.writeModifiedFormBody(ctx, modifiedBody, requestInfo);
                return callback();
              }
            }

            if (ctx.clientToProxyRequest.headers['content-type'] && ctx.clientToProxyRequest.headers['content-type'].includes('application/json')) {
              try {
                body = JSON.stringify(JSON.parse(body), null, 2);
              } catch (error) {
                moduleLog.error('解析请求体失败:', error)
              }
            }
            else if (ctx.clientToProxyRequest.headers['content-type'] && ctx.clientToProxyRequest.headers['content-type'].includes('application/x-www-form-urlencoded')) {
              try {
                const params = new URLSearchParams(body);
                const result = Object.fromEntries(params.entries());
                body = JSON.stringify(result, null, 2);
              } catch (error) {
                moduleLog.error('解析请求体失败:', error)
              }
            }
            else if (ctx.clientToProxyRequest.headers['content-type']) {
              moduleLog.log('未知请求体类型', ctx.clientToProxyRequest.headers['content-type'])
            }
            requestInfo.requestBody = body
            return callback();
          } catch (error) {
            moduleLog.error('处理请求体失败:', error);
            return callback();
          }
        })
        let responseBodyRules = this.ruleEngine.haveRules(fullUrl, 'response-body');
        ctx.onResponse(async (ctx, callback) => {
          try {
          ctx.serverToProxyResponse.once?.('aborted', () => ctx._releaseCapture().catch(() => {}));
          // 先记录响应类型与原始编码：下面内容替换会删除 content-encoding 头，
          // 但 onResponseEnd 解压 buffered 数据时仍需要原始编码，故提前保存。
          requestInfo.contentType = ctx.serverToProxyResponse.headers['content-type'];
          requestInfo.contentEncoding = ctx.serverToProxyResponse.headers['content-encoding'];
          requestInfo.isCompressed = !!requestInfo.contentEncoding;

          const isFileDownloadRequest = this.ruleEngine._isFileDownloadRequest(fullUrl);
          const headers = ctx.serverToProxyResponse.headers;

          // 1) 静态 ZIP 注入：下载请求直接用本地注入包整包替换。
          //    在 onResponse 就确定下来，可以回精确的 Content-Length，并避免
          //    在 onResponseEnd 里再拼接/读取一遍几十上百 MB 的响应。
          if (responseBodyRules.includes(2) && isFileDownloadRequest) {
            try {
              for (const ruleset of this.rulesManager.getRules()) {
                if (!ruleset.enabled) continue;
                for (const rule of ruleset.rules) {
                  if (!this.ruleEngine.isRuleEffective(rule, ruleset) || rule.type !== 'zip-implant') continue;
                  if (!this.ruleEngine.urlMatchesPattern(fullUrl, rule.urlZip)) continue;
                  if (!await fs.pathExists(rule.zipImplant)) continue;
                  const { md5, size } = await this.injection.describeZip(rule.zipImplant);
                  replacement = { path: rule.zipImplant, md5, size };
                  this.safeIpcSend('rule-log', moduleLog.event({
                    type: 'success',
                    message: `规则 "${rule.name}" 修改响应头`,
                    ruleId: rule.id,
                    ruleName: rule.name,
                    url: fullUrl,
                    details: `ETag: ${md5}, Content-MD5: ${Buffer.from(md5, 'hex').toString('base64')}`
                  }));
                  break;
                }
                if (replacement) break;
              }
            } catch (error) {
              moduleLog.warn('读取 ZIP 注入包失败，回退到原始响应：', error.message);
              replacement = null;
            }
          }

          // 2) 动态注入：fileinfo 阶段已经生成过完整注入包时直接交付；
          //    客户端续传（206）也能拿到完整包。
          if (!replacement && responseBodyRules.includes(4) && isFileDownloadRequest) {
            try {
              for (const ruleset of this.rulesManager.getRules()) {
                if (!ruleset.enabled) continue;
                for (const rule of ruleset.rules) {
                  if (!rule.enabled || rule.type !== 'zip-implant-dynamic') continue;
                  if (!rule.urlZip || !this.ruleEngine.urlMatchesPattern(fullUrl, rule.urlZip)) continue;
                  const entry = this.injection.cachedDownload(rule, fullUrl);
                  if (!entry || !await fs.pathExists(entry.zipPath)) continue;
                  const stat = await fs.stat(entry.zipPath);
                  replacement = { path: entry.zipPath, md5: entry.md5, size: stat.size };
                  break;
                }
                if (replacement) break;
              }
            } catch (error) {
              moduleLog.warn('读取动态注入包失败，回退到原始响应：', error.message);
              replacement = null;
            }
          }

          if (replacement) {
            // 整包替换：上游的 range/encoding 全部失效，长度以注入包为准。
            ctx.serverToProxyResponse.statusCode = 200;
            ctx.serverToProxyResponse.statusMessage = 'OK';
            headers['content-length'] = String(replacement.size);
            if (replacement.md5) {
              headers.etag = replacement.md5;
              headers['content-md5'] = Buffer.from(replacement.md5, 'hex').toString('base64');
            }
            delete headers['content-encoding'];
            delete headers['content-range'];
            delete headers['accept-ranges'];
            delete headers['transfer-encoding'];
            delete headers.digest;
            if (!/zip|octet-stream/i.test(String(headers['content-type'] || ''))) {
              headers['content-type'] = 'application/octet-stream';
            }
            ctx.knownResponseBodyLength = replacement.size;
          } else {
            // 响应替换(内容修改)：只对文本类响应(html/js/css/json/xml等)应用整包替换，
            // 二进制(wasm/图片/音视频/zip等)直接放行——既避免 utf-8 字符串替换损坏二进制，
            // 也避免对二进制做无谓的解压重写；文本类替换后内容已解压为明文，去掉压缩与长度头
            if (responseBodyRules.includes(1)) {
              const _ct = String(headers['content-type'] || '');
              if (!this.isTextualContentType(_ct)) {
                responseBodyRules = responseBodyRules.filter(x => x !== 1);
              } else {
                delete headers['content-encoding'];
                delete headers['content-length'];
                delete headers['content-range'];
                delete headers['accept-ranges'];
              }
            }

            requestInfo.statusCode = ctx.serverToProxyResponse.statusCode;
            if (responseBodyRules.some(type => [1, 2, 4].includes(type))) {
              for (const header of ['content-encoding', 'content-length', 'content-range', 'accept-ranges', 'etag', 'content-md5', 'digest']) delete headers[header];
            }
          }

          if (!requestInfo.contentEncoding && !responseBodyRules.some(type => [1, 2, 3, 4].includes(type))) captureBody = new CaptureBody();
          requestInfo.statusCode = ctx.serverToProxyResponse.statusCode;
          requestInfo.statusMessage = ctx.serverToProxyResponse.statusMessage;
          requestInfo.responseHeaders = headers;
          return callback();
          } catch (error) { callback(error); }
        })
        ctx.onResponseData((ctx, chunk, callback) => {
          if (captureBody) {
            captureBody.append(chunk).then(() => callback(null, chunk), error => { releaseCapture().catch(() => {}); callback(error); });
            return;
          }
          const willRewrite = responseBodyRules.includes(2) || responseBodyRules.includes(4) || responseBodyRules.includes(1);
          if (!willRewrite) {
            responseBody.push(chunk);
            return callback(null, chunk);
          }
          // 注入包会整包替换时不必保存上游数据（大 ZIP 在安卓上最容易 OOM）。
          if (!replacement) responseBody.push(chunk);
          return callback(null, Buffer.from(''));
        })
        ctx.onResponseEnd(async (ctx, callback) => {
          processingResponse = true;
          this._speedRelease(ctx);  // 网络保护: 响应结束, 恢复加速
          let handedOff = false;
          try {
            if (captureBody) {
              await captureBody.finish();
              if (captureBody.file) {
                // 正文已经边收边转发；ZIP 解压/答案提取可能很慢，必须先把
                // 响应结束标记交给客户端，否则安卓端会等不到响应结束而超时
                // 重下（表现就是 ZIP 一直重新下载、永远下不完）。
                handedOff = true;
                callback();
                this.finishStreamedCapture(captureBody, requestInfo, fullUrl, requestTruncated ? null : { ...requestInfo, requestBody: learningRequestBody })
                  .catch(error => moduleLog.error('处理大响应失败:', error))
                  .finally(() => releaseCapture().catch(error => moduleLog.warn('清理响应捕获失败：', error)));
                return;
              }
            }

            const textual = this.isTextualContentType(requestInfo.contentType);
            let buffer, text = '', decompressFailed = false;
            if (replacement) {
              responseBody = [];
              buffer = Buffer.alloc(0);
            } else {
              ({ buffer, text, decompressFailed } = await this.decompressBuffer(captureBody ? captureBody.buffer() : Buffer.concat(responseBody), requestInfo.contentEncoding, textual));
              responseBody = [];
            }
            if (decompressFailed && responseBodyRules.some(type => [1, 2, 4].includes(type))) throw new Error('响应解压失败，无法安全改写');
            if (responseBodyRules.includes(2)) {
              buffer = await this.injection.applyZipImplantRules(fullUrl, buffer);
              // 注入规则在两步之间失效（例如 maxTriggers）时仍按 onResponse 的
              // 快照交付完整包，避免发出一个空响应。
              if (replacement && (!buffer || buffer.length === 0)) buffer = await fs.readFile(replacement.path);
            }
            if (responseBodyRules.includes(4)) {
              buffer = replacement
                ? await fs.readFile(replacement.path)
                : await this.injection.applyDynamicInjectRules(fullUrl, buffer);
            }
            if (responseBodyRules.includes(1)) {
              buffer = this.contentChange.applyContentChangeRules(fullUrl, buffer, requestInfo.contentType);
            }
            if (replacement && buffer.length !== replacement.size) {
              // 声明了 Content-Length 却对不上：宁可断开让客户端重试，也不能
              // 发一个看似完整、实际截断的 ZIP。
              moduleLog.error(`注入包长度变化（${replacement.size} → ${buffer.length}），中断本次响应`);
              handedOff = true;
              ctx.proxyToClientResponse.destroy();
              return callback();
            }
            if (responseBodyRules.some(type => [1, 2, 4].includes(type))) {
              const response = ctx.proxyToClientResponse;
              const wrote = response.write(buffer);
              // 原生传输层写失败时必须断开：继续补 chunked 结束块会让客户端
              // 把截断正文当成完整响应。桌面版 `write()` 返回 false 只是背压，
              // 用 `nativeTransport` 区分（Node 的 ServerResponse 没有该字段）。
              if (wrote === false && response.nativeTransport) {
                moduleLog.error(`向客户端写入响应失败，已断开连接（${buffer.length} 字节）`);
                handedOff = true;
                response.destroy();
                return callback();
              }
              if (textual) text = buffer.toString('utf8');
            }

            // 先结束响应，再在后台做记录、ZIP 解压和答案提取。
            handedOff = true;
            callback();
            this.finishBufferedResponse({
              buffer, text, decompressFailed, requestInfo, fullUrl,
              learningRequestBody, requestTruncated, responseBodyRules,
            })
              .catch(error => moduleLog.error('处理响应记录失败:', error))
              .finally(() => releaseCapture().catch(error => moduleLog.warn('清理响应捕获失败：', error)));
            return;
          } catch (error) {
            moduleLog.error('处理响应失败:', error);
            return callback(error);
          } finally {
            if (!handedOff) await releaseCapture().catch(error => moduleLog.warn('清理响应捕获失败：', error));
          }
        })
        return callback();
      });

      this.proxy.listen({ host: '127.0.0.1', port: this.proxyPort }, error => error ? reject(error) : resolve());
    });
  }
};
