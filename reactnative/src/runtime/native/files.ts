/**
 * Native file picker / opener (`Auto366Files` on Android).
 *
 * The desktop build uses `dialog.showOpenDialog`, `dialog.showSaveDialog` and
 * `shell.openPath`, which the Electron shims cannot emulate with JavaScript
 * alone. This module wraps the native counterpart; every function degrades to
 * "not available" when the module is missing (iOS, tests, Expo Go), so the
 * shims keep the previous behaviour instead of crashing.
 */
import {NativeModules} from 'react-native';

interface PickedFile {
  path: string;
  name: string;
  size: number;
  uri?: string;
}

interface SaveTarget {
  uri: string;
  name: string;
}

interface FilesModule {
  pickFiles(options: {multiple?: boolean}): Promise<PickedFile[]>;
  pickSaveTarget(fileName: string, mimeType?: string | null): Promise<SaveTarget | null>;
  writeToUri(uri: string, base64: string): Promise<boolean>;
  saveToDownloads(path: string, fileName: string, mimeType?: string | null): Promise<string>;
  openFile(path: string, mimeType?: string | null): Promise<boolean>;
  shareFile(path: string, mimeType?: string | null): Promise<boolean>;
}

const MODULE_NAME = 'Auto366Files';

function filesModule(): FilesModule | null {
  const instance = (NativeModules as any)[MODULE_NAME] as FilesModule | undefined;
  return instance ?? null;
}

/** `true` when the native picker is available on this platform. */
export function isFilePickerAvailable(): boolean {
  return !!filesModule();
}

/** Opens the document picker; the picked files are copied into the app cache. */
export async function pickFiles(options?: {multiple?: boolean}): Promise<PickedFile[]> {
  const native = filesModule();
  if (!native) {
    return [];
  }
  const picked = await native.pickFiles({multiple: options?.multiple === true});
  return Array.isArray(picked) ? picked : [];
}

/**
 * Save targets that were chosen through the system dialog.
 *
 * `fs` writes into the app sandbox (that is the only place a `file://` path is
 * writable), so the bytes still have to be copied into the `content://` URI the
 * user picked. The copy happens in `fs.persistFile` through
 * {@link flushPendingSave}, which keeps the desktop contract of
 * `dialog.showSaveDialog` ("pick a path, then write it") intact.
 */
const pendingSaves = new Map<string, string>();

/** Remembers the destination URI of a local path (see {@link pickSaveTarget}). */
export function registerSaveTarget(localPath: string, uri: string): void {
  pendingSaves.set(localPath, uri);
}

/** The pending destination of a path, if any. */
export function getSaveTarget(localPath: string): string | undefined {
  return pendingSaves.get(localPath);
}

/**
 * Copies freshly persisted bytes into the chosen `content://` URI.
 *
 * Returns `true` when a target was pending (the caller keeps the sandbox copy
 * either way, `shell.openPath` can still open it).
 */
export async function flushPendingSave(localPath: string, bytes: Buffer): Promise<boolean> {
  const uri = pendingSaves.get(localPath);
  if (!uri) {
    return false;
  }
  const native = filesModule();
  if (!native) {
    pendingSaves.delete(localPath);
    return false;
  }
  try {
    await native.writeToUri(uri, bytes.toString('base64'));
    pendingSaves.delete(localPath);
    return true;
  } catch (error) {
    pendingSaves.delete(localPath);
    console.warn(`[e2rn] could not write the save target for "${localPath}"`, error);
    return false;
  }
}

/** Opens the system "create document" dialog. */
export async function pickSaveTarget(
  fileName: string,
  mimeType?: string | null,
): Promise<SaveTarget | null> {
  const native = filesModule();
  if (!native) {
    return null;
  }
  return native.pickSaveTarget(fileName, mimeType ?? null);
}

/** Opens a sandbox file with whatever app the user picks. */
export async function openFile(path: string, mimeType?: string | null): Promise<boolean> {
  const native = filesModule();
  if (!native) {
    return false;
  }
  return native.openFile(path, mimeType ?? null);
}

/** Shares a sandbox file through the system share sheet. */
export async function shareFile(path: string, mimeType?: string | null): Promise<boolean> {
  const native = filesModule();
  if (!native) {
    return false;
  }
  return native.shareFile(path, mimeType ?? null);
}

/** Copies a sandbox file into the public `Download/Auto366` folder. */
export async function saveToDownloads(
  path: string,
  fileName: string,
  mimeType?: string | null,
): Promise<string> {
  const native = filesModule();
  if (!native) {
    throw new Error('[e2rn] saving to Downloads is not supported on this platform');
  }
  return native.saveToDownloads(path, fileName, mimeType ?? null);
}

export default {
  isFilePickerAvailable,
  pickFiles,
  pickSaveTarget,
  registerSaveTarget,
  getSaveTarget,
  flushPendingSave,
  openFile,
  shareFile,
  saveToDownloads,
};
