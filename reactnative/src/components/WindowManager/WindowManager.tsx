/**
 * The React Native window manager.
 *
 * It observes the window store (which is filled by the Electron
 * `BrowserWindow` shim) and renders one `react-native-webview` per window.
 *
 * On a phone there is room for a single window, therefore the focused window
 * fills the screen. When the desktop application opens more than one window
 * (for example the injection window), the windows are shown as scaled down
 * cards that can be moved with a finger.
 */
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {PanResponder, StyleSheet, Text, View, type LayoutChangeEvent} from 'react-native';

import type {WindowState} from '../../runtime/windowState';
import {useWindowStore} from '../../runtime/windowStore';
import {Window} from './Window';

const CARD_PADDING = 8;
const CAPTION_HEIGHT = 22;

export interface WindowManagerProps {
  /** Renders the windows in the "desktop" mode (cards) instead of fullscreen. */
  forceDesktopMode?: boolean;
}

export function WindowManager({forceDesktopMode}: WindowManagerProps) {
  const state = useWindowStore(current => current);
  const [size, setSize] = useState({width: 0, height: 0});
  const containerRef = useRef<React.ComponentRef<typeof View>>(null);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const {width, height} = event.nativeEvent.layout;
    setSize(current => (current.width === width && current.height === height ? current : {width, height}));
  }, []);

  const mountedWindows = useMemo(
    // Hidden windows stay mounted - a hidden Electron window keeps running
    // its page, and a window that was created with `show: false` has to be
    // able to load its page in the first place.
    () => state.windows.filter(entry => !entry.minimized),
    [state.windows],
  );

  const visibleWindows = useMemo(
    () => mountedWindows.filter(entry => entry.visible),
    [mountedWindows],
  );

  const fullscreenWindow = useMemo(
    () => visibleWindows.find(entry => entry.windowMode === 'fullscreen') ?? null,
    [visibleWindows],
  );

  const focusedWindow = useMemo(
    () =>
      visibleWindows.find(entry => entry.id === state.focusedId) ??
      visibleWindows[0] ??
      mountedWindows[0] ??
      null,
    [visibleWindows, mountedWindows, state.focusedId],
  );

  const single = visibleWindows.length <= 1;

  if (!mountedWindows.length) {
    return (
      <View style={styles.root} onLayout={handleLayout} ref={containerRef}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>没有可显示的窗口</Text>
        </View>
      </View>
    );
  }

  if (!forceDesktopMode && (single || fullscreenWindow)) {
    const target = fullscreenWindow ?? focusedWindow;
    if (!target) {
      return <View style={styles.root} onLayout={handleLayout} ref={containerRef} />;
    }
    return (
      <View style={styles.root} onLayout={handleLayout} ref={containerRef}>
        <Window
          key={target.id}
          window={target}
          containerWidth={size.width}
          containerHeight={size.height}
        />
        {mountedWindows
          .filter(entry => entry.id !== target.id)
          .map(entry => (
            <Window
              key={entry.id}
              window={entry}
              containerWidth={size.width}
              containerHeight={size.height}
            />
          ))}
      </View>
    );
  }

  // "Desktop" mode: every window is a card.
  const cardWidth = Math.max(size.width - CARD_PADDING * 2, 0);
  const cardHeight = Math.max((size.height - CARD_PADDING * 2) / Math.max(visibleWindows.length, 1), 0);

  return (
    <View style={styles.root} onLayout={handleLayout} ref={containerRef}>
      {visibleWindows.map((entry, index) => (
        <WindowCard
          key={entry.id}
          window={entry}
          width={cardWidth}
          height={cardHeight}
          offset={index}
        />
      ))}
      {mountedWindows
        .filter(entry => !entry.visible)
        .map(entry => (
          <Window
            key={entry.id}
            window={entry}
            containerWidth={size.width}
            containerHeight={size.height}
          />
        ))}
    </View>
  );
}

interface WindowCardProps {
  window: WindowState;
  width: number;
  height: number;
  offset: number;
}

function WindowCard({window, width, height, offset}: WindowCardProps) {
  const bounds = useRef({x: CARD_PADDING, y: CARD_PADDING + offset * 12});
  const origin = useRef({x: 0, y: 0});

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          origin.current = {...bounds.current};
        },
        onPanResponderMove: (_event, gestureState) => {
          bounds.current = {
            x: Math.max(origin.current.x + gestureState.dx, 0),
            y: Math.max(origin.current.y + gestureState.dy, 0),
          };
        },
        onPanResponderRelease: () => {
          // The bounds of the store are the *desktop* coordinates - the card
          // itself is scaled, therefore the movement is not applied to the
          // store (the desktop application owns the position of a window).
        },
      }),
    [],
  );

  return (
    <View style={[styles.card, {width, height}]} {...panResponder.panHandlers}>
      <View style={styles.caption} {...panResponder.panHandlers}>
        <Text style={styles.captionText} numberOfLines={1}>
          {window.title || `窗口 ${window.id}`}
        </Text>
      </View>
      <View style={styles.cardBody}>
        <Window window={window} containerWidth={width} containerHeight={height - CAPTION_HEIGHT} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#101014',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: '#8a8a8e',
    fontSize: 14,
  },
  card: {
    position: 'absolute',
    top: 0,
    left: 0,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3a3a3c',
  },
  caption: {
    height: CAPTION_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 8,
    backgroundColor: '#2c2c2e',
  },
  captionText: {
    color: '#f2f2f7',
    fontSize: 12,
  },
  cardBody: {
    flex: 1,
    overflow: 'hidden',
  },
});

export default WindowManager;
