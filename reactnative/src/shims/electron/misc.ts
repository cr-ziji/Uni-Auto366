/**
 * Remaining Electron APIs that are used by the ported application.
 *
 * Every module of this file is a small, dependency free stub: React Native
 * has no counterpart for menus, trays, notifications or protocol handlers, so
 * the shims keep the API surface (so that the original code does not crash)
 * without doing anything.
 */

type Listener = (...args: any[]) => void;

/** A tiny event emitter that is used by most of the stubs. */
export class SimpleEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return false;
    }
    for (const listener of Array.from(bucket)) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[e2rn] listener for "${event}" failed`, error);
      }
    }
    return true;
  }
}

// ------------------------------------------------------------- powerMonitor

export const powerMonitor = {
  on(event: string, listener: Listener): typeof powerMonitor {
    powerMonitorEvents.on(event, listener);
    return powerMonitor;
  },
  once(event: string, listener: Listener): typeof powerMonitor {
    powerMonitorEvents.once(event, listener);
    return powerMonitor;
  },
  removeListener(event: string, listener: Listener): typeof powerMonitor {
    powerMonitorEvents.removeListener(event, listener);
    return powerMonitor;
  },
  removeAllListeners(event?: string): typeof powerMonitor {
    powerMonitorEvents.removeAllListeners(event);
    return powerMonitor;
  },
  emit(event: string, ...args: any[]): boolean {
    return powerMonitorEvents.emit(event, ...args);
  },
};

const powerMonitorEvents = new SimpleEmitter();

// ----------------------------------------------------------- globalShortcut

const shortcuts = new Set<string>();

export const globalShortcut = {
  register(accelerator: string, _callback: Listener): boolean {
    if (!accelerator) {
      return false;
    }
    shortcuts.add(accelerator);
    console.warn(`[e2rn] globalShortcut.register("${accelerator}") is not supported on mobile.`);
    return true;
  },
  unregister(accelerator: string): void {
    shortcuts.delete(accelerator);
  },
  unregisterAll(): void {
    shortcuts.clear();
  },
  isRegistered(accelerator: string): boolean {
    return shortcuts.has(accelerator);
  },
};

// ------------------------------------------------------------------- Menu

export class Menu extends SimpleEmitter {
  constructor(_template?: any) {
    super();
  }

  static buildFromTemplate(template: any): Menu {
    const menu = new Menu(template);
    return menu;
  }

  static setApplicationMenu(_menu: Menu | null): void {
    // There is no native application menu on React Native.
  }

  static getApplicationMenu(): Menu | null {
    return null;
  }

  append(_item: any): void {
    // No-op.
  }

  popup(_options?: any): void {
    // No-op.
  }

  closePopup(): void {
    // No-op.
  }
}

// ------------------------------------------------------------------- Tray

export class Tray extends SimpleEmitter {
  readonly image: any;

  constructor(image: any) {
    super();
    this.image = image;
  }

  setToolTip(_tooltip: string): void {
    // No-op.
  }

  setContextMenu(_menu: Menu | null): void {
    // No-op.
  }

  setImage(_image: any): void {
    // No-op.
  }

  destroy(): void {
    this.removeAllListeners();
  }
}

// ----------------------------------------------------------- Notification

export class Notification extends SimpleEmitter {
  static isSupported(): boolean {
    return false;
  }

  constructor(_options: any) {
    super();
  }

  show(): void {
    console.warn('[e2rn] Notification.show() is not supported on mobile.');
  }

  close(): void {
    // No-op.
  }
}

// --------------------------------------------------------------- clipboard

let clipboardText = '';

export const clipboard = {
  writeText(text: string): void {
    clipboardText = String(text ?? '');
  },
  readText(): string {
    return clipboardText;
  },
  writeHTML(markup: string): void {
    clipboardText = String(markup ?? '');
  },
  readHTML(): string {
    return clipboardText;
  },
  writeImage(_image: any): void {
    // No-op.
  },
  readImage(): any {
    return null;
  },
  clear(): void {
    clipboardText = '';
  },
  availableFormats(): string[] {
    return ['text/plain'];
  },
};

// ---------------------------------------------------------------- session

function createSession(): any {
  return {
    clearCache: async () => {},
    clearStorageData: async () => {},
    flushStorageData: async () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    cookies: {
      get: async () => [],
      set: async () => {},
      remove: async () => {},
      flushStore: async () => {},
    },
    webRequest: {
      onBeforeRequest: () => {},
      onHeadersReceived: () => {},
    },
  };
}

export const session = {
  defaultSession: createSession(),
  fromPartition(partition: string): any {
    console.warn(`[e2rn] session.fromPartition("${partition}") is not supported on mobile.`);
    return createSession();
  },
};

// ------------------------------------------------------------ autoUpdater

export const autoUpdater = Object.assign(new SimpleEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  feedURL: undefined as any,
  setFeedURL(options: any): void {
    autoUpdater.feedURL = options;
  },
  setFeedOptions(options: any): void {
    autoUpdater.feedURL = options;
  },
  checkForUpdates(): Promise<any> {
    console.warn('[e2rn] autoUpdater.checkForUpdates() is not supported on mobile.');
    return Promise.resolve(null);
  },
  downloadUpdate(): Promise<any> {
    console.warn('[e2rn] autoUpdater.downloadUpdate() is not supported on mobile.');
    return Promise.resolve([]);
  },
  quitAndInstall(): void {
    console.warn('[e2rn] autoUpdater.quitAndInstall() is not supported on mobile.');
  },
});

// --------------------------------------------------------------- protocol

export const protocol = {
  registerFileProtocol(_scheme: string, _handler: any): void {
    console.warn('[e2rn] protocol.registerFileProtocol() is not supported on mobile.');
  },
  registerHttpProtocol(_scheme: string, _handler: any): void {
    console.warn('[e2rn] protocol.registerHttpProtocol() is not supported on mobile.');
  },
  registerStringProtocol(_scheme: string, _handler: any): void {
    console.warn('[e2rn] protocol.registerStringProtocol() is not supported on mobile.');
  },
  registerBufferProtocol(_scheme: string, _handler: any): void {
    console.warn('[e2rn] protocol.registerBufferProtocol() is not supported on mobile.');
  },
  registerStreamProtocol(_scheme: string, _handler: any): void {
    console.warn('[e2rn] protocol.registerStreamProtocol() is not supported on mobile.');
  },
  registerSchemesAsPrivileged(_schemes: any): void {
    // No-op.
  },
  unregisterProtocol(_scheme: string): void {
    // No-op.
  },
  handle(_scheme: string, _handler: any): void {
    // No-op.
  },
};

// ------------------------------------------------------ systemPreferences

export const systemPreferences = {
  getMediaAccessStatus(_kind: string): string {
    return 'unknown';
  },
  isDarkMode(): boolean {
    return false;
  },
  prefersReducedMotion(): boolean {
    return false;
  },
  prefersHighContrast(): boolean {
    return false;
  },
  getColor(_color: string): string {
    return '';
  },
  getSystemColor(_color: string): string {
    return '';
  },
};

// ---------------------------------------------------------------- webUtils

export const webUtils = {
  /** Returns the path of a `File` that was picked in the page. */
  getPathForFile(file: any): string {
    if (!file) {
      return '';
    }
    return String(file.path ?? file.name ?? '');
  },
};

// ---------------------------------------------------------- utilityProcess

export const utilityProcess = {
  fork(modulePath: string, _args?: string[], _options?: any): any {
    throw new Error(`[e2rn] utilityProcess.fork("${modulePath}") is not supported on mobile`);
  },
};
