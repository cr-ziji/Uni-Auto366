/**
 * The E2RN bootstrap.
 *
 * The React Native host boots the ORIGINAL, UNMODIFIED Electron main process
 * (`<electron-root>/main.js`). Because the desktop code expects a Node
 * environment, the bootstrap has to prepare everything the original code
 * touches BEFORE the module is evaluated:
 *
 *   1. `process`            - React Native ships a minimal `process`; the
 *                             desktop code uses `process.cwd()`,
 *                             `process.on('uncaughtException')`, ...
 *      Node globals        - `Buffer`, `setImmediate`, `TextDecoder`, ... are
 *                             globals on Node and undefined on Hermes.
 *   2. the file system      - the desktop code uses SYNCHRONOUS `fs` calls, so
 *                             the writable sandbox has to be mirrored in
 *                             memory before the first `readFileSync` happens.
 *   3. the asset server    - `BrowserWindow.loadFile()` resolves the page URL
 *                             against the local web-asset server, therefore the
 *                             server has to listen before the first window is
 *                             created.
 *   4. the app lifecycle   - the desktop `main.js` waits for
 *                             `app.whenReady()`, which has to be resolved here
 *                             (React Native has no equivalent lifecycle event).
 *   5. the Electron shims  - they are resolved through the ModuleMapper
 *                             (`electron` -> `src/shims/electron`), so no
 *                             explicit wiring is needed here.
 *
 * Only AFTER that the original `main.js` is required. Its side effects
 * (registering the IPC handlers, creating the window, starting the proxy)
 * then run exactly like they do on the desktop.
 */
import {hydrateFileSystem} from '../polyfills/node/fs';
import {installNodeGlobals} from '../polyfills/node/globals';
import {installProcessGlobals} from '../polyfills/node/process';
import {startAssetServer} from '../runtime/web/assetServer';
import {markStartupComplete, beginStartup} from '../runtime/startupGate';
import {markAppReady} from '../shims/electron/app';

export interface BootstrapResult {
  /** `true` when the original main process was loaded. */
  ok: boolean;
  /** The error that prevented the start (if any). */
  error?: any;
}

let started = false;
let pending: Promise<BootstrapResult> | null = null;

/**
 * Requires the original Electron main process.
 *
 * The path is relative to this file: `reactnative/src/bootstrap` -> up three
 * levels -> the Electron project root. Metro follows the relative request and
 * bundles the original sources as they are.
 */
export function requireDesktopMain(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../../main.js');
}

/** Runs the whole bootstrap exactly once. */
export async function bootstrapE2RN(): Promise<BootstrapResult> {
  if (pending) {
    return pending;
  }
  started = true;
  beginStartup();

  pending = (async (): Promise<BootstrapResult> => {
    try {
      // Start-up is the only place where a slow step blocks every IPC call
      // (the WebView page is already running and calling `invoke`), so each
      // stage is timed - "the app takes 40 s to start" is otherwise very hard
      // to attribute.
      const startedAt = Date.now();
      let mark = startedAt;
      const stage = (label: string) => {
        const now = Date.now();
        console.log(`[e2rn] startup: ${label} ${now - mark} ms`);
        mark = now;
      };

      // 1. the `process` global and the other Node globals (`Buffer`, ...)
      installProcessGlobals();
      installNodeGlobals();
      stage('node globals');

      // 2 + 3. the writable sandbox and the local web-asset server.
      //
      // They are independent: hydrating only touches the device file system,
      // the server only needs the bundled manifest. Running them in parallel
      // removes one whole stage from the critical path.
      const parallelStart = Date.now();
      const finish = (label: string) => () =>
        console.log(
          `[e2rn] startup: ${label} +${Date.now() - parallelStart} ms (parallel)`,
        );
      await Promise.all([
        hydrateFileSystem().then(finish('file system mirror')),
        startAssetServer().then(finish('asset server')),
      ]);
      stage('file system mirror + asset server');

      // 4. mark Electron app ready before loading the original main process
      markAppReady();
      stage('app ready');

      // 5. the original, unmodified main process
      requireDesktopMain();
      stage('desktop main process');
      console.log(`[e2rn] the Auto366 main process has been started (${Date.now() - startedAt} ms)`);
      return {ok: true};
    } catch (error) {
      console.error('[e2rn] the Auto366 main process could not be started', error);
      return {ok: false, error};
    } finally {
      // Releases the IPC bridge: calls the page made while the main process was
      // still booting are held back until the handlers exist.
      markStartupComplete();
    }
  })();

  return pending;
}

/** `true` when the bootstrap has been invoked. */
export function isStarted(): boolean {
  return started;
}

export default bootstrapE2RN;
