/**
 * Message protocol spoken between the WebView (the "renderer") and the React
 * Native runtime (the "main process").
 *
 * Electron ships structured IPC over a process boundary. The E2RN port runs
 * everything inside a single JavaScript context, therefore the very same
 * semantics are re-created on top of `window.ReactNativeWebView.postMessage`.
 *
 * The constants below are shared by the React Native side
 * (`src/runtime/WindowManagerBridge.ts`) and by the script that is injected
 * into the WebView (`src/components/preloadBridge.ts` +
 * `src/runtime/preload.ts`), therefore they must stay in sync.
 */

/** Version of the bridge protocol (bumped on incompatible changes). */
export const PROTOCOL_VERSION = 1;

/** Marker that identifies an E2RN bridge message. */
export const BRIDGE_MESSAGE = '__E2RN_BRIDGE__';

/** Channel the bridge messages are posted on (informational only). */
export const BRIDGE_CHANNEL = 'e2rn:bridge';

/** Payload encoding used by the bridge. */
export const PROTOCOL_ENCODING = 'utf8';

/** Timeout for a single `invoke` round trip (30 seconds). */
export const IPC_INVOKE_TIMEOUT_MS = 30000;

/**
 * Message kinds.
 *
 *  - `invoke`  renderer -> main: `ipcRenderer.invoke(channel, ...args)`
 *  - `send`    renderer -> main: `ipcRenderer.send(channel, ...args)`
 *  - `reply`   main -> renderer: result of an `invoke`
 *  - `event`   main -> renderer: `webContents.send(channel, ...args)`
 *  - `hello`   renderer -> main: handshake (the page is alive)
 *  - `ready`   renderer -> main: the page finished loading
 */
export type BridgeMessageType = 'invoke' | 'send' | 'reply' | 'event' | 'hello' | 'ready';

export interface BridgeMessage {
  /** Message kind. */
  type: BridgeMessageType;
  /** IPC channel the message belongs to. */
  channel?: string;
  /** Positional arguments of the IPC call. */
  args?: any[];
  /** Correlation id (used by `invoke` / `reply`). */
  id?: string;
  /** Id of the window the message originates from. */
  windowId?: string;
  /** Protocol version (only sent by `hello`). */
  version?: number;
  /** Marker so that foreign messages can be ignored. */
  marker?: string;
}

/** Payload accepted by {@link createBridgeMessage}. */
export interface BridgePayload {
  type: 'invoke' | 'send' | 'event';
  channel: string;
  args?: any[];
  id?: string;
  windowId?: string;
}

/** Builds a well formed bridge message. */
export function createBridgeMessage(payload: BridgePayload): BridgeMessage {
  const message: BridgeMessage = {
    marker: BRIDGE_MESSAGE,
    version: PROTOCOL_VERSION,
    type: payload.type,
    channel: payload.channel,
  };
  if (payload.args !== undefined) {
    message.args = payload.args;
  }
  if (payload.id !== undefined) {
    message.id = String(payload.id);
  }
  if (payload.windowId !== undefined) {
    message.windowId = String(payload.windowId);
  }
  return message;
}

/** Serializes a bridge message for `postMessage`. */
export function serializeBridgeMessage(message: BridgeMessage | BridgePayload): string {
  return JSON.stringify(message);
}

/**
 * Parses a raw `postMessage` payload.
 *
 * Accepts both the current `{type: ...}` shape and the legacy `{t: ...}`
 * shape so that an older injected script keeps working.
 */
export function parseBridgeMessage(raw: unknown): BridgeMessage | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  return normalizeBridgeMessage(parsed as Record<string, unknown>);
}

function normalizeBridgeMessage(parsed: Record<string, unknown>): BridgeMessage | null {
  const type = (parsed.type ?? parsed.t) as BridgeMessageType | undefined;
  if (typeof type !== 'string') {
    return null;
  }
  const message: BridgeMessage = {type};
  if (typeof parsed.channel === 'string') {
    message.channel = parsed.channel;
  }
  if (Array.isArray(parsed.args)) {
    message.args = parsed.args;
  }
  if (typeof parsed.id === 'string' || typeof parsed.id === 'number') {
    message.id = String(parsed.id);
  }
  if (typeof parsed.windowId === 'string' || typeof parsed.windowId === 'number') {
    message.windowId = String(parsed.windowId);
  }
  if (typeof parsed.version === 'number') {
    message.version = parsed.version;
  }
  if (typeof parsed.marker === 'string') {
    message.marker = parsed.marker;
  }
  return message;
}
