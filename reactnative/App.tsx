/**
 * The React Native shell of the ported Auto366 application.
 *
 * The UI itself is the ORIGINAL Electron renderer - it is loaded into a
 * `react-native-webview` by `src/components/WindowManager`. This component
 * only does three things:
 *
 *   1. boots the original Electron main process (which creates the window and
 *      registers the IPC handlers),
 *   2. keeps the UI inside the safe area of the device (status bar, notch,
 *      gesture bar), and
 *   3. renders the window manager.
 *
 * The splash / loading screen shows the application icon as the loading
 * animation, and every surface the shell paints itself (safe area, splash
 * background, status bar) borrows the colour mode of the page - see
 * `src/theme`.
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {Platform, StatusBar, StyleSheet, Text, View} from 'react-native';
import {
  SafeAreaProvider,
  initialWindowMetrics,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {startAuto366} from './src/auto366-main/entry';
import {AppIconLoader} from './src/components/AppIconLoader';
import {WindowManager} from './src/components/WindowManager/WindowManager';
import {useAppTheme} from './src/theme/useAppTheme';

type BootState = 'starting' | 'running' | 'failed';

/**
 * Space the shell keeps free below the page, in dp.
 *
 * iOS reports a 34pt bottom inset on notch / Dynamic Island devices, but that
 * is the height a *tab bar* is supposed to occupy, not blank space: reserving
 * all of it left a large empty band under the navigation. Only the home
 * indicator itself has to stay clear, so the page may run 12dp from the edge
 * and its own bottom bar absorbs the rest.
 *
 * Android's bottom inset is the system navigation bar (gesture pill or the
 * three buttons), i.e. real screen estate the page must not cover - it is kept
 * as reported.
 */
const BOTTOM_INSET_MAX = 12;

function bottomInsetFor(inset: number): number {
  if (Platform.OS !== 'ios') {
    return inset;
  }
  return Math.min(inset, BOTTOM_INSET_MAX);
}

function AppContent(): React.JSX.Element {
  const [state, setState] = useState<BootState>('starting');
  const [message, setMessage] = useState('正在启动 Auto366…');
  const insets = useSafeAreaInsets();
  const theme = useAppTheme();
  const bottomInset = bottomInsetFor(insets.bottom);

  useEffect(() => {
    let cancelled = false;

    startAuto366()
      .then(result => {
        if (cancelled) {
          return;
        }
        if (result?.ok) {
          setState('running');
          return;
        }
        setState('failed');
        setMessage(
          `Auto366 启动失败：${result?.error?.message ?? String(result?.error)}`,
        );
      })
      .catch(error => {
        if (cancelled) {
          return;
        }
        setState('failed');
        setMessage(`Auto366 启动失败：${error?.message ?? String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    // The outer view stays full-bleed (it also paints behind the status bar
    // and the gesture bar), the content is inset by the safe area so that the
    // desktop UI is never covered by the notch or the gesture bar.
    //
    // The top / side insets use the page colour, so the notch area looks like a
    // continuation of the page. The bottom inset is trimmed to the home
    // indicator and painted with the tab bar colour: reserving the whole system
    // inset left a tall empty band under the navigation, and painting it with
    // the page colour made that band stand out even more.
    <View style={[styles.root, {backgroundColor: theme.background}]}>
      <View
        style={[
          styles.safeArea,
          {
            backgroundColor: theme.background,
            paddingTop: insets.top,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}>
        {state === 'running' ? (
          <WindowManager />
        ) : (
          <View style={styles.placeholder}>
            {state === 'starting' ? <AppIconLoader size={88} /> : null}
            <Text style={[styles.message, {color: theme.textMuted}]}>
              {message}
            </Text>
          </View>
        )}
      </View>
      {bottomInset > 0 ? (
        <View style={[styles.bottomInset, {height: bottomInset, backgroundColor: theme.nav}]} />
      ) : null}
    </View>
  );
}

function App(): React.JSX.Element {
  const theme = useAppTheme();

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <StatusBar
        barStyle={theme.statusBarStyle}
        animated
        showHideTransition="fade"
      />
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  bottomInset: {
    // The bar colour is applied at render time (it follows the page theme).
    backgroundColor: '#f8f9fa',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    marginTop: 20,
    fontSize: 15,
    textAlign: 'center',
  },
});

export default App;
