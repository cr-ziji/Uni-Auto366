/**
 * Tiny observable store for the colour mode of the native shell.
 *
 * Two writers feed it:
 *
 *   - the system (`Appearance`), which is the only source that exists while
 *     the splash screen is on screen, and
 *   - the page, which reports its effective `data-theme` through the WebView
 *     bridge as soon as it is applied and on every later change.
 *
 * The page value wins over the system value (see `resolveAppTheme`), which is
 * what the desktop UI expects: forcing "dark" must not be overruled by a light
 * system setting.
 */
import {
  APP_THEMES,
  getAppThemePalette,
  isAppThemeName,
  resolveAppTheme,
  type AppThemeName,
  type AppThemePalette,
} from './appTheme';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Colour mode reported by the page; `null` until a page reported one. */
let pageTheme: AppThemeName | null = null;

/** Colour mode of the operating system. */
let systemTheme: AppThemeName = 'light';

/** Cached snapshot - identity has to stay stable for `useSyncExternalStore`. */
let snapshot: AppThemePalette = getAppThemePalette(
  resolveAppTheme(pageTheme, systemTheme),
);

function recompute(): void {
  const next = getAppThemePalette(resolveAppTheme(pageTheme, systemTheme));
  if (next === snapshot) {
    return;
  }
  snapshot = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.error('[e2rn] app theme listener failed', error);
    }
  }
}

/** Reports the colour mode the page renders with. Unknown values are ignored. */
export function setPageTheme(theme: unknown): void {
  if (!isAppThemeName(theme)) {
    return;
  }
  if (pageTheme === theme) {
    return;
  }
  pageTheme = theme;
  recompute();
}

/** Reports the colour mode of the operating system (`null` = unknown). */
export function setSystemTheme(theme: unknown): void {
  const next: AppThemeName = isAppThemeName(theme) ? theme : 'light';
  if (systemTheme === next) {
    return;
  }
  systemTheme = next;
  recompute();
}

/** The palette the shell has to paint right now. */
export function getAppTheme(): AppThemePalette {
  return snapshot;
}

/** Subscribes to palette changes; returns the unsubscribe function. */
export function subscribeAppTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drops every reported value (tests, and a full application restart). */
export function resetAppTheme(): void {
  pageTheme = null;
  systemTheme = 'light';
  snapshot = getAppThemePalette(resolveAppTheme(pageTheme, systemTheme));
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.error('[e2rn] app theme listener failed', error);
    }
  }
}

export {APP_THEMES};
export type {AppThemeName, AppThemePalette};

export default getAppTheme;
