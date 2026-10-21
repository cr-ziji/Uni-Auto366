/**
 * Stub for the desktop `electron-updater` package.
 *
 * The desktop build updates itself by downloading a GitHub release through
 * `electron-updater`. On Android / iOS the application is updated through the
 * app store, and an in-app updater would either be ignored by the platform or
 * break the code signature of the installed package.
 *
 * The stub therefore keeps the full API surface of `AppUpdater` (so that
 * `modules/app/update.js` runs unmodified) but reports that no update is
 * available:
 *
 *  - `checkForUpdates()` resolves and emits `update-not-available`,
 *  - `downloadUpdate()` rejects with an explanatory error,
 *  - `quitAndInstall()` is a no-op.
 *
 * `modules/app/update.js` shows the result of the check in the UI, so the
 * user sees "already up to date" instead of an error.
 */
import {EventEmitter} from 'events';

export interface FeedURLOptions {
  provider?: string;
  owner?: string;
  repo?: string;
  channel?: string;
  url?: string;
  [key: string]: any;
}

export interface UpdateInfo {
  version?: string;
  releaseDate?: string;
  releaseName?: string;
  [key: string]: any;
}

export class AppUpdater extends EventEmitter {
  /** The desktop build disables the automatic download. */
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowDowngrade = false;
  allowPrerelease = false;
  /** The desktop build assigns a custom logger. */
  logger: any = null;

  private feed: FeedURLOptions | null = null;

  setFeedURL(options: FeedURLOptions): void {
    this.feed = options ? {...options} : null;
  }

  getFeedURL(): FeedURLOptions | null {
    return this.feed;
  }

  /**
   * There is no in-app updater on mobile - the store takes care of it.
   *
   * The `update-not-available` event is emitted asynchronously so that the
   * desktop code can register its listeners first.
   */
  async checkForUpdates(): Promise<any> {
    setTimeout(() => {
      this.emit('update-not-available', {version: ''} as UpdateInfo);
    }, 0);
    return {
      updateInfo: null,
      cancellationToken: null,
      downloadPromise: Promise.resolve([]),
      updateNotAvailable: true,
    };
  }

  async downloadUpdate(): Promise<any> {
    throw new Error(
      '[E2RN] 应用内自动更新在移动端不可用，请通过应用商店更新应用。',
    );
  }

  quitAndInstall(_isSilent?: boolean, _isForceRunAfter?: boolean): void {
    console.log('[E2RN] 应用内自动更新在移动端不可用，已忽略 quitAndInstall()。');
  }
}

export const autoUpdater = new AppUpdater();

export default {autoUpdater};
