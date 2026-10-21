/**
 * `ipcMain` - the Electron main-process IPC registry.
 *
 * On React Native the main process and the renderer bridge share a single JS
 * context, therefore the classic `ipcMain.handle` / `ipcMain.on` contract is
 * kept intact and merely fed by the WebView message bridge.
 *
 * Both kinds of registration end up on the in-process {@link ipcBus}:
 *
 *  - `handle(channel, handler)` -> the handler answers `ipcRenderer.invoke`
 *  - `on(channel, listener)`    -> the listener reacts to `ipcRenderer.send`
 *
 * The `__e2rnDelivery` marker of the IPC event keeps the two apart: an
 * `invoke` only reaches the `handle` handlers and a `send` only reaches the
 * `on` listeners, exactly like on the desktop.
 */
import {ipcBus} from '../../runtime/EventBus';
import {createIpcEvent, type IpcEvent} from '../../runtime/WindowManagerBridge';

export type {IpcEvent};

export type InvokeHandler = (event: IpcEvent, ...args: any[]) => any;
export type IpcListener = (event: IpcEvent, ...args: any[]) => void;

const handlers = new Map<string, InvokeHandler>();
const handleUnsubscribers = new Map<string, () => void>();
const channelListeners = new Map<string, Map<IpcListener, () => void>>();

function deliveryOf(event: any): string {
  return event && typeof event === 'object' ? String((event as any).__e2rnDelivery ?? '') : '';
}

function listenerMap(channel: string): Map<IpcListener, () => void> {
  let map = channelListeners.get(channel);
  if (!map) {
    map = new Map<IpcListener, () => void>();
    channelListeners.set(channel, map);
  }
  return map;
}

export const ipcMain = {
  /** Registers a request/response handler (`ipcRenderer.invoke`). */
  handle(channel: string, handler: InvokeHandler): typeof ipcMain {
    if (typeof channel !== 'string' || typeof handler !== 'function') {
      throw new TypeError('[e2rn] ipcMain.handle() expects a channel and a function');
    }
    if (handlers.has(channel)) {
      console.warn(`[e2rn] IPC handler for "${channel}" was registered twice - the last one wins.`);
    }
    handlers.set(channel, handler);
    handleUnsubscribers.get(channel)?.();
    handleUnsubscribers.set(
      channel,
      ipcBus.on(channel, (event: IpcEvent, ...args: any[]) => {
        if (deliveryOf(event) === 'send') {
          // `ipcMain.on` listeners are not triggered by `ipcRenderer.send`.
          return undefined;
        }
        return handler(event, ...args);
      }),
    );
    return ipcMain;
  },

  /** Registers a handler that is removed after the first call. */
  handleOnce(channel: string, handler: InvokeHandler): typeof ipcMain {
    const wrapper: InvokeHandler = async (event, ...args) => {
      ipcMain.removeHandler(channel);
      return handler(event, ...args);
    };
    return ipcMain.handle(channel, wrapper);
  },

  /** Registers a listener (`ipcRenderer.send`). */
  on(channel: string, listener: IpcListener): typeof ipcMain {
    if (typeof channel !== 'string' || typeof listener !== 'function') {
      throw new TypeError('[e2rn] ipcMain.on() expects a channel and a function');
    }
    const map = listenerMap(channel);
    map.get(listener)?.();
    const unsubscribe = ipcBus.on(channel, (event: IpcEvent, ...args: any[]) => {
      if (deliveryOf(event) === 'invoke') {
        // `ipcMain.handle` handlers answer `ipcRenderer.invoke`, the plain
        // `ipcMain.on` listeners never do.
        return undefined;
      }
      listener(event, ...args);
      return undefined;
    });
    map.set(listener, unsubscribe);
    return ipcMain;
  },

  once(channel: string, listener: IpcListener): typeof ipcMain {
    const wrapper = (event: IpcEvent, ...args: any[]) => {
      ipcMain.removeListener(channel, wrapper);
      listener(event, ...args);
    };
    return ipcMain.on(channel, wrapper);
  },

  removeListener(channel: string, listener: IpcListener): void {
    const map = channelListeners.get(channel);
    const unsubscribe = map?.get(listener);
    if (unsubscribe) {
      unsubscribe();
      map?.delete(listener);
    }
  },

  removeAllListeners(channel?: string): void {
    if (channel === undefined) {
      for (const map of Array.from(channelListeners.values())) {
        for (const unsubscribe of Array.from(map.values())) {
          unsubscribe();
        }
      }
      channelListeners.clear();
      for (const unsubscribe of Array.from(handleUnsubscribers.values())) {
        unsubscribe();
      }
      handleUnsubscribers.clear();
      handlers.clear();
      ipcBus.removeAll();
      return;
    }
    const map = channelListeners.get(channel);
    if (map) {
      for (const unsubscribe of Array.from(map.values())) {
        unsubscribe();
      }
      channelListeners.delete(channel);
    }
    handleUnsubscribers.get(channel)?.();
    handleUnsubscribers.delete(channel);
    handlers.delete(channel);
    ipcBus.removeAll(channel);
  },

  /** Removes the request/response handler of a channel. */
  removeHandler(channel: string): typeof ipcMain {
    handleUnsubscribers.get(channel)?.();
    handleUnsubscribers.delete(channel);
    handlers.delete(channel);
    return ipcMain;
  },

  hasHandler(channel: string): boolean {
    return handlers.has(channel);
  },

  /** Emits an event to every listener registered for `channel`. */
  emit(channel: string, event: IpcEvent, ...args: any[]): void {
    ipcBus.emit(channel, event, ...args);
  },

  /** Invokes the handler of a channel (in-process shortcut). */
  async invoke(channel: string, event: IpcEvent, ...args: any[]): Promise<any> {
    return ipcBus.emitAsync(channel, event, ...args);
  },

  /** Builds an Electron-like IPC event for a window. */
  createEvent(windowId: string, delivery: 'invoke' | 'send' = 'invoke'): IpcEvent {
    return createIpcEvent(windowId, delivery);
  },
};

export default ipcMain;
