/**
 * The state model of the E2RN window manager.
 *
 * Every `BrowserWindow` created through the Electron shim owns one entry in
 * this store. The React Native `WindowManager` observes the store and
 * materialises one `react-native-webview` per visible window.
 *
 * The store is a hand written, dependency free "zustand like" implementation:
 * a single immutable state object, a subscriber list and a `setState` that
 * replaces the state object (so `useSyncExternalStore` can rely on reference
 * equality).
 */

export type WindowMode = 'fullscreen' | 'desktop';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** Stable identifier (the numeric Electron window id as a string). */
  id: string;
  title: string;
  /**
   * Virtual URL of the page, e.g. `file:///app/index.html`.
   *
   * The WebView is served over HTTP, but the desktop code validates the
   * *sender* of an IPC message with `event.senderFrame.url` - it must look
   * like the original `file://` URL, therefore the virtual URL is kept.
   */
  url: string;
  /** URL the WebView actually loads (`http://127.0.0.1:<port>/index.html`). */
  servedUrl?: string;
  visible: boolean;
  bounds: WindowBounds;
  resizable: boolean;
  movable: boolean;
  alwaysOnTop: boolean;
  maximized: boolean;
  minimized: boolean;
  focused: boolean;
  windowMode: WindowMode;
  /** Path of the page inside the bundled web assets, e.g. `index.html`. */
  assetPath?: string;
  /** `true` once the WebView reported `onLoadEnd`. */
  loaded?: boolean;
}

export interface StoreState {
  windows: WindowState[];
  focusedId: string | null;
}

export interface CreateWindowOptions {
  id: string;
  title?: string;
  url?: string;
  servedUrl?: string;
  visible?: boolean;
  bounds?: Partial<WindowBounds>;
  resizable?: boolean;
  movable?: boolean;
  alwaysOnTop?: boolean;
  maximized?: boolean;
  minimized?: boolean;
  focused?: boolean;
  windowMode?: WindowMode;
  assetPath?: string;
}

export type StoreListener = (state: StoreState) => void;

export interface WindowStore {
  getState(): StoreState;
  setState(patch: Partial<StoreState> | ((state: StoreState) => Partial<StoreState>)): void;
  subscribe(listener: StoreListener): () => void;
  createWindow(options: CreateWindowOptions): WindowState;
  closeWindow(id: string): void;
  focusWindow(id: string): void;
  setBounds(id: string, bounds: Partial<WindowBounds>): void;
  setVisible(id: string, visible: boolean): void;
  setTitle(id: string, title: string): void;
  setAlwaysOnTop(id: string, value: boolean): void;
  setMaximized(id: string, value: boolean): void;
  setMinimized(id: string, value: boolean): void;
  setWindowMode(id: string, mode: WindowMode): void;
  markLoaded(id: string, loaded?: boolean): void;
  updateWindow(id: string, patch: Partial<WindowState>): void;
  removeWindow(id: string): void;
  getWindow(id: string): WindowState | undefined;
  getWindows(): WindowState[];
}

export const DEFAULT_WINDOW_BOUNDS: WindowBounds = {
  x: 0,
  y: 0,
  width: 1400,
  height: 900,
};

function createInitialState(): StoreState {
  return {windows: [], focusedId: null};
}

export function createWindowStore(): WindowStore {
  let state: StoreState = createInitialState();
  const listeners = new Set<StoreListener>();

  const notify = (): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(state);
      } catch (error) {
        console.error('[e2rn] window store listener failed', error);
      }
    }
  };

  const setState: WindowStore['setState'] = patch => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = {...state, ...next};
    notify();
  };

  const patchWindow = (id: string, patch: Partial<WindowState>): void => {
    let changed = false;
    const windows = state.windows.map(window => {
      if (window.id !== id) {
        return window;
      }
      changed = true;
      return {...window, ...patch};
    });
    if (!changed) {
      return;
    }
    const focusedId =
      patch.focused === true
        ? id
        : patch.focused === false && state.focusedId === id
        ? null
        : state.focusedId;
    setState({windows, focusedId});
  };

  const store: WindowStore = {
    getState(): StoreState {
      return state;
    },

    setState,

    subscribe(listener: StoreListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    createWindow(options: CreateWindowOptions): WindowState {
      const bounds: WindowBounds = {
        ...DEFAULT_WINDOW_BOUNDS,
        ...(options.bounds ?? {}),
      };
      const window: WindowState = {
        id: options.id,
        title: options.title ?? '',
        url: options.url ?? '',
        servedUrl: options.servedUrl,
        visible: options.visible ?? true,
        bounds,
        resizable: options.resizable ?? true,
        movable: options.movable ?? true,
        alwaysOnTop: options.alwaysOnTop ?? false,
        maximized: options.maximized ?? false,
        minimized: options.minimized ?? false,
        focused: options.focused ?? false,
        windowMode: options.windowMode ?? 'fullscreen',
        assetPath: options.assetPath,
        loaded: false,
      };
      setState({
        windows: [...state.windows, window],
        focusedId: window.focused ? window.id : state.focusedId,
      });
      return window;
    },

    closeWindow(id: string): void {
      const window = state.windows.find(entry => entry.id === id);
      if (!window) {
        return;
      }
      patchWindow(id, {visible: false});
    },

    focusWindow(id: string): void {
      const exists = state.windows.some(entry => entry.id === id);
      if (!exists) {
        return;
      }
      setState({
        windows: state.windows.map(entry =>
          entry.id === id ? {...entry, focused: true} : {...entry, focused: false},
        ),
        focusedId: id,
      });
    },

    setBounds(id: string, bounds: Partial<WindowBounds>): void {
      const window = state.windows.find(entry => entry.id === id);
      if (!window) {
        return;
      }
      patchWindow(id, {bounds: {...window.bounds, ...bounds}});
    },

    setVisible(id: string, visible: boolean): void {
      patchWindow(id, {visible});
    },

    setTitle(id: string, title: string): void {
      patchWindow(id, {title});
    },

    setAlwaysOnTop(id: string, value: boolean): void {
      patchWindow(id, {alwaysOnTop: value});
    },

    setMaximized(id: string, value: boolean): void {
      patchWindow(id, {maximized: value});
    },

    setMinimized(id: string, value: boolean): void {
      patchWindow(id, {minimized: value});
    },

    setWindowMode(id: string, mode: WindowMode): void {
      patchWindow(id, {windowMode: mode});
    },

    markLoaded(id: string, loaded = true): void {
      patchWindow(id, {loaded});
    },

    updateWindow(id: string, patch: Partial<WindowState>): void {
      patchWindow(id, patch);
    },

    removeWindow(id: string): void {
      const windows = state.windows.filter(entry => entry.id !== id);
      if (windows.length === state.windows.length) {
        return;
      }
      setState({
        windows,
        focusedId: state.focusedId === id ? null : state.focusedId,
      });
    },

    getWindow(id: string): WindowState | undefined {
      return state.windows.find(entry => entry.id === id);
    },

    getWindows(): WindowState[] {
      return state.windows;
    },
  };

  return store;
}

export default createWindowStore;
