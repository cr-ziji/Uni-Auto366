const moduleLog = require('../logging').create('答案');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ipcMain = require('../register').forModule('answers');

/**
 * 把上传失败翻译成用户能处理的话。
 *
 * `ECONNRESET` 在 TLS 握手阶段出现时（一个字节的响应都没收到），几乎都是网络
 * 层面按域名重置了连接，而不是 Supabase 的问题：重试多少次都一样，换域名或
 * 开代理才行。直接抛 “connect reset” 只会让用户以为是自己点错了。
 */
function describeShareError(error) {
  const message = String(error?.message || '');
  const code = String(error?.code || '');
  const blocked =
    error?.blocked === true ||
    code === 'ECONNRESET' ||
    /connection reset|connect reset|ECONNRESET|handshake/i.test(message);
  if (blocked) {
    return (
      '无法连接分享服务器：TLS 连接被中断。' +
      '通常是当前网络对 supabase.co 的屏蔽（换 Wi-Fi / 开代理后重试）。' +
      '也可以在配置里把 share-supabase-url 指向可用的反向代理。'
    );
  }
  return `上传失败: ${message || '未知错误'}`;
}

module.exports = function register({ supabase, bucket = 'auto366-share' } = {}) {
  if (!supabase) {
    const { createClient } = require('@supabase/supabase-js');
    const config = require('../config');
    // 换域名的开关：`share-supabase-url` 可以指向自建的反向代理（或 Supabase 的
    // 自定义域名）。部分网络会按 SNI 重置到 `*.supabase.co` 的 TLS 握手，此时
    // 换个域名是唯一不改服务器代码的解法。
    const SUPABASE_URL = config.get('share-supabase-url') || 'https://myenzpblosjnrtvicdor.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15ZW56cGJsb3NqbnJ0dmljZG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5NjAxMzAsImV4cCI6MjA4MzUzNjEzMH0.XkwQ72RmH8l1_krYc_IdPXsFk5pwL5JXQ3mDZ-ax3mU';
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
ipcMain.handle('share-answer-file', async (event, filePath) => {
      try {
        if (!fs.existsSync(filePath)) {
          return { success: false, error: '文件不存在' };
        }
        const fileName = path.basename(filePath);
        const fileExtension = path.extname(fileName);
        const timestamp = Date.now();
        const randomId = uuidv4().substring(0, 8);
        const uniqueFileName = `${timestamp}_${randomId}${fileExtension}`;
        const fileBuffer = await fs.readFile(filePath);
        const { data, error } = await supabase.storage
          .from(bucket)
          .upload(uniqueFileName, fileBuffer, {
            contentType: 'application/json',
            upsert: false
          });
        if (error) {
          moduleLog.error('Supabase 上传错误:', error);
          return {
            success: false,
            error: describeShareError(error)
          };
        }
        const { data: urlData } = supabase.storage
          .from(bucket)
          .getPublicUrl(uniqueFileName);
        if (!urlData || !urlData.publicUrl) {
          return {
            success: false,
            error: '获取下载链接失败'
          };
        }
        return {
          success: true,
          fileId: data.path,
          downloadUrl: urlData.publicUrl
        };
      } catch (error) {
        moduleLog.error('分享答案文件失败:', error);
        return {
          success: false,
          error: describeShareError(error)
        };
      }
    });

};
