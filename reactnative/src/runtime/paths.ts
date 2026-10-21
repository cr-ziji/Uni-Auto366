/**
 * Well-known sandbox locations for the React Native build.
 *
 * The Electron build resolves everything relative to `os.homedir()` and
 * `process.cwd()`. Mobile has no home directory, so both are mapped into the
 * application documents directory:
 *
 *   os.homedir()   -> <Documents>              (the desktop "home")
 *   process.cwd()  -> <Documents>/.Auto366     (the desktop working directory)
 *
 * Two path spaces exist:
 *  - the **data root** (`appDataDirectory`) holds everything the app writes
 *    (settings, rules, answers, logs, cache, temp). It is writable.
 *  - the **virtual app root** (`virtualAppRoot` = `/app`) exposes the read-only
 *    files that were bundled into the JS bundle (`index.html`, `styles/`,
 *    `renderer/`, `rulesets/`, `resources/`, ...). It matches the virtual
 *    `__dirname` that `babel-plugin-e2rn-dirname.js` injects into the original
 *    Electron sources, so `path.join(__dirname, '../..')` keeps resolving to
 *    the app root exactly like on the desktop.
 *
 * The file system polyfill resolves reads in this order:
 *   1. in-memory mirror (writes are applied here first, so sync reads see them)
 *   2. the real device file system (react-native-fs)
 *   3. the bundled asset store, relative to the data root (this is how
 *      `<dataRoot>/rulesets/...` finds the bundled rule sets)
 */
import RNFS from 'react-native-fs';

export const documentDirectory: string = RNFS.DocumentDirectoryPath;
export const cacheDirectory: string = RNFS.CachesDirectoryPath;
export const temporaryDirectory: string = RNFS.TemporaryDirectoryPath;

/**
 * Root of the per-application data folder (`~/.Auto366` on desktop).
 * `os.homedir()` returns the documents directory, so the desktop's
 * `path.join(os.homedir(), '.Auto366')` lands here.
 */
export const appDataDirectory: string = `${documentDirectory}/.Auto366`;

/** Writable working directories (mirroring the desktop `process.cwd()` tree). */
export const tempDirectory: string = `${appDataDirectory}/temp`;
export const answersDirectory: string = `${appDataDirectory}/answers`;
export const fileDirectory: string = `${appDataDirectory}/file`;
export const logsDirectory: string = `${appDataDirectory}/logs`;
export const cacheDataDirectory: string = `${appDataDirectory}/cache`;
export const resourcesDirectory: string = `${appDataDirectory}/resources`;
export const rulesetsDirectory: string = `${appDataDirectory}/rulesets`;

/** Virtual root of the read-only bundled application files. */
export const virtualAppRoot: string = '/app';

/** Value returned by `process.cwd()`. */
export const workingDirectory: string = appDataDirectory;
