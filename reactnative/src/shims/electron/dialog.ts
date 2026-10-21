/**
 * `dialog` - the Electron dialog shim.
 *
 * React Native has no native file picker or message box, therefore the
 * dialogs are resolved with the "cancelled" result. The desktop code already
 * handles a cancelled dialog, so the ported application keeps working.
 */

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

export const dialog = {
  /** Shows a message box - the user cannot interact with it on mobile. */
  async showMessageBox(options: MessageBoxOptions | string, detail?: string): Promise<MessageBoxResult> {
    console.warn(`[e2rn] dialog.showMessageBox() is not supported on mobile: ${messageOf(options, detail)}`);
    return {response: 0, checkboxChecked: false};
  },

  /** Synchronous variant of {@link showMessageBox}. */
  showMessageBoxSync(options: MessageBoxOptions | string, detail?: string): number {
    console.warn(`[e2rn] dialog.showMessageBoxSync() is not supported on mobile: ${messageOf(options, detail)}`);
    return 0;
  },

  /** Shows an error box - the message is written to the log instead. */
  showErrorBox(title: string, content: string): void {
    console.error(`[e2rn] ${title}: ${content}`);
  },

  /** Opens the file picker - always cancelled on mobile. */
  async showOpenDialog(_options?: OpenDialogOptions): Promise<OpenDialogResult> {
    console.warn('[e2rn] dialog.showOpenDialog() is not supported on mobile.');
    return {canceled: true, filePaths: []};
  },

  /** Synchronous variant of {@link showOpenDialog}. */
  showOpenDialogSync(_options?: OpenDialogOptions): string[] | undefined {
    return undefined;
  },

  /** Opens the save dialog - always cancelled on mobile. */
  async showSaveDialog(_options?: SaveDialogOptions): Promise<SaveDialogResult> {
    console.warn('[e2rn] dialog.showSaveDialog() is not supported on mobile.');
    return {canceled: true, filePath: undefined, filePaths: []};
  },

  /** Synchronous variant of {@link showSaveDialog}. */
  showSaveDialogSync(_options?: SaveDialogOptions): string | undefined {
    return undefined;
  },
};

export default dialog;
