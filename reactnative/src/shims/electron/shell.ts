/**
 * `shell` - the Electron shell shim.
 *
 *  - `openExternal()` maps onto React Native `Linking`;
 *  - `openPath()` / `showItemInFolder()` hand a sandbox file to other apps
 *    through the native `FileProvider` (opening with the chosen app, or the
 *    share sheet when nothing can open it);
 *  - `trashItem()` deletes through the `fs` shim - mobile has no trash bin.
 */
import {Linking} from 'react-native';

import {existsSync, readdirSync, statSync, unlink} from '../../polyfills/node/fs';
import {isFilePickerAvailable, openFile, shareFile} from '../../runtime/native/files';

/**
 * Newest file inside a directory.
 *
 * A phone has no file-manager window, so "open the log folder" is served by
 * handing the most recent file to the share sheet. The log files are named
 * `auto366_<timestamp>.log`, so the lexicographic maximum is the newest one
 * (`readdirSync` returns its names sorted).
 */
function newestFileIn(directory: string): string | null {
  let names: string[];
  try {
    names = (readdirSync(directory) as string[])
      .filter(name => typeof name === 'string' && name.length > 0)
      .sort();
  } catch {
    return null;
  }
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const candidate = `${directory.replace(/\/+$/, '')}/${names[index]}`;
    try {
      if (statSync(candidate).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

/** Shares a file, reporting whether the share sheet was opened. */
async function sharePath(target: string): Promise<boolean> {
  if (!isFilePickerAvailable()) {
    return false;
  }
  try {
    return await shareFile(target);
  } catch (error) {
    console.warn(`[e2rn] could not share "${target}"`, error);
    return false;
  }
}

export const shell = {
  /** Opens an URL with the default handler of the device. */
  async openExternal(url: string): Promise<void> {
    const target = String(url ?? '');
    if (!target) {
      throw new Error('[e2rn] shell.openExternal() needs an URL');
    }
    try {
      await Linking.openURL(target);
    } catch (error) {
      console.error(`[e2rn] shell.openExternal("${target}") failed`, error);
      throw error;
    }
  },

  /**
   * Opens a file with the app the user picks.
   *
   * Electron returns an empty string on success and a message on failure - the
   * ported code relies on that, so failures are reported instead of thrown.
   */
  async openPath(path: string): Promise<string> {
    const target = String(path ?? '');
    if (!target) {
      return 'empty path';
    }
    if (!existsSync(target)) {
      return `file not found: ${target}`;
    }
    try {
      if (statSync(target).isDirectory()) {
        // "Open the log folder" is the only caller that passes a directory.
        // There is nothing to open on a phone, so share the newest file in it.
        const newest = newestFileIn(target);
        if (!newest) {
          // 空目录（或刚清理过缓存、还没有任何日志）并不是错误：手机上本来
          // 就没有文件管理器窗口可开。返回 '' 而不是错误文本，否则设置页会
          // 弹一条 “打开日志目录失败: folder is empty”，用户完全无从处理。
          console.info(`[e2rn] shell.openPath("${target}"): the folder has no file to share yet`);
          return '';
        }
        if (await sharePath(newest)) {
          return '';
        }
        // 原生分享面板不可用（例如 iOS 还没接）同样按“已处理”返回。
        return isFilePickerAvailable() ? 'could not share the file of this folder' : '';
      }
    } catch {
      // Fall through: try to open it anyway.
    }
    if (!isFilePickerAvailable()) {
      return 'opening files is not supported on this platform';
    }
    try {
      if (await openFile(target)) {
        return '';
      }
    } catch (error) {
      console.warn(`[e2rn] shell.openPath("${target}") could not find a viewer`, error);
    }
    try {
      // No app declared it can open the type: offer the share sheet instead,
      // the user can still save it or send it somewhere.
      if (await shareFile(target)) {
        return '';
      }
    } catch (error) {
      console.warn(`[e2rn] shell.openPath("${target}") could not share the file`, error);
    }
    return 'no application can open this file';
  },

  /** Shows a file in the file manager - the share sheet is the mobile equivalent. */
  showItemInFolder(path: string): void {
    const target = String(path ?? '');
    if (!target || !isFilePickerAvailable()) {
      return;
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(target).isDirectory();
    } catch {
      // Not in the mirror: treat it as a file.
    }
    const shared = isDirectory ? newestFileIn(target) : target;
    if (!shared) {
      return;
    }
    void sharePath(shared);
  },

  /** Moves a file to the trash - deleted directly, mobile has no trash bin. */
  async trashItem(path: string): Promise<void> {
    const target = String(path ?? '');
    if (!target) {
      return;
    }
    await unlink(target);
  },

  /** Plays the system beep. */
  beep(): void {
    // No-op.
  },
};

export default shell;
