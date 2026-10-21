/**
 * `nativeTheme` - the Electron native theme shim.
 *
 * The ported application only uses the theme to pick an icon set, therefore
 * the shim always reports the light theme.
 */

type ThemeListener = (...args: any[]) => void;

const listeners = new Map<string, Set<ThemeListener>>();

export const nativeTheme = {
  /** `true` when the system uses a dark theme. */
  shouldUseDarkColors: false,
  /** `true` when a high contrast theme is used. */
  shouldUseHighContrastColors: false,
  /** `system` | `light` | `dark` */
  themeSource: 'system' as 'system' | 'light' | 'dark',

  on(event: string, listener: ThemeListener): typeof nativeTheme {
    let bucket = listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      listeners.set(event, bucket);
    }
    bucket.add(listener);
    return nativeTheme;
  },

  once(event: string, listener: ThemeListener): typeof nativeTheme {
    const wrapper = (theme: {shouldUseDarkColors: boolean}) => {
      nativeTheme.removeListener(event, wrapper);
      listener(theme);
    };
    return nativeTheme.on(event, wrapper);
  },

  removeListener(event: string, listener: ThemeListener): typeof nativeTheme {
    listeners.get(event)?.delete(listener);
    return nativeTheme;
  },

  removeAllListeners(event?: string): typeof nativeTheme {
    if (event === undefined) {
      listeners.clear();
    } else {
      listeners.delete(event);
    }
    return nativeTheme;
  },

  emit(event: string, ...args: any[]): void {
    const bucket = listeners.get(event);
    if (!bucket) {
      return;
    }
    for (const listener of Array.from(bucket)) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[e2rn] nativeTheme listener for "${event}" failed`, error);
      }
    }
  },
};

export default nativeTheme;
