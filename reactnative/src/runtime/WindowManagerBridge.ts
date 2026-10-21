/**
 * React Native side of the WebView message bridge.
 *
 * A WebView page cannot call into React Native directly, therefore the
 * injected preload script posts JSON messages with
 * `window.ReactNativeWebView.postMessage(JSON.stringify(...))`. This module
 * is the transport that
 *
 *   - receives those messages (`handleBridgeMessage`),
 *   - routes them onto the in-process `ipcBus` (which backs `ipcMain`), and
 *   - pushes events / invocation results back into the WebView
 *     (`deliverToWebView`).
 *
 * Because main and renderer share a single JavaScript context, the "IPC" is
 * an ordinary function call - but the *shape* of the Electron event is kept
 * intact, because the original `modules/register.js` validates the sender of
 * every message (`event.senderFrame.url`).
 */
import {ipcBus} from './EventBus';
import {
  BRIDGE_MESSAGE,
  IPC_INVOKE_TIMEOUT_MS,
  createBridgeMessage,
  parseBridgeMessage,
  serializeBridgeMessage,
  type BridgeMessage,
  type BridgePayload,
} from './protocol';
import {windowStore} from './windowStore';
import {getWebView} from './webviewRegistry';

export {BRIDGE_MESSAGE, createBridgeMessage, parseBridgeMessage, serializeBridgeMessage};
export type {BridgeMessage, BridgePayload};

/** Virtual URL that is used when a window did not load a page (yet). */
export const DEFAULT_VIRTUAL_URL = 'file:///app/index.html';

/** How the message was delivered - used to keep `on`/`handle` apart. */
export type BridgeDelivery = 'invoke' | 'send';

export interface IpcSenderFrame {
  url: string;
  frameId: number;
  parentFrameId: number;
  processId: number;
  routingId: number;
  [key: string]: any;
}

export interface IpcSender {
  id: number;
  windowId: string;
  send: (channel: string, ...args: any[]) => void;
  [key: string]: any;
}

export interface IpcEvent {
  sender: IpcSender;
  senderFrame: IpcSenderFrame;
  frameId: number;
  reply: (channel: string, ...args: any[]) => void;
  /** Internal marker: `invoke` or `send`. */
  __e2rnDelivery?: BridgeDelivery;
  [key: string]: any;
}

interface PendingInvocation {
  windowId: string;
  id: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingInvocations = new Map<string, PendingInvocation>();

/** Monotonic counter for the correlation ids of outgoing invocations. */
let invocationCounter = 0;

/** Returns the virtual (`file://`) URL of a window. */
export function getWindowVirtualUrl(windowId: string): string {
  const state = windowStore.getState();
  const window = state.windows.find(entry => entry.id === windowId);
  if (window && window.url) {
    return window.url;
  }
  return DEFAULT_VIRTUAL_URL;
}

/**
 * Builds an Electron-like IPC event for the given window.
 *
 * `event.senderFrame.url` MUST look like the original `file://` URL, because
 * the ported `modules/register.js` rejects every message that does not come
 * from `index.html` (or from the injection window).
 */
export function createIpcEvent(windowId: string, delivery: BridgeDelivery): IpcEvent {
  const url = getWindowVirtualUrl(windowId);
  const numericId = Number(windowId) || 0;
  const sender: IpcSender = {
    id: numericId,
    windowId,
    send: (channel: string, ...args: any[]) => {
      deliverToWebView(windowId, {type: 'event', channel, args});
    },
  };
  const event: IpcEvent = {
    sender,
    senderFrame: {
      url,
      frameId: 0,
      parentFrameId: -1,
      processId: 1,
      routingId: numericId,
    },
    frameId: 0,
    reply: (channel: string, ...args: any[]) => {
      deliverToWebView(windowId, {type: 'event', channel, args});
    },
    __e2rnDelivery: delivery,
  };
  return event;
}

/**
 * Injects a payload into the WebView of a window.
 *
 * The page side receives it through `window.__E2RN_RECEIVE__(payload)`.
 */
export function deliverToWebView(id: string, payload: any): boolean {
  const webView = getWebView(id);
  if (!webView || typeof webView.injectJavaScript !== 'function') {
    return false;
  }
  let json: string;
  try {
    json = JSON.stringify(payload === undefined ? null : payload);
  } catch (error) {
    console.error('[e2rn] bridge payload is not serialisable', error);
    return false;
  }
  const script =
    '(function(){' +
    'try{' +
    'if (window.__E2RN_RECEIVE__) { window.__E2RN_RECEIVE__(' +
    json +
    '); }' +
    '} catch (error) { console.error("[e2rn] bridge delivery failed", error); }' +
    '})();';
  try {
    webView.injectJavaScript(script);
  } catch (error) {
    console.error(`[e2rn] injectJavaScript failed for window ${id}`, error);
    return false;
  }
  return true;
}

/** Clears a pending invocation and stops its timeout. */
function settlePending(id: string): void {
  const pending = pendingInvocations.get(id);
  if (!pending) {
    return;
  }
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  pendingInvocations.delete(id);
}

/** Number of invocations that are still waiting for an answer. */
export function getPendingInvocationCount(): number {
  return pendingInvocations.size;
}

/**
 * Handles a raw message that was posted by a WebView.
 *
 *  - `invoke` -> `ipcBus.emitAsync(channel, event, ...args)`, the result is
 *    delivered back to the page.
 *  - `send`   -> `ipcBus.emit(channel, event, ...args)`.
 */
export function handleBridgeMessage(id: string, raw: string): void {
  const message = parseBridgeMessage(raw);
  if (!message) {
    return;
  }
  const windowId = message.windowId || id;

  switch (message.type) {
    case 'hello':
    case 'ready':
      return;
    case 'invoke':
      void handleInvoke(windowId, message);
      return;
    case 'send':
      handleSend(windowId, message);
      return;
    default:
      return;
  }
}

function handleSend(windowId: string, message: BridgeMessage): void {
  const channel = message.channel;
  if (!channel) {
    return;
  }
  const event = createIpcEvent(windowId, 'send');
  ipcBus.emit(channel, event, ...(message.args ?? []));
}

async function handleInvoke(windowId: string, message: BridgeMessage): Promise<void> {
  const channel = message.channel;
  if (!channel) {
    return;
  }
  const id = message.id ?? String(++invocationCounter);
  const event = createIpcEvent(windowId, 'invoke');

  const pending: PendingInvocation = {windowId, id, timer: null};
  pending.timer = setTimeout(() => {
    pendingInvocations.delete(id);
    deliverToWebView(windowId, {
      type: 'reply',
      id,
      channel,
      ok: false,
      error: 'timeout',
    });
  }, IPC_INVOKE_TIMEOUT_MS);
  pendingInvocations.set(id, pending);

  try {
    const value = await ipcBus.emitAsync(channel, event, ...(message.args ?? []));
    settlePending(id);
    deliverToWebView(windowId, {
      type: 'reply',
      id,
      channel,
      ok: true,
      value: value === undefined ? null : value,
    });
  } catch (error: any) {
    settlePending(id);
    deliverToWebView(windowId, {
      type: 'reply',
      id,
      channel,
      ok: false,
      error: error && error.message ? String(error.message) : String(error),
    });
  }
}

/** Drops every pending invocation (used when the application tears down). */
export function clearPendingInvocations(): void {
  for (const pending of Array.from(pendingInvocations.values())) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
  }
  pendingInvocations.clear();
}

export default {
  BRIDGE_MESSAGE,
  createBridgeMessage,
  parseBridgeMessage,
  serializeBridgeMessage,
  deliverToWebView,
  handleBridgeMessage,
  createIpcEvent,
  getWindowVirtualUrl,
  clearPendingInvocations,
};
