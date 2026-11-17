/**
 * React binding for the shell colour mode.
 *
 * `useAppTheme()` returns the palette that matches the page currently inside
 * the WebView. It also keeps the system colour scheme in the store, so the
 * splash screen is already correct before the first page reported anything.
 */
import {useEffect, useSyncExternalStore} from 'react';
import {Appearance} from 'react-native';

import {getAppTheme, setSystemTheme, subscribeAppTheme} from './themeStore';
import type {AppThemePalette} from './appTheme';

// Prime the store while the module is imported (before the first frame): the
// splash screen is the very first thing the user sees, so it must not start
// light and flip to dark one frame later.
setSystemTheme(Appearance.getColorScheme());

/** Current palette of the native shell. */
export function useAppTheme(): AppThemePalette {
  const palette = useSyncExternalStore(subscribeAppTheme, getAppTheme, getAppTheme);

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({colorScheme}) => {
      setSystemTheme(colorScheme);
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return palette;
}

export default useAppTheme;
