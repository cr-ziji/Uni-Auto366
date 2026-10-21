/**
 * `webContents` - the Electron renderer-process handle.
 *
 * The "renderer" is a `react-native-webview` instance instead of a Chromium
 * frame, therefore every message is routed through the WebView bridge
 * (`src/runtime/WindowManagerBridge.ts`).
 */
import {deliverToWebView} from '../../runtime/WindowManagerBridge';
import {getWebView} from '../../runtime/webviewRegistry';

export type WebContentsListener = (...args: any[]) => void;

export interface SessionStub {
  [key: string]: any;
}

/** Minimal `session` stub - there is no cookie / cache store on mobile. */
function createSessionStub(): SessionStub {
  return {
    clearCache: async () => {},
    clearStorageData: async () => {},
    flushStorageData: async () => {},
    cookies: {
      get: async () => [],
      set: async () => {},
      remove: async () => {},
      flushStore: async () => {},
    },
    webRequest: {
      onBeforeRequest: () => {},
    },
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  };
}

export class WebContents {
  /** Electron uses a numeric id for `webContents`. */
  readonly id: number;
  /** Id of the window that owns this renderer. */
  readonly windowId: string;

  private readonly listeners = new Map<string, Set<WebContentsListener>>();
  private url = '';
  private loading = false;
  private destroyed = false;
  private windowOpenHandler: ((details: any) => any) | null = null;

  readonly session: SessionStub = createSessionStub();

  constructor(windowId: string | number) {
    this.windowId = String(windowId);
    this.id = Number(this.windowId) || 0;
  }

  /** Sends an event to the page (the counterpart of `ipcRenderer.on`). */
  send(channel: string, ...args: any[]): boolean {
    if (this.destroyed) {
      return false;
    }
    return deliverToWebView(this.windowId, {type: 'event', channel, args});
  }

  /** Injects JavaScript into the page. */
  async executeJavaScript(code: string): Promise<any> {
    const webView = getWebView(this.windowId);
    if (!webView || typeof webView.injectJavaScript !== 'function') {
      throw new Error(`[e2rn] No WebView attached to window ${this.windowId}`);
    }
    webView.injectJavaScript(`(function(){try{${code}\n}catch(error){console.error("[e2rn] executeJavaScript failed", error);}})();`);
    // `react-native-webview` cannot return the result of the injected code.
    return undefined;
  }

  /** Injects a stylesheet into the page. */
  async insertCSS(css: string): Promise<any> {
    return this.executeJavaScript(
      `(function(){var style=document.createElement('style');style.textContent=${JSON.stringify(
        css,
      )};document.head.appendChild(style);return true;})();`,
    );
  }

  on(event: string, listener: WebContentsListener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: string, listener: WebContentsListener): this {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, listener: WebContentsListener): this {
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

  emit(event: string, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of Array.from(set)) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[e2rn] webContents listener for "${event}" failed`, error);
      }
    }
  }

  /** The URL of the page (the virtual `file://` URL). */
  getURL(): string {
    return this.url;
  }

  setURL(url: string): void {
    this.url = url;
  }

  /** Reloads the page. */
  reload(): void {
    const webView = getWebView(this.windowId);
    if (webView && typeof webView.reload === 'function') {
      webView.reload();
    }
  }

  reloadIgnoringCache(): void {
    this.reload();
  }

  stop(): void {
    this.loading = false;
  }

  isLoading(): boolean {
    return this.loading;
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }

  /** There is no devtools on a mobile WebView. */
  openDevTools(_options?: any): void {
    console.warn(
      '[e2rn] webContents.openDevTools() is not available on React Native. Use the React Native debugger instead.',
    );
  }

  closeDevTools(): void {
    // No-op on mobile.
  }

  /** Printing to PDF is a desktop-only capability. */
  async printToPDF(_options?: any): Promise<any> {
    throw new Error('printToPDF is not supported on mobile (React Native)');
  }

  /** Intercepts `window.open` calls. */
  setWindowOpenHandler(handler: ((details: any) => any) | null): void {
    this.windowOpenHandler = handler;
  }

  getWindowOpenHandler(): ((details: any) => any) | null {
    return this.windowOpenHandler;
  }

  setAudioMuted(_muted: boolean): void {
    // No-op.
  }

  isAudioMuted(): boolean {
    return true;
  }

  getZoomFactor(): number {
    return 1;
  }

  setZoomFactor(_factor: number): void {
    // No-op: the desktop scale transform is applied by the window component.
  }
}

/** Every `webContents` that was created so far. */
const instances = new Map<string, WebContents>();

/** Registers a `webContents` so that `webContents.fromId()` can find it. */
export function registerWebContents(contents: WebContents): void {
  instances.set(contents.windowId, contents);
}

/** Forgets a `webContents`. */
export function unregisterWebContents(windowId: string): void {
  instances.delete(String(windowId));
}

export const webContents = {
  /** All live renderers. */
  getAllWebContents(): WebContents[] {
    return Array.from(instances.values());
  },

  /** Looks a renderer up by its (numeric) id. */
  fromId(id: number | string): WebContents | null {
    return instances.get(String(id)) ?? null;
  },
};

export default webContents;
