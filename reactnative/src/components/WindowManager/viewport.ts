/**
 * The geometry of the desktop window on a phone screen.
 *
 * The original Electron UI is designed for a fixed size (1400x900 in the
 * "professional" mode, 875x1010 in the "simple" mode). A phone has a
 * completely different viewport, therefore the page keeps its *desktop width*
 * in CSS pixels and the WebView scales the layout down to the width of the
 * screen. The height is not fixed: the page simply becomes taller, so it fills
 * the whole available area instead of leaving black bars above and below.
 *
 * The scaling is performed by the WebView itself (a `<meta name="viewport">`
 * that is rewritten by the asset server, plus `scalesPageToFit`) and NOT by a
 * React Native `transform`. A transformed WebView is still laid out - and
 * rasterised - at its *unscaled* size, i.e. 1400x900 dp which is roughly
 * 4200x2700 physical pixels on a 3x phone. Every repaint (animations, the
 * tutorial overlay, ...) forces the compositor to re-upload that enormous
 * hardware layer, which shows up as flickering.
 *
 * The module is intentionally free of any native dependency so that it can be
 * unit tested.
 */

/** Size of the desktop window in the "professional" mode. */
export const BASE_WIDTH = 1400;
/** Size of the desktop window in the "professional" mode. */
export const BASE_HEIGHT = 900;
/** Size of the desktop window in the "simple" mode. */
export const SIMPLE_WIDTH = 875;
/** Size of the desktop window in the "simple" mode. */
export const SIMPLE_HEIGHT = 1010;

export interface ViewportLayout {
  /** Width of the WebView in device independent pixels (the whole screen). */
  width: number;
  /** Height of the WebView in device independent pixels (the whole screen). */
  height: number;
  /** Width of the page in CSS pixels (the desktop width of the window). */
  virtualWidth: number;
  /** Height of the page in CSS pixels (derived from the available height). */
  virtualHeight: number;
  /** CSS pixels per device independent pixel (always > 0). */
  scale: number;
}

/**
 * Computes the layout of a window inside the available space.
 *
 * The page is fitted to the *width* of the container; the height follows from
 * the aspect ratio of the screen, so the page fills the container completely.
 * Nothing is centred and nothing is letterboxed.
 */
export function resolveViewportLayout(
  containerWidth: number,
  containerHeight: number,
  baseWidth: number = BASE_WIDTH,
): ViewportLayout {
  const width = Math.max(Number.isFinite(containerWidth) ? containerWidth : 0, 0);
  const height = Math.max(Number.isFinite(containerHeight) ? containerHeight : 0, 0);
  const virtualWidth = Math.max(Math.round(baseWidth > 0 ? baseWidth : BASE_WIDTH), 1);
  const scale = width > 0 ? width / virtualWidth : 1;
  const virtualHeight = height > 0 ? height / scale : 0;

  return {width, height, virtualWidth, virtualHeight, scale};
}
