/**
 * `ipcRenderer` - the renderer side of the IPC channel.
 *
 * Inside the WebView the renderer talks to React Native through the injected
 * preload script (see `src/runtime/preload.ts`), which implements the very
 * same API on top of `window.ReactNativeWebView.postMessage`.
 *
 * This module is the React Native side of that API. It is transport
 * agnostic: by default the calls are dispatched straight onto the in-process
 * bus (the main process and the renderer share a single JavaScript context),
 * but a different transport (the WebView bridge) can be installed with
 * {@link setRendererTransport}.
 */
import {ipcBus} from '../../runtime/EventBus';
import {createIpcEvent, type IpcEvent} from '../../runtime/WindowManagerBridge';
import {windowStore} from '../../runtime/windowStore';

export type RendererListener = (event: any, ...args: any[]) => void;

export interface RendererTransport {
  invoke(channel: string, args: any[]): Promise<any>;
  send(channel: string, args: any[]): void;
  on(channel: string, listener: RendererListener): void;
  removeListener(channel: string, listener: RendererListener): void;
}

/** Returns the id of the window that currently owns the focus. */
function currentWindowId(): string {
  const state = windowStore.getState();
  if (state.focusedId) {
    return state.focusedId;
  }
  const visible = state.windows.find(entry => entry.visible);
  return visible ? visible.id : '';
}

/** The default transport: an in-process dispatch onto the IPC bus. */
export const inProcessTransport: RendererTransport = {
  invoke(channel: string, args: any[]): Promise<any> {
    const event = createIpcEvent(currentWindowId(), 'invoke');
    return ipcBus.emitAsync(channel, event, ...args);
  },
  send(channel: string, args: any[]): void {
    const event = createIpcEvent(currentWindowId(), 'send');
    ipcBus.emit(channel, event, ...args);
  },
  on(channel: string, listener: RendererListener): void {
    ipcBus.on(channel, (incoming: IpcEvent, ...args: any[]) => {
      listener(incoming, ...args);
    });
  },
  removeListener(): void {
    // The in-process transport does not keep track of individual listeners.
  },
};

let transport: RendererTransport = inProcessTransport;

/** Replaces the transport that `ipcRenderer` uses. */
export function setRendererTransport(next: RendererTransport | null): void {
  transport = next ?? inProcessTransport;
}

/** The transport that `ipcRenderer` currently uses. */
export function getRendererTransport(): RendererTransport {
  return transport;
}

export const ipcRenderer = {
  /** Calls a request/response handler of the main process. */
  invoke(channel: string, ...args: any[]): Promise<any> {
    return transport.invoke(channel, args);
  },

  /** Sends a message to the main process (fire and forget). */
  send(channel: string, ...args: any[]): void {
    transport.send(channel, args);
  },

  /** React Native has no synchronous IPC. */
  sendSync(channel: string, ..._args: any[]): undefined {
    console.warn(
      `[e2rn] ipcRenderer.sendSync("${channel}") has no synchronous equivalent on React Native.`,
    );
    return undefined;
  },

  /** Subscribes to a channel of the main process. */
  on(channel: string, listener: RendererListener): typeof ipcRenderer {
    transport.on(channel, listener);
    return ipcRenderer;
  },

  once(channel: string, listener: RendererListener): typeof ipcRenderer {
    const wrapper = (event: any, ...args: any[]) => {
      ipcRenderer.removeListener(channel, wrapper);
      listener(event, ...args);
    };
    transport.on(channel, wrapper);
    return ipcRenderer;
  },

  removeListener(channel: string, listener: RendererListener): typeof ipcRenderer {
    transport.removeListener(channel, listener);
    return ipcRenderer;
  },

  removeAllListeners(_channel?: string): typeof ipcRenderer {
    // No-op: the in-process transport does not keep individual listeners.
    return ipcRenderer;
  },
};

export default ipcRenderer;
