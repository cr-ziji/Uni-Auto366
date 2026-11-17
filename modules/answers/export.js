const moduleLog = require('../logging').create('答案');
const registry = require('../register');

module.exports = function register({ files, windowManager }) {
    const exportPdf = async (e, htmlContent) => {
      try {
        if (!windowManager) {
          return { success: false, error: '窗口管理器未初始化' };
        }

        const pdfResult = await windowManager.exportHtmlToPdf(htmlContent);
        if (!pdfResult.success) {
          return { success: false, error: pdfResult.error };
        }

        // 移动端拿不到 PDF（见 `WindowManager.exportHtmlToPdf`），这种情况下
        // 落盘的是 HTML：扩展名与过滤器必须跟着变，否则用户会得到一份叫
        // `.pdf` 的 HTML 文件。
        const asHtml = pdfResult.format === 'html';
        const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filePath = await files.saveFileDialog({
          defaultPath: `answers_${stamp}.${asHtml ? 'html' : 'pdf'}`,
          filters: asHtml
            ? [{ name: 'HTML Files', extensions: ['html'] }]
            : [{ name: 'PDF Files', extensions: ['pdf'] }]
        });

        if (!filePath) {
          return { success: false, error: '用户取消保存' };
        }

        const payload = asHtml ? pdfResult.htmlBuffer : pdfResult.pdfBuffer;
        const writeOk = files.writeFile(filePath, payload);
        if (!writeOk) {
          return { success: false, error: asHtml ? '写入 HTML 文件失败' : '写入 PDF 文件失败' };
        }

        return { success: true, filePath, format: asHtml ? 'html' : 'pdf', note: pdfResult.note };
      } catch (error) {
        moduleLog.error('导出 PDF 失败:', error);
        return { success: false, error: error.message };
      }
    };
  registry.forModule('answers').handle('export-answers-pdf', exportPdf);
  // 兼容此前通用桥的 file 命名空间；业务实现只保留一处。
  registry.forModule('file', { legacy: false }).handle('export-answers-pdf', exportPdf);
};
