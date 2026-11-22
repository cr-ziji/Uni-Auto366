/**
 * Colour scheme of the *native* shell (the splash / boot screen and the safe
 * area around the WebView).
 *
 * The UI itself lives in the WebView, so the shell has to borrow the colours
 * of the page - otherwise the status bar, the notch and the gesture bar are
 * framed by a strip of pure black (or pure white) that does not belong to the
 * page at all.
 *
 * The values below are copied from the design tokens of the renderer
 * (`styles/global/tokens.css` and `styles/global/theme.css`):
 *
 *   light page  #ffffff (professional) / #f5f5f5 (simple)  ->  #f5f5f5
 *   dark  page  #16181c                                    ->  #16181c
 *
 * Neither mode uses pure black or pure white: the seam between the shell and
 * the page stays invisible, but the shell never glows brighter than the page.
 *
 * This module is free of React Native imports on purpose - it is the unit
 * tested part of the theme (see `__tests__/app-theme.test.ts`).
 */

/** The two colour modes the renderer supports. */
export type AppThemeName = 'light' | 'dark';

export interface AppThemePalette {
  /** Colour mode of this palette. */
  name: AppThemeName;
  /** Background of the shell - matches the page of the same mode. */
  background: string;
  /** Raised surface (window cards, the plate behind the app icon). */
  surface: string;
  /**
   * Colour of the page's bottom tab bar (`--color-bg-muted`).
   *
   * The shell paints the bottom safe area (the home indicator strip) with it,
   * so the tab bar visually continues to the screen edge instead of floating
   * above a band of page background - which looked like wasted space.
   */
  nav: string;
  /** Primary text colour of the shell. */
  text: string;
  /** Secondary text colour (the boot message). */
  textMuted: string;
  /** `true` for the dark palette. */
  isDark: boolean;
  /** Status bar content style that stays readable on `background`. */
  statusBarStyle: 'light-content' | 'dark-content';
}

export const APP_THEMES: Record<AppThemeName, AppThemePalette> = {
  light: {
    name: 'light',
    background: '#f5f5f5',
    surface: '#ffffff',
    // --color-gray-50, the background of the mobile bottom navigation.
    nav: '#f8f9fa',
    text: '#333333',
    textMuted: '#6c757d',
    isDark: false,
    statusBarStyle: 'dark-content',
  },
  dark: {
    name: 'dark',
    background: '#16181c',
    surface: '#1e2127',
    nav: '#1e2127',
    text: '#d4dae1',
    textMuted: '#98a1ac',
    isDark: true,
    statusBarStyle: 'light-content',
  },
};

/** Narrows an unknown value to a theme name. */
export function isAppThemeName(value: unknown): value is AppThemeName {
  return value === 'light' || value === 'dark';
}

/**
 * Picks the colour mode of the shell.
 *
 * The page wins: the desktop UI lets the user force "dark" or "light"
 * independently of the system setting, and the shell has to follow that
 * choice. The system scheme is only the fallback for the time before the
 * first window exists (the splash screen) and for hosts without a page.
 */
export function resolveAppTheme(
  pageTheme: unknown,
  systemTheme: unknown,
): AppThemeName {
  if (isAppThemeName(pageTheme)) {
    return pageTheme;
  }
  return isAppThemeName(systemTheme) ? systemTheme : 'light';
}

/** Returns the palette of a colour mode (never `undefined`). */
export function getAppThemePalette(theme: AppThemeName): AppThemePalette {
  return APP_THEMES[theme] ?? APP_THEMES.light;
}

export default APP_THEMES;
