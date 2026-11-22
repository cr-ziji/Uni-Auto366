/**
 * `dialog` - the Electron dialog shim.
 *
 * The file dialogs are backed by the native picker (`Auto366Files`): picking a
 * file opens the system document picker and copies the result into the app
 * cache, saving opens the system "create document" dialog and remembers the
 * destination, so the bytes a caller writes into the sandbox are relayed there
 * (see `fs.persistFile`). Message boxes use React Native `Alert`.
 *
 * When the native module is not available (older builds, tests) everything
 * degrades to "cancelled", which the ported desktop code already handles.
 */
import {Alert} from 'react-native';

import {fileDirectory} from '../../runtime/paths';
import {
  isFilePickerAvailable,
  pickFiles,
  pickSaveTarget,
  registerSaveTarget,
  saveToDownloads,
} from '../../runtime/native/files';
import {loadIntoMirror} from '../../polyfills/node/fs';

export interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  title?: string;
  message?: string;
  detail?: string;
  checkboxLabel?: string;
  [key: string]: any;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: Array<{name: string; extensions: string[]}>;
  properties?: string[];
  message?: string;
  [key: string]: any;
}

export interface SaveDialogOptions extends OpenDialogOptions {
  showsTagField?: boolean;
  [key: string]: any;
}

export interface MessageBoxResult {
  response: number;
  checkboxChecked: boolean;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
  filePaths: string[];
}

function messageOf(options: MessageBoxOptions | string, detail?: string): string {
  if (typeof options === 'string') {
    return detail ? `${options}\n${detail}` : options;
  }
  const parts = [options?.message, options?.detail].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : '';
}

/** Turns the `filters` of a dialog into a MIME type for the native picker. */
function mimeFromFilters(filters?: Array<{name: string; extensions: string[]}>): string {
  const extension = filters?.[0]?.extensions?.[0]?.toLowerCase();
  const byExtension: Record<string, string> = {
    zip: 'application/zip',
    json: 'application/json',
    txt: 'text/plain',
    log: 'text/plain',
    html: 'text/html',
    pdf: 'application/pdf',
    js: 'text/javascript',
    csv: 'text/csv',
  };
  return extension ? byExtension[extension] ?? '*/*' : '*/*';
}

/** Keeps a user supplied name usable as a file name. */
function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  return cleaned || fallback;
}

/** Base name of a desktop path (`C:\a\b.zip` / `/a/b.zip`). */
function baseNameOf(filePath: string | undefined): string {
  const segments = String(filePath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  return segments.pop() ?? '';
}

/** Directory of the virtual path (the save dialog only hands out such paths). */
const EXPORT_DIRECTORY = `${fileDirectory}/exports`;

export const dialog = {
  /** Shows a native alert; the button index becomes `response`. */
  async showMessageBox(options: MessageBoxOptions | string, detail?: string): Promise<MessageBoxResult> {
    const settings: MessageBoxOptions = typeof options === 'string' ? {message: options} : options ?? {};
    const buttons = settings.buttons && settings.buttons.length > 0 ? settings.buttons : ['确定'];
    const cancelId = typeof settings.cancelId === 'number' ? settings.cancelId : buttons.length - 1;
    const message = messageOf(options, detail);

    return new Promise<MessageBoxResult>(resolve => {
      let settled = false;
      const finish = (response: number) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({response, checkboxChecked: false});
      };
      Alert.alert(
        settings.title || 'Auto366',
        message,
        // Android renders at most three buttons; keep the label order.
        buttons.slice(0, 3).map((text, index) => ({
          text: String(text),
          onPress: () => finish(index),
        })),
        {cancelable: true, onDismiss: () => finish(cancelId)},
      );
    });
  },

  /** Synchronous variant - not possible with a native alert, picks the default. */
  showMessageBoxSync(options: MessageBoxOptions | string, detail?: string): number {
    console.warn(`[e2rn] dialog.showMessageBoxSync() falls back to the first button: ${messageOf(options, detail)}`);
    return typeof options === 'object' && typeof options.defaultId === 'number'
      ? options.defaultId
      : 0;
  },

  /** Shows an error box. */
  showErrorBox(title: string, content: string): void {
    console.error(`[e2rn] ${title}: ${content}`);
    Alert.alert(String(title || 'Auto366'), String(content ?? ''));
  },

  /** Opens the system document picker; the picked files land in the cache. */
  async showOpenDialog(options?: OpenDialogOptions): Promise<OpenDialogResult> {
    if (!isFilePickerAvailable()) {
      console.warn('[e2rn] dialog.showOpenDialog() is not available on this platform.');
      return {canceled: true, filePaths: []};
    }
    const properties = options?.properties ?? [];
    if (properties.includes('openDirectory')) {
      // Android's Storage Access Framework only hands out `content://` URIs
      // (not a writable path), and an iOS folder picked through the document
      // picker is security-scoped - neither can back the sandbox `fs`. Save
      // targets do support picking a folder, see `showSaveDialog` below.
      console.warn('[e2rn] picking a directory is not supported on mobile.');
      return {canceled: true, filePaths: []};
    }
    try {
      const picked = await pickFiles({multiple: properties.includes('multiSelections')});
      const filePaths = picked.map(entry => entry.path);
      // The ported code reads the selection with `readFileSync`, which only
      // sees the in-memory mirror - load the bytes in so that works.
      await Promise.all(filePaths.map(path => loadIntoMirror(path).catch(() => false)));
      return {canceled: filePaths.length === 0, filePaths};
    } catch (error) {
      console.error('[e2rn] dialog.showOpenDialog() failed', error);
      return {canceled: true, filePaths: []};
    }
  },

  /** Synchronous variant of {@link showOpenDialog} - not supported. */
  showOpenDialogSync(_options?: OpenDialogOptions): string[] | undefined {
    return undefined;
  },

  /**
   * Opens the system "create document" dialog.
   *
   * The returned path is inside the app sandbox (the only place the `fs` shim
   * can write to); the destination URI is remembered, so the bytes written to
   * that path are relayed into the document the user picked.
   */
  async showSaveDialog(options?: SaveDialogOptions): Promise<SaveDialogResult> {
    if (!isFilePickerAvailable()) {
      console.warn('[e2rn] dialog.showSaveDialog() is not available on this platform.');
      return {canceled: true, filePath: undefined, filePaths: []};
    }
    const suggested = safeFileName(
      baseNameOf(options?.defaultPath) || options?.title,
      'export.bin',
    );
    try {
      const target = await pickSaveTarget(suggested, mimeFromFilters(options?.filters));
      if (!target) {
        return {canceled: true, filePath: undefined, filePaths: []};
      }
      const localPath = `${EXPORT_DIRECTORY}/${safeFileName(target.name, suggested)}`;
      registerSaveTarget(localPath, target.uri);
      return {canceled: false, filePath: localPath, filePaths: [localPath]};
    } catch (error) {
      console.error('[e2rn] dialog.showSaveDialog() failed', error);
      return {canceled: true, filePath: undefined, filePaths: []};
    }
  },

  /** Synchronous variant of {@link showSaveDialog} - not supported. */
  showSaveDialogSync(_options?: SaveDialogOptions): string | undefined {
    return undefined;
  },
};

export default dialog;

/** Copies a sandbox file into the public Downloads folder (mobile only). */
export async function exportToDownloads(
  path: string,
  fileName?: string,
): Promise<string | null> {
  if (!isFilePickerAvailable()) {
    return null;
  }
  const name = safeFileName(fileName || baseNameOf(path), 'export.bin');
  return saveToDownloads(path, name);
}
