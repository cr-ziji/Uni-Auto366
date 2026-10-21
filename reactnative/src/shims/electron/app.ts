/**
 * `app` - the Electron application lifecycle, mapped onto the React Native
 * application lifecycle.
 *
 * The ported desktop code uses `app.whenReady()`, `app.on('activate' | ...)`,
 * `app.getPath()`, `app.getAppPath()` and `app.getVersion()`; everything the
 * desktop build would do with the real Electron app is emulated here.
 */
import {
  appDataDirectory,
  cacheDirectory,
  documentDirectory,
  fileDirectory,
  logsDirectory,
  temporaryDirectory,
  virtualAppRoot,
} from '../../runtime/paths';

/** Version of the ported application (kept in sync with package.json). */
export const APP_VERSION = '0.10.0';

/** Name of the ported application. */
export const APP_NAME = 'Auto366';

/** Virtual path of the (bundled) executable. */
export const EXECUTABLE_PATH = `${virtualAppRoot}/auto366`;

type AppListener = (...args: any[]) => void;

const listeners = new Map<string, Set<AppListener>>();
const pathOverrides = new Map<string, string>();
let resolveReady: () => void = () => {};
const readyPromise = new Promise<void>(resolve => {
  resolveReady = resolve;
});
let ready = false;
let quitRequested = false;

function emit(event: string, ...args: any[]): void {
  const set = listeners.get(event);
  if (!set) {
    return;
  }
  for (const listener of Array.from(set)) {
    try {
      listener(...args);
    } catch (error) {
      console.error(`[e2rn] app listener for "${event}" failed`, error);
    }
  }
}

export const app = {
  isPackaged: true,
  /** React Native has no installer / package metadata. */
  isReady(): boolean {
    return ready;
  },
  get quitRequested(): boolean {
    return quitRequested;
  },

  /** Resolves as soon as the runtime is up (immediately on mobile). */
  whenReady(): Promise<void> {
    return readyPromise;
  },

  on(event: string, listener: AppListener): typeof app {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
    return app;
  },

  once(event: string, listener: AppListener): typeof app {
    const wrapper = (...args: any[]) => {
      app.removeListener(event, wrapper);
      listener(...args);
    };
    return app.on(event, wrapper);
  },

  removeListener(event: string, listener: AppListener): typeof app {
    listeners.get(event)?.delete(listener);
    return app;
  },

  removeAllListeners(event?: string): typeof app {
    if (event === undefined) {
      listeners.clear();
    } else {
      listeners.delete(event);
    }
    return app;
  },

  emit(event: string, ...args: any[]): void {
    emit(event, ...args);
  },

  /**
   * Requests a graceful shutdown.
   *
   * Like in Electron the `before-quit` event can be prevented - the desktop
   * application uses that to run its cleanup routine first.
   */
  quit(): void {
    if (quitRequested) {
      return;
    }
    const event = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    emit('before-quit', event);
    if (event.defaultPrevented) {
      // The application asked to stay alive.
      return;
    }
    quitRequested = true;
    emit('will-quit');
    emit('quit');
  },

  /** Kills the application immediately. */
  exit(_code?: number): void {
    quitRequested = true;
    emit('quit');
  },

  /** There is no in-process equivalent of `app.relaunch()`. */
  relaunch(): void {
    console.warn('[e2rn] app.relaunch() is not supported on React Native.');
  },

  /**
   * Maps the Electron path names onto the React Native sandbox.
   *
   *  - `userData` / `appData` -> `<Documents>/.Auto366`
   *  - `home` / `documents` / `desktop` -> `<Documents>`
   *  - `temp` -> the system temporary directory
   *  - `logs` -> `<Documents>/.Auto366/logs`
   *  - `downloads` -> `<Documents>/.Auto366/file`
   *  - `cache` -> the system cache directory
   *  - `exe` / `execPath` -> the virtual executable
   */
  getPath(name: string): string {
    const override = pathOverrides.get(name);
    if (override) {
      return override;
    }
    switch (name) {
      case 'userData':
      case 'appData':
        return appDataDirectory;
      case 'home':
      case 'documents':
      case 'desktop':
        return documentDirectory;
      case 'temp':
        return temporaryDirectory;
      case 'logs':
        return logsDirectory;
      case 'downloads':
        return fileDirectory;
      case 'exe':
      case 'execPath':
        return EXECUTABLE_PATH;
      case 'cache':
        return cacheDirectory;
      case 'module':
        return virtualAppRoot;
      case 'resources':
        return `${virtualAppRoot}/resources`;
      default:
        return documentDirectory;
    }
  },

  /** Overrides one of the paths returned by {@link app.getPath}. */
  setPath(name: string, value: string): void {
    pathOverrides.set(name, value);
  },

  /**
   * The read-only root of the bundled application files (`/app`).
   *
   * The ported `modules/rules/loader.js` reads `<appPath>/rulesets` from
   * there, exactly like the desktop build reads it from the installation
   * directory.
   */
  getAppPath(): string {
    return virtualAppRoot;
  },

  getVersion(): string {
    return APP_VERSION;
  },

  getName(): string {
    return APP_NAME;
  },

  getLocale(): string {
    return 'zh-CN';
  },

  /** There is only ever one instance of the mobile application. */
  requestSingleInstanceLock(): boolean {
    return true;
  },

  /** No-op: there is no Windows taskbar identity on mobile. */
  setAppUserModelId(_id: string): void {
    // No-op.
  },

  /** No-op: the WebView does not use the GPU. */
  disableHardwareAcceleration(): void {
    // No-op.
  },

  /** No-op: there is no command line on mobile. */
  commandLine: {
    appendSwitch(): void {},
    appendArgument(): void {},
    hasSwitch(): boolean {
      return false;
    },
    getSwitchValue(): string {
      return '';
    },
  },

  /** No-op: the macOS dock does not exist on mobile. */
  dock: {
    hide(): void {},
    show(): void {},
    setBadge(): void {},
    getBadge(): string {
      return '';
    },
  },
};

/** Marks the application as ready - called by the RN bootstrap. */
export function markAppReady(): void {
  if (ready) {
    return;
  }
  ready = true;
  resolveReady();
  emit('ready');
}

/** Resets the quit state (used by the tests and by `app.relaunch()`). */
export function resetAppQuitState(): void {
  quitRequested = false;
}

export default app;
