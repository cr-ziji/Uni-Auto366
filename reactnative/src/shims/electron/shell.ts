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

import {existsSync, statSync, unlink} from '../../polyfills/node/fs';
import {isFilePickerAvailable, openFile, shareFile} from '../../runtime/native/files';

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
        return 'opening a folder is not supported on mobile';
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
    void shareFile(target).catch(error =>
      console.warn(`[e2rn] shell.showItemInFolder("${target}") failed`, error),
    );
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
