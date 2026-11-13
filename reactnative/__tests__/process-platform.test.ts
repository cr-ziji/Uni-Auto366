/**
 * `process.platform` has to report the platform the app really runs on.
 *
 * The ported main process code branches on it to decide whether a desktop
 * helper is usable (`openspeedy` injector, `taskkill`, TUN binaries, console
 * code pages). Reporting `win32` made all of those believe they were on
 * Windows, so the failure showed up much later and with a misleading message.
 */
import {Platform} from 'react-native';

import {installProcessGlobals, platform} from '../src/polyfills/node/process';
import {platform as osPlatform} from '../src/polyfills/node/os';

describe('process.platform', () => {
  it('reports a mobile platform', () => {
    expect(['android', 'ios']).toContain(platform);
    expect(platform).not.toBe('win32');
    expect(platform).not.toBe('darwin');
  });

  it('agrees with os.platform() and the React Native platform', () => {
    expect(platform).toBe(osPlatform());
    expect(platform).toBe(Platform.OS);
  });

  it('is exposed on the global process object', () => {
    installProcessGlobals();
    expect((globalThis as any).process.platform).toBe(platform);
  });
});
