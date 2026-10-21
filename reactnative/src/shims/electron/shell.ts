/**
 * `shell` - the Electron shell shim.
 *
 * `shell.openExternal()` is mapped onto the React Native `Linking` module,
 * every other function of the Electron shell API is a no-op.
 */
import {Linking} from 'react-native';

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

  /** Opens a file with the default handler of the device. */
  async openPath(_path: string): Promise<string> {
    console.warn('[e2rn] shell.openPath() is not supported on mobile.');
    // An empty string means "success" in the Electron API.
    return '';
  },

  /** Shows a file in the file manager. */
  showItemInFolder(_path: string): void {
    console.warn('[e2rn] shell.showItemInFolder() is not supported on mobile.');
  },

  /** Moves a file to the trash. */
  async trashItem(_path: string): Promise<void> {
    console.warn('[e2rn] shell.trashItem() is not supported on mobile.');
  },

  /** Plays the system beep. */
  beep(): void {
    // No-op.
  },
};

export default shell;
