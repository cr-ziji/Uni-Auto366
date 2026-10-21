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
 * @format
 */

import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  initialWindowMetrics,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {startAuto366} from './src/auto366-main/entry';
import {WindowManager} from './src/components/WindowManager/WindowManager';

type BootState = 'starting' | 'running' | 'failed';

function AppContent(): React.JSX.Element {
  const [state, setState] = useState<BootState>('starting');
  const [message, setMessage] = useState('正在启动 Auto366…');
  const insets = useSafeAreaInsets();

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
    // The outer view stays full-bleed and black, the content is inset by the
    // safe area so that the desktop UI is never covered by the status bar,
    // the notch or the gesture bar.
    <View style={styles.root}>
      <View
        style={[
          styles.safeArea,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}>
        {state === 'running' ? (
          <WindowManager />
        ) : (
          <View style={styles.placeholder}>
            {state === 'starting' ? (
              <ActivityIndicator size="large" color="#ffffff" />
            ) : null}
            <Text style={styles.message}>{message}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function App(): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <StatusBar barStyle="light-content" />
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  safeArea: {
    flex: 1,
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    marginTop: 16,
    color: '#ffffff',
    fontSize: 15,
    textAlign: 'center',
  },
});

export default App;
