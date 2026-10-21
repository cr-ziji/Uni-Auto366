/**
 * Registry of the live `react-native-webview` instances.
 *
 * The Electron shims (`webContents.send`, `webContents.executeJavaScript`)
 * have no direct access to the React tree, therefore every rendered window
 * registers its WebView here and the shims look it up by the window id.
 */

/** The (very small) part of the WebView API the runtime relies on. */
export interface WebViewHandle {
  injectJavaScript?: (script: string) => void;
  reload?: () => void;
  [key: string]: any;
}

const registry = new Map<string, WebViewHandle>();

/** Registers the WebView of a window (replaces an existing registration). */
export function registerWebView(id: string, ref: WebViewHandle | null | undefined): void {
  if (!id || !ref) {
    return;
  }
  registry.set(String(id), ref);
}

/** Removes the WebView of a window. */
export function unregisterWebView(id: string): void {
  if (!id) {
    return;
  }
  registry.delete(String(id));
}

/** Returns the WebView of a window (or `undefined`). */
export function getWebView(id: string): WebViewHandle | undefined {
  if (!id) {
    return undefined;
  }
  return registry.get(String(id));
}

/** Ids of all windows that currently own a WebView. */
export function getWebViewIds(): string[] {
  return Array.from(registry.keys());
}

/** Drops every registration (used when the application tears down). */
export function clearWebViews(): void {
  registry.clear();
}

export default {
  registerWebView,
  unregisterWebView,
  getWebView,
  getWebViewIds,
  clearWebViews,
};
