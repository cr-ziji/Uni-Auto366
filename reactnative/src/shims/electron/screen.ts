/**
 * `screen` - the Electron screen shim.
 *
 * The desktop application only uses the primary display to read the system
 * scale factor, therefore the React Native display metrics are used.
 */
import {Dimensions, PixelRatio} from 'react-native';

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Display {
  id: number;
  bounds: Rectangle;
  workArea: Rectangle;
  size: {width: number; height: number};
  workAreaSize: {width: number; height: number};
  scaleFactor: number;
  rotation: number;
  touchSupport: 'unknown';
  monochrome: boolean;
  accelerometerSupport: 'unknown';
  colorSpace: string;
  depthPerComponent: number;
  displayFrequency: number;
  internal: boolean;
  label: string;
}

function currentScaleFactor(): number {
  try {
    // The desktop scale factor is 1 or 2 - a phone reports up to 4.
    return Math.min(Math.max(PixelRatio.get(), 1), 2);
  } catch {
    return 2;
  }
}

function primaryDisplay(): Display {
  const window = Dimensions.get('window');
  const screen = Dimensions.get('screen');
  const width = window?.width ?? screen?.width ?? 0;
  const height = window?.height ?? screen?.height ?? 0;
  const scaleFactor = currentScaleFactor();
  return {
    id: 0,
    bounds: {x: 0, y: 0, width, height},
    workArea: {x: 0, y: 0, width, height},
    size: {width, height},
    workAreaSize: {width, height},
    scaleFactor,
    rotation: 0,
    touchSupport: 'unknown',
    monochrome: false,
    accelerometerSupport: 'unknown',
    colorSpace: 'srgb',
    depthPerComponent: 8,
    displayFrequency: 60,
    internal: true,
    label: 'Built-in Display',
  };
}

export const screen = {
  /** The primary display of the device. */
  getPrimaryDisplay(): Display {
    return primaryDisplay();
  },

  /** Every display - a phone only has one. */
  getAllDisplays(): Display[] {
    return [primaryDisplay()];
  },

  /** The display that is nearest to the given point. */
  getDisplayNearestPoint(_point: {x: number; y: number}): Display {
    return primaryDisplay();
  },

  /** The display that matches the given rectangle. */
  getDisplayMatching(_rect: Rectangle): Display {
    return primaryDisplay();
  },

  /** The position of the mouse pointer. */
  getCursorScreenPoint(): {x: number; y: number} {
    return {x: 0, y: 0};
  },

  /** Width of the screen in DIP. */
  get width(): number {
    return primaryDisplay().size.width;
  },

  /** Height of the screen in DIP. */
  get height(): number {
    return primaryDisplay().size.height;
  },

  /** Width of the work area in DIP. */
  get availableWidth(): number {
    return primaryDisplay().workAreaSize.width;
  },

  /** Height of the work area in DIP. */
  get availableHeight(): number {
    return primaryDisplay().workAreaSize.height;
  },
};

export default screen;
