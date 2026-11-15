/**
 * The native shell paints the area around the WebView (status bar, notch,
 * gesture bar, splash screen). It has to use the colour mode of the page,
 * and it must never fall back to pure black or pure white - that produced the
 * black frame this module replaced.
 */
import {
  APP_THEMES,
  getAppThemePalette,
  isAppThemeName,
  resolveAppTheme,
} from '../src/theme/appTheme';
import {
  getAppTheme,
  resetAppTheme,
  setPageTheme,
  setSystemTheme,
  subscribeAppTheme,
} from '../src/theme/themeStore';

describe('app theme palette', () => {
  it('never uses pure black or pure white', () => {
    for (const palette of Object.values(APP_THEMES)) {
      expect(palette.background.toLowerCase()).not.toBe('#000000');
      expect(palette.background.toLowerCase()).not.toBe('#ffffff');
      expect(palette.surface.toLowerCase()).not.toBe('#000000');
    }
  });

  it('matches the page colours of the renderer', () => {
    // styles/global/theme.css (dark) and styles/global/tokens.css (light).
    expect(APP_THEMES.dark.background).toBe('#16181c');
    expect(APP_THEMES.light.background).toBe('#f5f5f5');
    expect(APP_THEMES.dark.isDark).toBe(true);
    expect(APP_THEMES.light.statusBarStyle).toBe('dark-content');
    expect(APP_THEMES.dark.statusBarStyle).toBe('light-content');
  });

  it('prefers the colour mode of the page over the system', () => {
    expect(resolveAppTheme('dark', 'light')).toBe('dark');
    expect(resolveAppTheme('light', 'dark')).toBe('light');
  });

  it('falls back to the system and then to light', () => {
    expect(resolveAppTheme(null, 'dark')).toBe('dark');
    expect(resolveAppTheme(undefined, undefined)).toBe('light');
    expect(resolveAppTheme('purple', 'dark')).toBe('dark');
    expect(resolveAppTheme('', '')).toBe('light');
  });

  it('recognises only the two supported names', () => {
    expect(isAppThemeName('dark')).toBe(true);
    expect(isAppThemeName('light')).toBe(true);
    expect(isAppThemeName('Dark')).toBe(false);
    expect(isAppThemeName(null)).toBe(false);
  });

  it('always returns a palette', () => {
    expect(getAppThemePalette('dark')).toBe(APP_THEMES.dark);
    // A corrupt value must not crash the shell.
    expect(getAppThemePalette('nope' as any)).toBe(APP_THEMES.light);
  });
});

describe('app theme store', () => {
  beforeEach(() => {
    resetAppTheme();
  });

  it('follows the page once it reported a colour mode', () => {
    setSystemTheme('light');
    expect(getAppTheme().name).toBe('light');

    setPageTheme('dark');
    expect(getAppTheme().name).toBe('dark');

    // The system changing afterwards must not override the page.
    setSystemTheme('light');
    expect(getAppTheme().name).toBe('dark');
  });

  it('notifies subscribers once per actual change', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeAppTheme(listener);

    setSystemTheme('dark');
    expect(listener).toHaveBeenCalledTimes(1);

    setSystemTheme('dark');
    setPageTheme('dark');
    expect(listener).toHaveBeenCalledTimes(1);

    setPageTheme('light');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setPageTheme('dark');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores values the renderer could never send', () => {
    setSystemTheme('dark');
    setPageTheme('sepia');
    setPageTheme(undefined);
    setPageTheme(null);
    expect(getAppTheme().name).toBe('dark');
  });
});
