/**
 * Renders a single Electron window as a `react-native-webview`.
 *
 * The desktop application renders its UI in a 1400x900 (or 875x1010 in the
 * "simple" mode) Chromium window. On a phone the WebView fills the whole
 * available area and the *page* is scaled by the WebView itself: its viewport
 * meta declares the desktop width and `scalesPageToFit` fits that width onto
 * the screen. No React Native `transform` is involved - a transformed WebView
 * would be rasterised at 1400x900 dp (~4200x2700 physical pixels) and every
 * repaint would flicker.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';

import {PRELOAD_BRIDGE_SOURCE} from '../preloadBridge';
import {buildPreloadScript} from '../../runtime/preload';
import {handleBridgeMessage} from '../../runtime/WindowManagerBridge';
import type {WindowState} from '../../runtime/windowState';
import {getAssetServerBaseUrl, getAssetUrl, startAssetServer} from '../../runtime/web/assetServer';
import {withVirtualWidth} from '../../runtime/web/virtualWidth';
import {registerWebView, unregisterWebView} from '../../runtime/webviewRegistry';
import {notifyWindowLoaded} from '../../shims/electron/browserWindow';
import {
  BASE_HEIGHT,
  BASE_WIDTH,
  SIMPLE_HEIGHT,
  SIMPLE_WIDTH,
  resolveViewportLayout,
  type ViewportLayout,
} from './viewport';

export {
  BASE_HEIGHT,
  BASE_WIDTH,
  SIMPLE_HEIGHT,
  SIMPLE_WIDTH,
  resolveViewportLayout,
};
export type {ViewportLayout};

/**
 * The props of the WebView that are used by the window component.
 *
 * `react-native-webview` types the component as the intersection of the iOS,
 * the Android and the Windows props, which does not resolve with the types of
 * React Native 0.88 - therefore the component is used through this local
 * description.
 */
interface WebViewProps {
  source: {uri: string};
  style?: any;
  originWhitelist?: string[];
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  allowFileAccess?: boolean;
  allowFileAccessFromFileURLs?: boolean;
  allowUniversalAccessFromFileURLs?: boolean;
  mixedContentMode?: 'never' | 'always' | 'compatibility';
  setSupportMultipleWindows?: boolean;
  /** Android: `loadWithOverviewMode` + `useWideViewPort` (fit the page width). */
  scalesPageToFit?: boolean;
  /** Android: disables pinch-to-zoom and the on-screen zoom buttons. */
  setBuiltInZoomControls?: boolean;
  /** Android: hides the zoom buttons (only relevant when zoom is enabled). */
  setDisplayZoomControls?: boolean;
  injectedJavaScriptBeforeContentLoaded?: string;
  onMessage?: (event: WebViewMessageEvent) => void;
  onLoadEnd?: (event: any) => void;
  onLoadStart?: (event: any) => void;
  onError?: (event: any) => void;
  onHttpError?: (event: any) => void;
  ref?: any;
}

const WebViewComponent = WebView as unknown as React.ComponentType<WebViewProps>;

/** Builds the URL the WebView has to load. */
export function resolveWindowUrlFromParts(servedUrl?: string, assetPath?: string): string {
  if (servedUrl && /^(https?|data|file|blob):/i.test(servedUrl)) {
    return servedUrl;
  }
  if (!assetPath) {
    return '';
  }
  const base = getAssetServerBaseUrl();
  if (!base) {
    return '';
  }
  return getAssetUrl(assetPath);
}

/** Builds the URL the WebView has to load. */
export function resolveWindowUrl(window: WindowState): string {
  return resolveWindowUrlFromParts(window.servedUrl, window.assetPath);
}

export interface WindowProps {
  /** The state of the window (from the window store). */
  window: WindowState;
  /** Size of the area the window is rendered in. */
  containerWidth: number;
  containerHeight: number;
}

export function Window({window, containerWidth, containerHeight}: WindowProps) {
  const webViewRef = useRef<any>(null);
  const [source, setSource] = useState<string>('');

  const windowId = window.id;
  const servedUrl = window.servedUrl;
  const assetPath = window.assetPath;

  const layout = useMemo(
    () =>
      resolveViewportLayout(
        containerWidth,
        containerHeight,
        window.bounds?.width || BASE_WIDTH,
      ),
    [containerWidth, containerHeight, window.bounds?.width],
  );

  // The asset server is started lazily - the first window needs it.
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      if (!getAssetServerBaseUrl()) {
        await startAssetServer();
      }
      if (cancelled) {
        return;
      }
      setSource(resolveWindowUrlFromParts(servedUrl, assetPath));
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [windowId, servedUrl, assetPath]);

  // The page is scaled by the WebView, therefore the URL carries the width of
  // the desktop window (`?e2rn_vw=1400`). The asset server rewrites the
  // viewport meta of the HTML with it.
  const pageUrl = useMemo(
    () => (source ? withVirtualWidth(source, layout.virtualWidth) : ''),
    [source, layout.virtualWidth],
  );

  // Make the WebView known to the Electron shims.
  useEffect(() => {
    const webView = webViewRef.current;
    if (!webView) {
      return undefined;
    }
    registerWebView(windowId, webView);
    return () => {
      unregisterWebView(windowId);
    };
  }, [windowId, pageUrl]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const data = event?.nativeEvent?.data;
      if (typeof data !== 'string' || !data) {
        return;
      }
      handleBridgeMessage(windowId, data);
    },
    [windowId],
  );

  const handleLoadEnd = useCallback(() => {
    const webView = webViewRef.current;
    if (webView && typeof webView.injectJavaScript === 'function') {
      // The bridge is normally injected before the content is loaded - this
      // is the fallback for pages that reset the global scope.
      webView.injectJavaScript(PRELOAD_BRIDGE_SOURCE);
    }
    notifyWindowLoaded(windowId);
  }, [windowId]);

  const handleError = useCallback(
    (event: any) => {
      console.error(`[e2rn] the page of window ${windowId} could not be loaded`, event?.nativeEvent);
      // The desktop application shows the window when the page failed to
      // load - otherwise the user would stare at an empty screen.
      notifyWindowLoaded(windowId);
    },
    [windowId],
  );

  const preloadScript = useMemo(() => buildPreloadScript({windowId}), [windowId]);

  return (
    <View
      style={[styles.container, window.visible ? styles.visible : styles.hidden]}
      pointerEvents={window.visible ? 'auto' : 'none'}>
      {pageUrl ? (
        <WebViewComponent
          ref={webViewRef}
          source={{uri: pageUrl}}
          style={styles.webView}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          mixedContentMode="always"
          setSupportMultipleWindows={false}
          scalesPageToFit
          setBuiltInZoomControls={false}
          setDisplayZoomControls={false}
          injectedJavaScriptBeforeContentLoaded={preloadScript}
          onMessage={handleMessage}
          onLoadEnd={handleLoadEnd}
          onError={handleError}
          onHttpError={handleError}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  visible: {
    opacity: 1,
  },
  hidden: {
    // The window stays mounted (the page has to keep running) but is not
    // visible - the same behaviour as a hidden Electron window.
    opacity: 0,
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});

export default Window;
