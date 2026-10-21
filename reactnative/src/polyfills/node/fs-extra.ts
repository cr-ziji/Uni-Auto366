/**
 * Node `fs-extra` polyfill for React Native.
 *
 * `fs-extra` is a superset of `fs`: it re-exports the whole Node core API and
 * adds a handful of convenience helpers (`ensureDir`, `outputJson`, `copy`,
 * `remove`, ...). The mobile file system itself is implemented by the `fs`
 * polyfill (see `./fs.ts`), which keeps an in-memory mirror of every file that
 * has been written so that synchronous reads stay consistent with the
 * asynchronous ones.
 *
 * The helpers are implemented on top of the `fs` polyfill, therefore they
 * inherit its semantics:
 *
 *   - writes update the mirror immediately and are persisted asynchronously,
 *   - synchronous reads fall back to the bundled assets when a file is not
 *     part of the mirror,
 *   - unknown files raise an `ENOENT` error.
 */
import {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  closeSync,
  constants,
  copyFile,
  copyFileSync,
  createReadStream,
  createWriteStream,
  exists,
  existsSync,
  fstatSync,
  fdatasyncSync,
  fsyncSync,
  flushPendingWrites,
  hydrateFileSystem,
  lstat,
  lstatSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  open,
  openSync,
  opendir,
  pathExists as fsPathExists,
  promises as fsPromises,
  readFile,
  readFileBuffer,
  readFileSync,
  readdir,
  readdirSync,
  readSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  utimes,
  utimesSync,
  writeFile,
  writeFileSync,
  writeSync,
} from './fs';
import {dirname, join, resolve} from './path';

export type {Dirent, FileHandle, FileStats} from './fs';
export {Stats} from './fs';

export interface CopyOptions {
  overwrite?: boolean;
  preserveTimestamps?: boolean;
  errorOnExist?: boolean;
  dereference?: boolean;
  filter?: (source: string, destination: string) => boolean | Promise<boolean>;
}

export interface JsonOptions {
  spaces?: number | string;
  EOL?: string;
  mode?: number | string;
  encoding?: string;
  flag?: string;
}

export interface OutputJsonOptions extends JsonOptions {
  replacer?: (key: string, value: any) => any;
}

export interface WriteJsonOptions extends JsonOptions {
  replacer?: (key: string, value: any) => any;
}

/* -------------------------------------------------------------------------- */
/* Directories                                                                */
/* -------------------------------------------------------------------------- */

/** Creates a directory (and every missing parent) if it does not exist yet. */
export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, {recursive: true});
}

/** Synchronous variant of {@link ensureDir}. */
export function ensureDirSync(directory: string): void {
  mkdirSync(directory, {recursive: true});
}

/** Legacy `fs-extra` alias of {@link ensureDir}. */
export async function mkdirp(directory: string, callback?: (error?: NodeJS.ErrnoException | null) => void): Promise<void> {
  try {
    await ensureDir(directory);
    callback?.(null);
  } catch (error) {
    callback?.(error as NodeJS.ErrnoException);
    throw error;
  }
}

/** Legacy `fs-extra` alias of {@link ensureDirSync}. */
export function mkdirpSync(directory: string): void {
  ensureDirSync(directory);
}

/** Creates an empty file (and its parent directories) when it is missing. */
export async function ensureFile(file: string): Promise<void> {
  await ensureDir(dirname(file));
  if (!(await pathExists(file))) {
    await writeFile(file, '');
  }
}

/** Synchronous variant of {@link ensureFile}. */
export function ensureFileSync(file: string): void {
  ensureDirSync(dirname(file));
  if (!existsSync(file)) {
    writeFileSync(file, '');
  }
}

/** Removes the content of a directory but keeps the directory itself. */
export async function emptyDir(directory: string): Promise<void> {
  await ensureDir(directory);
  const entries = await readdir(directory);
  for (const entry of entries) {
    await rm(join(directory, String(entry)), {recursive: true, force: true});
  }
}

/** Synchronous variant of {@link emptyDir}. */
export function emptyDirSync(directory: string): void {
  ensureDirSync(directory);
  const entries = readdirSync(directory) as unknown as string[];
  for (const entry of entries) {
    rmSync(join(directory, entry), {recursive: true, force: true});
  }
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

/** Writes a file and creates the missing parent directories. */
export async function outputFile(file: string, data: any, options?: any): Promise<void> {
  await ensureDir(dirname(file));
  await writeFile(file, data, options);
}

/** Synchronous variant of {@link outputFile}. */
export function outputFileSync(file: string, data: any, options?: any): void {
  ensureDirSync(dirname(file));
  writeFileSync(file, data, options);
}

function serializeJson(value: any, options?: JsonOptions & {replacer?: (key: string, value: any) => any}): string {
  const replacer = options?.replacer;
  const spaces = options?.spaces;
  const eol = options?.EOL ?? '\n';
  const text = JSON.stringify(value, replacer as any, spaces as any) ?? 'null';
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/** Writes a JSON document and creates the missing parent directories. */
export async function outputJson(file: string, value: any, options?: OutputJsonOptions): Promise<void> {
  await outputFile(file, serializeJson(value, options), {encoding: options?.encoding ?? 'utf8'});
}

/** Synchronous variant of {@link outputJson}. */
export function outputJsonSync(file: string, value: any, options?: OutputJsonOptions): void {
  outputFileSync(file, serializeJson(value, options), {encoding: options?.encoding ?? 'utf8'});
}

/** Reads and parses a JSON document. */
export async function readJson(file: string, options?: JsonOptions): Promise<any> {
  const text = await readFile(file, {encoding: options?.encoding ?? 'utf8'} as any);
  return JSON.parse(typeof text === 'string' ? text : String(text));
}

/** Synchronous variant of {@link readJson}. */
export function readJsonSync(file: string, options?: JsonOptions): any {
  const text = readFileSync(file, {encoding: options?.encoding ?? 'utf8'} as any);
  return JSON.parse(typeof text === 'string' ? text : String(text));
}

/** Writes a JSON document (without creating parent directories). */
export async function writeJson(file: string, value: any, options?: WriteJsonOptions): Promise<void> {
  await writeFile(file, serializeJson(value, options), {encoding: options?.encoding ?? 'utf8'});
}

/** Synchronous variant of {@link writeJson}. */
export function writeJsonSync(file: string, value: any, options?: WriteJsonOptions): void {
  writeFileSync(file, serializeJson(value, options), {encoding: options?.encoding ?? 'utf8'});
}

/* -------------------------------------------------------------------------- */
/* Existence                                                                  */
/* -------------------------------------------------------------------------- */

/** `true` when the path exists (file or directory). */
export async function pathExists(target: string): Promise<boolean> {
  return fsPathExists(target);
}

/** Synchronous variant of {@link pathExists}. */
export function pathExistsSync(target: string): boolean {
  return existsSync(target);
}

/* -------------------------------------------------------------------------- */
/* Copy / move / remove                                                       */
/* -------------------------------------------------------------------------- */

async function copyRecursive(
  source: string,
  destination: string,
  options: CopyOptions,
): Promise<void> {
  if (options.filter) {
    const accepted = await options.filter(source, destination);
    if (!accepted) {
      return;
    }
  }
  const stats = await lstat(source);
  if (stats.isDirectory()) {
    await mkdir(destination, {recursive: true});
    const entries = (await readdir(source)) as unknown as string[];
    for (const entry of entries) {
      await copyRecursive(join(source, entry), join(destination, entry), options);
    }
    if (options.preserveTimestamps) {
      try {
        await utimes(destination, stats.atime, stats.mtime);
      } catch {
        /* timestamps are best effort */
      }
    }
    return;
  }
  if (!options.overwrite && (await pathExists(destination))) {
    if (options.errorOnExist) {
      const error = new Error(`EEXIST: file already exists, copyfile '${destination}'`) as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      error.path = destination;
      error.syscall = 'copyfile';
      throw error;
    }
    return;
  }
  await ensureDir(dirname(destination));
  const data = await readFileBuffer(source);
  await writeFile(destination, data);
}

function copyRecursiveSync(source: string, destination: string, options: CopyOptions): void {
  if (options.filter) {
    const accepted = options.filter(source, destination);
    if (accepted === false) {
      return;
    }
  }
  const stats = statSync(source);
  if (stats.isDirectory()) {
    mkdirSync(destination, {recursive: true});
    const entries = readdirSync(source) as unknown as string[];
    for (const entry of entries) {
      copyRecursiveSync(join(source, entry), join(destination, entry), options);
    }
    if (options.preserveTimestamps) {
      try {
        utimesSync(destination, stats.atime, stats.mtime);
      } catch {
        /* timestamps are best effort */
      }
    }
    return;
  }
  if (!options.overwrite && existsSync(destination)) {
    if (options.errorOnExist) {
      const error = new Error(`EEXIST: file already exists, copyfile '${destination}'`) as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      error.path = destination;
      error.syscall = 'copyfile';
      throw error;
    }
    return;
  }
  ensureDirSync(dirname(destination));
  const data = readFileSync(source);
  writeFileSync(destination, data as any);
}

/** Copies a file or a directory tree. */
export async function copy(source: string, destination: string, options?: CopyOptions | ((error?: Error) => void)): Promise<void> {
  const callback = typeof options === 'function' ? options : undefined;
  const settings = (typeof options === 'function' ? {} : options ?? {}) as CopyOptions;
  try {
    await copyRecursive(resolve(source), resolve(destination), settings);
    callback?.(undefined);
  } catch (error) {
    callback?.(error as Error);
    throw error;
  }
}

/** Synchronous variant of {@link copy}. */
export function copySync(source: string, destination: string, options?: CopyOptions | ((error?: Error) => void)): void {
  const callback = typeof options === 'function' ? options : undefined;
  const settings = (typeof options === 'function' ? {} : options ?? {}) as CopyOptions;
  try {
    copyRecursiveSync(resolve(source), resolve(destination), settings);
    callback?.(undefined);
  } catch (error) {
    callback?.(error as Error);
    throw error;
  }
}

/** Moves a file or a directory tree. */
export async function move(source: string, destination: string, options?: {overwrite?: boolean}): Promise<void> {
  const from = resolve(source);
  const to = resolve(destination);
  if (options?.overwrite === false && (await pathExists(to))) {
    const error = new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
    error.code = 'EEXIST';
    error.path = to;
    error.syscall = 'rename';
    throw error;
  }
  try {
    await rename(from, to);
    return;
  } catch {
    /* fall back to copy + remove (e.g. across file system roots) */
  }
  await copy(from, to, {overwrite: true});
  await rm(from, {recursive: true, force: true});
}

/** Synchronous variant of {@link move}. */
export function moveSync(source: string, destination: string, options?: {overwrite?: boolean}): void {
  const from = resolve(source);
  const to = resolve(destination);
  if (options?.overwrite === false && existsSync(to)) {
    const error = new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
    error.code = 'EEXIST';
    error.path = to;
    error.syscall = 'rename';
    throw error;
  }
  try {
    renameSync(from, to);
    return;
  } catch {
    /* fall back to copy + remove */
  }
  copySync(from, to, {overwrite: true});
  rmSync(from, {recursive: true, force: true});
}

/** Removes a file or a directory tree, ignoring missing paths. */
export async function remove(target: string): Promise<void> {
  await rm(target, {recursive: true, force: true});
}

/** Synchronous variant of {@link remove}. */
export function removeSync(target: string): void {
  rmSync(target, {recursive: true, force: true});
}

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */

export {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  closeSync,
  constants,
  copyFile,
  copyFileSync,
  createReadStream,
  createWriteStream,
  exists,
  existsSync,
  fstatSync,
  fdatasyncSync,
  flushPendingWrites,
  fsyncSync,
  hydrateFileSystem,
  lstat,
  lstatSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  open,
  openSync,
  opendir,
  readFile,
  readFileBuffer,
  readFileSync,
  readdir,
  readdirSync,
  readSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  utimes,
  utimesSync,
  writeFile,
  writeFileSync,
  writeSync,
};

/** `fs-extra` flavoured promise API. */
export const promises = {
  ...fsPromises,
  copy,
  emptyDir,
  ensureDir,
  ensureFile,
  move,
  outputFile,
  outputJson,
  pathExists,
  readJson,
  remove,
  writeJson,
};

const fsExtra = {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  closeSync,
  constants,
  copy,
  copyFile,
  copyFileSync,
  copySync,
  createReadStream,
  createWriteStream,
  emptyDir,
  emptyDirSync,
  ensureDir,
  ensureDirSync,
  ensureFile,
  ensureFileSync,
  exists,
  existsSync,
  fstatSync,
  fdatasyncSync,
  flushPendingWrites,
  fsyncSync,
  hydrateFileSystem,
  lstat,
  lstatSync,
  mkdir,
  mkdirp,
  mkdirpSync,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  move,
  moveSync,
  open,
  openSync,
  opendir,
  outputFile,
  outputFileSync,
  outputJson,
  outputJsonSync,
  pathExists,
  pathExistsSync,
  promises,
  readFile,
  readFileBuffer,
  readFileSync,
  readJson,
  readJsonSync,
  readSync,
  readdir,
  readdirSync,
  realpath,
  realpathSync,
  remove,
  removeSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  utimes,
  utimesSync,
  writeFile,
  writeFileSync,
  writeJson,
  writeJsonSync,
  writeSync,
};

export default fsExtra;
