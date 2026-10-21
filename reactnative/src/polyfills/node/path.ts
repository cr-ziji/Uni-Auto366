/**
 * Node `path` polyfill for React Native.
 *
 * The sandbox layout is POSIX on every platform, therefore the POSIX flavour
 * of `path` is the primary implementation. `path-browserify` provides it, but
 * it only ships the POSIX variant (`path.win32` is `null`), so a small
 * `win32` emulation is added on top of it.
 *
 * `path.resolve()` and `path.relative()` resolve relative paths against
 * `process.cwd()`. On the desktop that was the application root; on React
 * Native it is the writable data directory (`appDataDirectory`), so the
 * working directory is injected here instead of relying on the global
 * `process` shim.
 */
import pathBrowserify from 'path-browserify';
import {workingDirectory} from '../../runtime/paths';

export interface PathApi {
  resolve(...paths: string[]): string;
  normalize(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  basename(path: string, ext?: string): string;
  extname(path: string): string;
  format(pathObject: any): string;
  parse(path: string): any;
  sep: string;
  delimiter: string;
}

const posix = pathBrowserify as unknown as PathApi;

/** Translates Windows separators into POSIX ones. */
function toPosix(value: string): string {
  return String(value ?? '').replace(/\\/g, '/');
}

/** Translates POSIX separators into Windows ones. */
function toWin32(value: string): string {
  return String(value ?? '').replace(/\//g, '\\');
}

/**
 * A pragmatic `path.win32` emulation.
 *
 * It reuses the POSIX algorithms and only translates the separators, so the
 * drive-letter semantics of Node (`path.win32.relative('C:\\a', 'D:\\b')`)
 * are simplified. The desktop sources never touch `path.win32`.
 */
function createWin32(): PathApi {
  return {
    sep: '\\',
    delimiter: ';',
    isAbsolute(target: string): boolean {
      const value = String(target ?? '');
      return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
    },
    normalize(target: string): string {
      return toWin32(posix.normalize(toPosix(target)));
    },
    join(...parts: string[]): string {
      return toWin32(posix.join(...parts.map(toPosix)));
    },
    resolve(...parts: string[]): string {
      return toWin32(posix.resolve(workingDirectory, ...parts.map(toPosix)));
    },
    relative(from: string, to: string): string {
      return toWin32(posix.relative(toPosix(from), toPosix(to)));
    },
    dirname(target: string): string {
      return toWin32(posix.dirname(toPosix(target)));
    },
    basename(target: string, ext?: string): string {
      return toWin32(posix.basename(toPosix(target), ext));
    },
    extname(target: string): string {
      return posix.extname(toPosix(target));
    },
    format(pathObject: any): string {
      return toWin32(posix.format(pathObject));
    },
    parse(target: string): any {
      return posix.parse(toPosix(target));
    },
  };
}

const win32 = createWin32();

/** `path.resolve()` anchored at the mobile working directory. */
function resolve(...parts: string[]): string {
  return posix.resolve(workingDirectory, ...parts.map(toPosix));
}

/** `path.relative()` with both sides resolved against the working directory. */
function relative(from: string, to: string): string {
  return posix.relative(resolve(from), resolve(to));
}

const path: PathApi & {posix: PathApi; win32: PathApi} = {
  resolve,
  normalize: (value: string) => posix.normalize(value),
  isAbsolute: (value: string) => posix.isAbsolute(value),
  join: (...parts: string[]) => posix.join(...parts),
  relative,
  dirname: (value: string) => posix.dirname(value),
  basename: (value: string, ext?: string) => posix.basename(value, ext),
  extname: (value: string) => posix.extname(value),
  format: (value: any) => posix.format(value),
  parse: (value: string) => posix.parse(value),
  sep: posix.sep,
  delimiter: posix.delimiter,
  posix,
  win32,
};

export const {
  resolve: resolvePath,
  normalize,
  isAbsolute,
  join,
  relative: relativePath,
  dirname,
  basename,
  extname,
  format,
  parse,
  sep,
  delimiter,
} = path;

export {posix, win32, resolve, relative};

export default path;
