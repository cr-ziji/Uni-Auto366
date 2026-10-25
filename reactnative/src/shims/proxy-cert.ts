/**
 * `modules/proxy/cert.js` 的移动端替身。
 *
 * 桌面版把 `node-mitm-proxy` 生成的根证书塞进 Windows 的受信任根证书库
 * （PowerShell / certutil）。移动端做不到这件事：
 *
 *  - App 不能静默写入系统证书库（需要用户确认，或 root）；
 *  - `child_process` 在 React Native 里不存在。
 *
 * 所以这里改成「导出 + 提示」：
 *
 *  - HTTPS 中间人用的**服务端**证书已经打进 APK（`res/raw/auto366_mitm.p12`，
 *    由 `scripts/generate-mitm-cert.js` 生成），代理不需要额外操作；
 *  - 客户端要信任的是同一张根证书，这里把它导出成 PEM 文件并给出安装路径，
 *    用户在「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」里手动安装即可。
 *
 * 接口与桌面版保持一致，`modules/proxy/index.js` 和 `main.js` 不需要改动。
 */
import path from 'path';
import fs from 'fs-extra';

import {CA_CERTIFICATE_FILE, CA_CERTIFICATE_PEM} from '../mitm/ca-certificate';

const MANUAL_HINT =
  '请在「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」中安装该文件';

class CertificateManager {
  /** 导出的根证书路径（`<documents>/.Auto366/Auto366-MITM-CA.pem`）。 */
  readonly certPath: string;

  constructor() {
    this.certPath = path.join(process.cwd(), CA_CERTIFICATE_FILE);
  }

  /** 把根证书写到磁盘，返回它的路径。 */
  async exportCertificate(): Promise<string> {
    await fs.ensureDir(path.dirname(this.certPath));
    await fs.writeFile(this.certPath, CA_CERTIFICATE_PEM, 'utf8');
    return this.certPath;
  }

  async certificateExists(): Promise<boolean> {
    try {
      await fs.access(this.certPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 桌面语义是「导入系统信任库」；移动端只能导出并提示手动安装。
   *
   * 返回 `success: false` 是刻意的：客户端此时**还没有**信任这张证书，
   * 只有用户装完之后 HTTPS 中间人才会真正生效。
   */
  async importCertificate(): Promise<{
    success: boolean;
    status: string;
    message?: string;
    error?: string;
    path?: string;
  }> {
    try {
      const exported = await this.exportCertificate();
      const message = `根证书已导出到 ${exported}，${MANUAL_HINT}`;
      console.log(`[证书] ${message}`);
      return {success: false, status: 'manual', message, path: exported};
    } catch (error: any) {
      const message = `根证书导出失败：${error?.message ?? error}`;
      console.error(`[证书] ${message}`);
      return {success: false, status: 'error', error: message};
    }
  }

  /** 兼容桌面 API：移动端不需要「检查是否已导入」。 */
  async isCertificateAlreadyImported(): Promise<boolean> {
    return false;
  }

  /** 兼容桌面 API：移动端没有可以写入的系统证书库。 */
  async addCertificateToStore(): Promise<{success: boolean; error?: string}> {
    const result = await this.importCertificate();
    return {success: false, error: result.message || result.error};
  }

  async forceImportCertificate(): Promise<{
    success: boolean;
    status: string;
    message?: string;
    error?: string;
  }> {
    return this.importCertificate();
  }

  /** 删除导出的证书文件（不影响已经打进 APK 的服务端证书）。 */
  async removeCertificate(): Promise<{success: boolean; message?: string; error?: string}> {
    try {
      await fs.remove(this.certPath);
      return {success: true, message: '导出的根证书已删除'};
    } catch (error: any) {
      return {success: false, error: error?.message ?? String(error)};
    }
  }

  async resetCertificate(): Promise<{
    success: boolean;
    deleted: number;
    imported: boolean;
    errors: string[];
    message?: string;
  }> {
    const removed = await this.removeCertificate();
    const result = await this.importCertificate();
    return {
      success: false,
      deleted: removed.success ? 1 : 0,
      imported: false,
      errors: result.error ? [result.error] : [],
      message: result.message,
    };
  }

  getCertificatePaths(): {certPath: string} {
    return {certPath: this.certPath};
  }

  registerIpcHandlers(): void {
    const reset = async () => {
      try {
        return await this.resetCertificate();
      } catch (error: any) {
        return {
          success: false,
          deleted: 0,
          imported: false,
          errors: [error?.message ?? String(error)],
        };
      }
    };
    // 与桌面版走同一个注册表（`<electronRoot>/modules/register.js` 原样打包）。
    const {forModule} = require('../../../modules/register');
    forModule('proxy').handle('reset-certificate', reset);
    forModule('app', {legacy: false}).handle('reset-certificate', reset);
  }
}

// `main.js` 用 CommonJS 引入：`const CertificateManager = require('./modules/proxy/cert')`。
module.exports = CertificateManager;
module.exports.default = CertificateManager;

export default CertificateManager;
