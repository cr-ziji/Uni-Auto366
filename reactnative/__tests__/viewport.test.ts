/**
 * Tests of the window geometry.
 *
 * The desktop UI is designed for 1400x900. On a phone the page keeps its
 * desktop *width* and is fitted to the width of the screen by the WebView; the
 * height follows from the screen, so the page fills the available area.
 */
import {
  BASE_HEIGHT,
  BASE_WIDTH,
  resolveViewportLayout,
} from '../src/components/WindowManager/viewport';

describe('the viewport layout', () => {
  it('uses the desktop width by default', () => {
    expect(BASE_WIDTH).toBe(1400);
    expect(BASE_HEIGHT).toBe(900);
  });

  it('fits the desktop width onto the screen', () => {
    const layout = resolveViewportLayout(360, 740);
    expect(layout.virtualWidth).toBe(1400);
    expect(layout.scale).toBeCloseTo(360 / 1400);
    expect(layout.width).toBe(360);
    expect(layout.height).toBe(740);
  });

  it('derives the page height from the screen instead of the desktop height', () => {
    const layout = resolveViewportLayout(360, 740);
    // 740 dp / (360 / 1400) = 2877.8 CSS px - the page is taller than 900,
    // which is exactly what "fill the available area" means.
    expect(layout.virtualHeight).toBeCloseTo(740 / (360 / 1400));
    expect(layout.virtualHeight).toBeGreaterThan(BASE_HEIGHT);
  });

  it('does not lock the aspect ratio', () => {
    const tall = resolveViewportLayout(360, 740);
    const short = resolveViewportLayout(360, 500);
    expect(tall.scale).toBeCloseTo(short.scale);
    expect(tall.virtualHeight).toBeGreaterThan(short.virtualHeight);
  });

  it('uses the width of the window as the virtual width', () => {
    const simple = resolveViewportLayout(360, 740, 875);
    expect(simple.virtualWidth).toBe(875);
    expect(simple.scale).toBeCloseTo(360 / 875);
  });

  it('falls back to the professional width for a missing or broken width', () => {
    expect(resolveViewportLayout(360, 740, 0).virtualWidth).toBe(BASE_WIDTH);
    expect(resolveViewportLayout(360, 740, Number.NaN).virtualWidth).toBe(BASE_WIDTH);
  });

  it('survives a container that was not measured yet', () => {
    const layout = resolveViewportLayout(0, 0);
    expect(layout.scale).toBe(1);
    expect(layout.virtualHeight).toBe(0);
  });
});
