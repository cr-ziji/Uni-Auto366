/**
 * `BrowserWindow` - the Electron window shim.
 *
 * On the desktop a `BrowserWindow` owns a Chromium renderer. On React Native
 * the renderer is a `react-native-webview`, therefore the shim only keeps the
 * *state* of the window (bounds, visibility, title, ...) inside the window
 * store and lets `src/components/WindowManager` materialise the WebView.
 */
import {windowStore} from '../../runtime/windowStore';
import {getAssetServerBaseUrl, getAssetUrl} from '../../runtime/web/assetServer';
import {registerWebContents, unregisterWebContents, WebContents} from './webContents';

/** Virtual root of the bundled application (`app.getAppPath()`). */
export const APP_ROOT = '/app';

export interface WebPreferences {
  preload?: string;
  contextIsolation?: boolean;
  nodeIntegration?: boolean;
  enableRemoteModule?: boolean;
  sandbox?: boolean;
  webviewTag?: boolean;
  [key: string]: any;
}

export interface BrowserWindowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  title?: string;
  show?: boolean;
  frame?: boolean;
  transparent?: boolean;
  resizable?: boolean;
  movable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  fullscreenable?: boolean;
  fullscreen?: boolean;
  alwaysOnTop?: boolean;
  backgroundColor?: string;
  icon?: string;
  autoHideMenuBar?: boolean;
  skipTaskbar?: boolean;
  center?: boolean;
  type?: string;
  parent?: BrowserWindow;
  webPreferences?: WebPreferences;
  [key: string]: any;
}

type WindowListener = (...args: any[]) => void;

/** Normalises a virtual path and resolves `.` / `..` segments. */
export function normalizeVirtualPath(filePath: string): string {
  let value = String(filePath ?? '').replace(/\\/g, '/');
  value = value.replace(/^file:\/\//i, '');
  const segments = value.split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      result.pop();
      continue;
    }
    result.push(segment);
  }
  const normalized = `/${result.join('/')}`;
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

/** Path of a virtual file relative to the application root. */
export function toAssetPath(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  if (normalized.startsWith(`${APP_ROOT}/`)) {
    return normalized.slice(APP_ROOT.length + 1);
  }
  if (normalized === APP_ROOT) {
    return 'index.html';
  }
  return normalized.replace(/^\/+/, '');
}

/** Builds the `file://` URL of a virtual path. */
export function toFileUrl(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

let windowCounter = 0;

export class BrowserWindow {
  /** Numeric id - Electron uses it to identify the window. */
  readonly id: number;
  /** Id of the window inside the window store. */
  readonly windowId: string;
  /** The renderer of the window. */
  readonly webContents: WebContents;

  private readonly listeners = new Map<string, Set<WindowListener>>();
  private destroyed = false;
  /** `true` after the `ready-to-show` event was emitted. */
  readyToShowEmitted = false;
  private readonly options: BrowserWindowOptions;

  constructor(options: BrowserWindowOptions = {}) {
    this.options = options;
    windowCounter += 1;
    this.id = windowCounter;
    this.windowId = String(this.id);

    const bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 1400,
      height: options.height ?? 900,
    };

    windowStore.createWindow({
      id: this.windowId,
      title: options.title ?? '',
      url: '',
      visible: options.show ?? true,
      bounds,
      resizable: options.resizable ?? true,
      movable: options.movable ?? true,
      alwaysOnTop: options.alwaysOnTop ?? false,
      maximized: false,
      minimized: false,
      focused: options.show ?? true,
      windowMode: options.fullscreen ? 'fullscreen' : 'desktop',
    });

    this.webContents = new WebContents(this.windowId);
    registerWebContents(this.webContents);
    registerWindow(this);
  }

  // ---------------------------------------------------------------- events

  on(event: string, listener: WindowListener): this {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener);
    return this;
  }

  once(event: string, listener: WindowListener): this {
    const wrapper = (...args: any[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, listener: WindowListener): this {
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
    if (!bucket || bucket.size === 0) {
      return false;
    }
    for (const listener of Array.from(bucket)) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[e2rn] BrowserWindow listener for "${event}" failed`, error);
      }
    }
    return true;
  }

  // --------------------------------------------------------------- loading

  /** Loads a page of the bundled web assets. */
  async loadFile(filePath: string, _options?: any): Promise<void> {
    if (this.destroyed) {
      throw new Error('[e2rn] Cannot load a file in a destroyed window');
    }
    const virtualPath = normalizeVirtualPath(filePath);
    const assetPath = toAssetPath(virtualPath);
    const url = toFileUrl(virtualPath);
    this.webContents.setURL(url);
    windowStore.updateWindow(this.windowId, {
      url,
      assetPath,
      servedUrl: getAssetServerBaseUrl() ? getAssetUrl(assetPath) : undefined,
      loaded: false,
    });
  }

  /** Loads an arbitrary URL (`http:`, `https:`, `data:`, ...). */
  async loadURL(url: string, _options?: any): Promise<void> {
    if (this.destroyed) {
      throw new Error('[e2rn] Cannot load a URL in a destroyed window');
    }
    const target = String(url ?? '');
    const isRemote = /^(https?|data|file|blob):/i.test(target);
    this.webContents.setURL(target);
    windowStore.updateWindow(this.windowId, {
      url: isRemote ? target : toFileUrl(target),
      assetPath: isRemote ? undefined : toAssetPath(target),
      servedUrl: target,
      loaded: false,
    });
  }

  /** The URL that is currently loaded. */
  getURL(): string {
    return this.webContents.getURL();
  }

  // -------------------------------------------------------------- lifetime

  show(): void {
    if (this.destroyed) {
      return;
    }
    windowStore.setVisible(this.windowId, true);
    windowStore.setMinimized(this.windowId, false);
    this.focus();
  }

  showInactive(): void {
    windowStore.setVisible(this.windowId, true);
  }

  hide(): void {
    windowStore.setVisible(this.windowId, false);
  }

  focus(): void {
    if (this.destroyed) {
      return;
    }
    windowStore.focusWindow(this.windowId);
  }

  blur(): void {
    windowStore.updateWindow(this.windowId, {focused: false});
  }

  minimize(): void {
    windowStore.setMinimized(this.windowId, true);
    windowStore.setVisible(this.windowId, false);
    this.emit('minimize');
  }

  restore(): void {
    windowStore.setMinimized(this.windowId, false);
    windowStore.setVisible(this.windowId, true);
  }

  maximize(): void {
    windowStore.setMaximized(this.windowId, true);
    windowStore.setVisible(this.windowId, true);
    this.emit('maximize');
  }

  unmaximize(): void {
    windowStore.setMaximized(this.windowId, false);
    this.emit('unmaximize');
  }

  toggleMaximize(): void {
    if (this.isMaximized()) {
      this.unmaximize();
    } else {
      this.maximize();
    }
  }

  close(): void {
    if (this.destroyed) {
      return;
    }
    this.emit('close');
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    windowStore.removeWindow(this.windowId);
    unregisterWebContents(this.windowId);
    this.webContents.destroy();
    this.emit('closed');
    this.removeAllListeners();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return windowStore.getWindow(this.windowId)?.visible ?? false;
  }

  isFocused(): boolean {
    return windowStore.getWindow(this.windowId)?.focused ?? false;
  }

  isMinimized(): boolean {
    return windowStore.getWindow(this.windowId)?.minimized ?? false;
  }

  isMaximized(): boolean {
    return windowStore.getWindow(this.windowId)?.maximized ?? false;
  }

  isFullScreen(): boolean {
    return (windowStore.getWindow(this.windowId)?.windowMode ?? 'desktop') === 'fullscreen';
  }

  setFullScreen(flag: boolean): void {
    windowStore.setWindowMode(this.windowId, flag ? 'fullscreen' : 'desktop');
  }

  isResizable(): boolean {
    return windowStore.getWindow(this.windowId)?.resizable ?? true;
  }

  isMovable(): boolean {
    return windowStore.getWindow(this.windowId)?.movable ?? true;
  }

  // ---------------------------------------------------------------- bounds

  getBounds(): {x: number; y: number; width: number; height: number} {
    const window = windowStore.getWindow(this.windowId);
    return window ? {...window.bounds} : {x: 0, y: 0, width: 0, height: 0};
  }

  getContentBounds(): {x: number; y: number; width: number; height: number} {
    return this.getBounds();
  }

  getSize(): [number, number] {
    const bounds = this.getBounds();
    return [bounds.width, bounds.height];
  }

  getPosition(): [number, number] {
    const bounds = this.getBounds();
    return [bounds.x, bounds.y];
  }

  setBounds(bounds: Partial<{x: number; y: number; width: number; height: number}>): void {
    windowStore.setBounds(this.windowId, bounds ?? {});
  }

  setSize(width: number, height: number): void {
    windowStore.setBounds(this.windowId, {width, height});
  }

  getContentSize(): [number, number] {
    return this.getSize();
  }

  setContentSize(width: number, height: number): void {
    this.setSize(width, height);
  }

  setPosition(x: number, y: number): void {
    windowStore.setBounds(this.windowId, {x, y});
  }

  /** The window is always centered by the React Native layout. */
  center(): void {
    this.emit('move');
  }

  setAlwaysOnTop(flag: boolean): void {
    windowStore.setAlwaysOnTop(this.windowId, flag);
  }

  isAlwaysOnTop(): boolean {
    return windowStore.getWindow(this.windowId)?.alwaysOnTop ?? false;
  }

  // ----------------------------------------------------------------- title

  getTitle(): string {
    return windowStore.getWindow(this.windowId)?.title ?? '';
  }

  setTitle(title: string): void {
    windowStore.setTitle(this.windowId, title);
  }

  // ----------------------------------------------------------------- menu

  setMenu(_menu: any): void {
    // There is no native menu on React Native.
  }

  setMenuBarVisibility(_visible: boolean): void {
    // No-op.
  }

  setAutoHideMenuBar(_autoHide: boolean): void {
    // No-op.
  }

  setSkipTaskbar(_skip: boolean): void {
    // No-op.
  }

  setBackgroundColor(_color: string): void {
    // No-op.
  }

  setOpacity(_opacity: number): void {
    // No-op.
  }

  moveTop(): void {
    this.focus();
  }

  getOwnerBrowserWindows(): BrowserWindow[] {
    return [];
  }

  getParentWindow(): BrowserWindow | null {
    return (this.options.parent as BrowserWindow) ?? null;
  }

  /** The options the window was created with. */
  getOptions(): BrowserWindowOptions {
    return this.options;
  }

  // --------------------------------------------------------------- statics

  /** Every window that was created and not destroyed yet. */
  static getAllWindows(): BrowserWindow[] {
    return instances.slice();
  }

  /** Looks a window up by the id of its renderer. */
  static fromWebContents(contents: WebContents): BrowserWindow | null {
    if (!contents) {
      return null;
    }
    return instances.find(instance => instance.webContents === contents) ?? null;
  }

  /** The window that currently has the focus. */
  static getFocusedWindow(): BrowserWindow | null {
    const state = windowStore.getState();
    if (!state.focusedId) {
      return null;
    }
    return instances.find(instance => instance.windowId === state.focusedId) ?? null;
  }
}

const instances: BrowserWindow[] = [];

/**
 * Notifies the window that its page finished loading.
 *
 * Called by the React Native window component as soon as the WebView
 * reported `onLoadEnd`.
 */
export function notifyWindowLoaded(windowId: string): void {
  const id = String(windowId);
  windowStore.markLoaded(id);
  const instance = instances.find(entry => entry.windowId === id);
  if (!instance) {
    return;
  }
  instance.webContents.setLoading(false);
  instance.webContents.emit('did-finish-load');
  instance.webContents.emit('dom-ready');
  if (!instance.readyToShowEmitted) {
    instance.readyToShowEmitted = true;
    instance.emit('ready-to-show');
  }
}

// Register every created window.

/** Adds a window to the registry (used by the constructor). */
export function registerWindow(instance: BrowserWindow): void {
  if (!instances.includes(instance)) {
    instances.push(instance);
  }
}

export function unregisterWindow(instance: BrowserWindow): void {
  const index = instances.indexOf(instance);
  if (index >= 0) {
    instances.splice(index, 1);
  }
}

export default BrowserWindow;
