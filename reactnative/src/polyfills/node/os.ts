/**
 * Node `os` polyfill for React Native.
 *
 * React Native has no home directory, no process table and no shell, so the
 * desktop semantics are mapped onto the application sandbox:
 *
 *   os.homedir() -> <Documents>          (the desktop "home")
 *   os.tmpdir()  -> <Documents>/../tmp    (react-native-fs temporary dir)
 *
 * Everything else reports a stable, harmless placeholder instead of faking
 * system information that does not exist on a phone.
 */
import {Platform} from 'react-native';
import {
  appDataDirectory,
  cacheDirectory,
  documentDirectory,
  temporaryDirectory,
} from '../../runtime/paths';

/** `linux` / `darwin` / `win32` style platform identifier. */
export function platform(): string {
  switch (Platform.OS) {
    case 'ios':
      return 'ios';
    case 'android':
      return 'android';
    case 'windows':
      return 'win32';
    case 'macos':
      return 'darwin';
    default:
      return 'linux';
  }
}

/** CPU architecture. Every modern phone is arm64 based. */
export function arch(): string {
  return 'arm64';
}

/** Operating system family. */
export function type(): string {
  return 'Linux';
}

/** Kernel release - not available on React Native. */
export function release(): string {
  return '';
}

/** Byte order of the platform. */
export function endianness(): string {
  return 'LE';
}

/** The writable application data directory (`~/.Auto366` on the desktop). */
export function homedir(): string {
  return documentDirectory;
}

/** Scratch space for temporary files. */
export function tmpdir(): string {
  return temporaryDirectory;
}

/** Home directory of the current user. */
export function userInfo(): {username: string; homedir: string; shell: string | null} {
  return {username: 'auto366', homedir: documentDirectory, shell: null};
}

/** Host name - there is none on a phone. */
export function hostname(): string {
  return 'localhost';
}

/** CPU list - not available. */
export function cpus(): any[] {
  return [];
}

/** Total system memory - not available. */
export function totalmem(): number {
  return 0;
}

/** Free system memory - not available. */
export function freemem(): number {
  return 0;
}

/** Network interfaces - not available. */
export function networkInterfaces(): Record<string, any[]> {
  return {};
}

/** Alias kept for API compatibility with newer Node releases. */
export function getNetworkInterfaces(): Record<string, any[]> {
  return networkInterfaces();
}

/** Uptime of the JavaScript context. */
export function uptime(): number {
  const globalProcess = (globalThis as any).process;
  if (globalProcess && typeof globalProcess.uptime === 'function') {
    return globalProcess.uptime();
  }
  return 0;
}

/** Line terminator used by `console.log`. */
export const EOL: string = '\n';

/** Sandbox directories, exported for convenience. */
export {appDataDirectory, cacheDirectory, documentDirectory, temporaryDirectory};

const os = {
  platform,
  arch,
  type,
  release,
  endianness,
  homedir,
  tmpdir,
  userInfo,
  hostname,
  cpus,
  totalmem,
  freemem,
  networkInterfaces,
  getNetworkInterfaces,
  uptime,
  EOL,
  appDataDirectory,
  cacheDirectory,
  documentDirectory,
  temporaryDirectory,
};

export default os;
