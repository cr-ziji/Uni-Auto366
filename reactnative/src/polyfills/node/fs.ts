/**
 * Node `fs` / `fs/promises` / `original-fs` polyfill for React Native.
 *
 * `react-native-fs` only offers an asynchronous API, but the ported desktop
 * modules rely heavily on the synchronous one (`fs.readFileSync`,
 * `fs.existsSync`, `fs.readdirSync`, ...). This polyfill therefore keeps an
 * in-memory mirror of the writable sandbox:
 *
 *   1. every write updates the mirror immediately, so a following
 *      synchronous read observes it;
 *   2. the mirror is persisted to the device asynchronously (queued per path
 *      so that the order of the writes is preserved);
 *   3. `hydrateFileSystem()` loads the data directory into the mirror before
 *      the desktop sources are evaluated, which makes the synchronous API
 *      work for everything that was written during a previous session.
 *
 * Read resolution order for an absolute path `P`:
 *
 *   1. `P` below the virtual app root (`/app`)  -> bundled asset store
 *      (read only);
 *   2. the mirror;
 *   3. the device file system;
 *   4. `P` below the data root, relative to the data root -> bundled asset
 *      store (this is how `<dataRoot>/rulesets/...` finds the bundled rule
 *      sets).
 *
 * Synchronous reads cannot touch the device, therefore they fall back to the
 * bundled asset store and finally raise `ENOENT`.
 */
import RNFS from 'react-native-fs';
import {Buffer} from 'buffer';
import {Readable, Writable} from 'stream';
import {
  appDataDirectory,
  temporaryDirectory,
  virtualAppRoot,
  workingDirectory,
} from '../../runtime/paths';
import {
  assetExistsSync,
  assetIsDirectorySync,
  assetReadFileSync,
  assetReaddirSync,
  assetStatSync,
} from '../../web-assets/fs';

export type FsEncoding = 'utf8' | 'utf-8' | 'base64' | 'ascii' | 'latin1' | 'binary' | 'hex';

export interface FileStats {
  size: number;
  mode: number;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  atime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface Dirent {
  name: string;
  path: string;
  parentPath: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The shape of an open file handle. */
export interface FileHandleLike {
  read(
    buffer: Buffer,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{bytesRead: number; buffer: Buffer}>;
  write(
    buffer: Buffer,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{bytesWritten: number; buffer: Buffer}>;
  readFile(): Promise<Buffer>;
  writeFile(data: Buffer | string, encoding?: string): Promise<void>;
  close(): Promise<void>;
  stat(): Promise<FileStats>;
  truncate(length?: number): Promise<void>;
  sync(): Promise<void>;
  readv(buffers: Buffer[], position?: number | null): Promise<{bytesRead: number}>;
  writev(buffers: Buffer[], position?: number | null): Promise<{bytesWritten: number}>;
  readonly fd: number;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

const ERRNO: Record<string, number> = {
  EPERM: -1,
  ENOENT: -2,
  EINTR: -4,
  EIO: -5,
  EBADF: -9,
  EAGAIN: -11,
  EACCES: -13,
  EBUSY: -16,
  EEXIST: -17,
  EXDEV: -18,
  ENODEV: -19,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  EMFILE: -24,
  ENFILE: -23,
  ENOSPC: -28,
  EPIPE: -32,
  EROFS: -30,
  ENOTEMPTY: -39,
  ELOOP: -40,
};

function createError(code: string, syscall: string, target: string, description?: string): NodeJS.ErrnoException {
  const message = `${code}: ${description ?? codeToDescription(code)}, '${target}'`;
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = ERRNO[code] ?? -2;
  error.path = target;
  error.syscall = syscall;
  return error;
}

function codeToDescription(code: string): string {
  switch (code) {
    case 'ENOENT':
      return 'no such file or directory';
    case 'EEXIST':
      return 'file already exists';
    case 'EACCES':
      return 'permission denied';
    case 'EISDIR':
      return 'illegal operation on a directory';
    case 'ENOTDIR':
      return 'not a directory';
    case 'ENOTEMPTY':
      return 'directory not empty';
    case 'EROFS':
      return 'read-only file system';
    case 'EISDIR':
      return 'illegal operation on a directory';
    default:
      return code.toLowerCase();
  }
}

function enoent(target: string, syscall = 'open'): NodeJS.ErrnoException {
  return createError('ENOENT', syscall, target);
}

/* -------------------------------------------------------------------------- */
/* Path helpers                                                               */
/* -------------------------------------------------------------------------- */

function normalizePath(value: string): string {
  const absolute = value.startsWith('/');
  const segments: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const joined = segments.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

function resolveTarget(target: string | number | {toString(): string}): string {
  let value = String(target ?? '');
  if (value.startsWith('file://')) {
    value = decodeURIComponent(value.slice('file://'.length));
  }
  if (!value.startsWith('/')) {
    value = `${workingDirectory}/${value}`;
  }
  return normalizePath(value);
}

function dirnameOf(target: string): string {
  const index = target.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return target.slice(0, index);
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root).replace(/\/+$/, '');
  const normalizedTarget = normalizePath(target);
  if (normalizedRoot === '') {
    return false;
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/**
 * Asset store key for a path, or `null` when the path does not belong to the
 * bundled assets.
 */
function assetKeyFor(target: string): string | null {
  if (isInside(virtualAppRoot, target)) {
    const relative = target.slice(virtualAppRoot.length + 1);
    return relative || null;
  }
  if (isInside(appDataDirectory, target)) {
    const relative = target.slice(appDataDirectory.length + 1);
    return relative || null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Mirror                                                                     */
/* -------------------------------------------------------------------------- */

/** In-memory copy of every file of the writable sandbox. */
const fileMirror = new Map<string, Buffer>();
/** In-memory copy of every known directory of the writable sandbox. */
const directoryMirror = new Set<string>();
/** Pending device writes, one queue per path. */
const writeQueues = new Map<string, Promise<void>>();

/** Last error that happened while persisting a file to the device. */
let lastPersistenceError: Error | null = null;

function queueWrite(target: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(
    target,
    next.catch(error => {
      lastPersistenceError = error as Error;
    }),
  );
  return next;
}

function reportPersistenceError(target: string, error: unknown): void {
  lastPersistenceError = error as Error;
  console.warn(`[e2rn] fs: failed to persist "${target}"`, error);
}

/** Waits until every queued device write has been flushed. */
export async function flushPendingWrites(): Promise<void> {
  while (writeQueues.size > 0) {
    await Promise.all(Array.from(writeQueues.values()));
    for (const [key, value] of Array.from(writeQueues.entries())) {
      // The queue entry is replaced by a settled promise, so it can be dropped.
      void value;
      writeQueues.delete(key);
    }
  }
}

/** The error of the last failed device write (if any). */
export function getLastPersistenceError(): Error | null {
  return lastPersistenceError;
}

/* -------------------------------------------------------------------------- */
/* Device helpers                                                             */
/* -------------------------------------------------------------------------- */

async function deviceExists(target: string): Promise<boolean> {
  try {
    return await RNFS.exists(target);
  } catch {
    return false;
  }
}

async function ensureDeviceDirectory(directory: string): Promise<void> {
  const normalized = normalizePath(directory).replace(/\/+$/, '');
  if (!normalized || normalized === '/') {
    return;
  }
  if (await deviceExists(normalized)) {
    return;
  }
  const parent = dirnameOf(normalized);
  if (parent !== normalized) {
    await ensureDeviceDirectory(parent);
  }
  try {
    await RNFS.mkdir(normalized);
  } catch (error) {
    if (!(await deviceExists(normalized))) {
      throw error;
    }
  }
}

async function persistFile(target: string, buffer: Buffer): Promise<void> {
  await ensureDeviceDirectory(dirnameOf(target));
  await RNFS.writeFile(target, buffer.toString('base64'), 'base64');
}

async function readDeviceFile(target: string): Promise<Buffer | null> {
  if (!(await deviceExists(target))) {
    return null;
  }
  try {
    const base64 = await RNFS.readFile(target, 'base64');
    return Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Encoding helpers                                                           */
/* -------------------------------------------------------------------------- */

function normalizeEncoding(encoding?: string | null): string | null {
  if (!encoding || encoding === 'buffer') {
    return null;
  }
  const value = String(encoding).toLowerCase();
  if (value === 'utf8') {
    return 'utf8';
  }
  if (value === 'utf-8') {
    return 'utf8';
  }
  if (value === 'base64') {
    return 'base64';
  }
  if (value === 'latin1' || value === 'binary') {
    return 'latin1';
  }
  if (value === 'ascii') {
    return 'ascii';
  }
  if (value === 'hex') {
    return 'hex';
  }
  return value;
}

function toBuffer(data: Buffer | Uint8Array | string, encoding?: string | null): Buffer {
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  const normalized = normalizeEncoding(encoding) ?? 'utf8';
  return Buffer.from(String(data), normalized as BufferEncoding);
}

function decodeBuffer(buffer: Buffer, encoding?: string | null): Buffer | string {
  const normalized = normalizeEncoding(encoding);
  if (!normalized) {
    return buffer;
  }
  return buffer.toString(normalized as BufferEncoding);
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

function createStats(size: number, isDirectory: boolean, mtime: Date = new Date()): FileStats {
  return {
    size,
    mode: isDirectory ? 0o40755 : 0o100644,
    mtime,
    ctime: mtime,
    birthtime: mtime,
    atime: mtime,
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => false,
  };
}

function createDirent(name: string, parent: string, isDirectory: boolean, _size = 0): Dirent {
  const fullPath = parent === '/' ? `/${name}` : `${parent}/${name}`;
  return {
    name,
    path: fullPath,
    parentPath: parent,
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => false,
  };
}

/* -------------------------------------------------------------------------- */
/* Read resolution                                                            */
/* -------------------------------------------------------------------------- */

interface MirrorChild {
  isDirectory: boolean;
  size: number;
}

function mirrorChildren(directory: string): Map<string, MirrorChild> {
  const children = new Map<string, MirrorChild>();
  const prefix = directory === '/' ? '/' : `${directory}/`;
  for (const [file, buffer] of fileMirror) {
    if (!file.startsWith(prefix)) {
      continue;
    }
    const rest = file.slice(prefix.length);
    if (!rest || rest.includes('/')) {
      continue;
    }
    children.set(rest, {isDirectory: false, size: buffer.length});
  }
  for (const known of directoryMirror) {
    if (!known.startsWith(prefix)) {
      continue;
    }
    const rest = known.slice(prefix.length);
    if (!rest || rest.includes('/')) {
      continue;
    }
    children.set(rest, {isDirectory: true, size: 0});
  }
  return children;
}

function assetChildren(target: string): Map<string, MirrorChild> {
  const children = new Map<string, MirrorChild>();
  const key = assetKeyFor(target);
  if (!key) {
    return children;
  }
  let names: string[] = [];
  try {
    names = assetReaddirSync(key);
  } catch {
    return children;
  }
  for (const name of names) {
    const isDirectory = assetIsDirectorySync(`${key}/${name}`);
    children.set(name, {isDirectory, size: 0});
  }
  return children;
}

function readMirror(target: string): Buffer | null {
  return fileMirror.get(target) ?? null;
}

function readAsset(target: string, encoding?: string | null): Buffer | string | null {
  const key = assetKeyFor(target);
  if (!key || !assetExistsSync(key) || assetIsDirectorySync(key)) {
    return null;
  }
  const value = assetReadFileSync(key, 'base64');
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'base64');
  return decodeBuffer(buffer, encoding);
}

/** Existence check against the bundled asset store. */
function assetExists(target: string): boolean {
  const key = assetKeyFor(target);
  return key ? assetExistsSync(key) : false;
}

/** Synchronous read: mirror first, bundled assets second. */
function readFileBytesSync(target: string): Buffer {
  const resolved = resolveTarget(target);
  const mirrored = readMirror(resolved);
  if (mirrored) {
    return mirrored;
  }
  const asset = readAsset(resolved, 'buffer');
  if (asset !== null) {
    return Buffer.isBuffer(asset) ? asset : Buffer.from(asset);
  }
  throw enoent(resolved, 'open');
}

/** Asynchronous read: mirror, device, bundled assets. */
async function readFileBytesAsync(target: string): Promise<Buffer> {
  const resolved = resolveTarget(target);
  if (isInside(virtualAppRoot, resolved)) {
    const asset = readAsset(resolved, 'buffer');
    if (asset === null) {
      throw enoent(resolved, 'open');
    }
    return Buffer.isBuffer(asset) ? asset : Buffer.from(asset);
  }
  const mirrored = readMirror(resolved);
  if (mirrored) {
    return mirrored;
  }
  const fromDevice = await readDeviceFile(resolved);
  if (fromDevice) {
    return fromDevice;
  }
  const asset = readAsset(resolved, 'buffer');
  if (asset !== null) {
    return Buffer.isBuffer(asset) ? asset : Buffer.from(asset);
  }
  throw enoent(resolved, 'open');
}

/* -------------------------------------------------------------------------- */
/* Write helpers                                                              */
/* -------------------------------------------------------------------------- */

function assertWritable(target: string): void {
  if (isInside(virtualAppRoot, target)) {
    throw createError('EROFS', 'open', target, 'read-only file system');
  }
}

function ensureParentDirectories(target: string): void {
  let current = dirnameOf(target);
  const missing: string[] = [];
  while (current && current !== '/' && !directoryMirror.has(current)) {
    missing.push(current);
    const parent = dirnameOf(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  for (const directory of missing.reverse()) {
    directoryMirror.add(directory);
  }
}

function storeFile(target: string, buffer: Buffer): void {
  ensureParentDirectories(target);
  fileMirror.set(target, buffer);
}

/* -------------------------------------------------------------------------- */
/* Hydration                                                                  */
/* -------------------------------------------------------------------------- */

async function hydrateDirectory(directory: string): Promise<void> {
  const normalized = normalizePath(directory);
  directoryMirror.add(normalized);
  let entries: any[] = [];
  try {
    entries = await RNFS.readDir(normalized);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = normalizePath(entry.path ?? `${normalized}/${entry.name}`);
    if (entry.isDirectory?.()) {
      await hydrateDirectory(entryPath);
      continue;
    }
    const buffer = await readDeviceFile(entryPath);
    if (buffer) {
      fileMirror.set(entryPath, buffer);
    }
  }
}

/**
 * Loads the writable sandbox into the in-memory mirror.
 *
 * Has to be awaited before the desktop sources are evaluated, otherwise the
 * synchronous `fs` API cannot see the files of the previous session.
 */
export async function hydrateFileSystem(): Promise<void> {
  try {
    await ensureDeviceDirectory(appDataDirectory);
  } catch (error) {
    reportPersistenceError(appDataDirectory, error);
  }
  try {
    await ensureDeviceDirectory(temporaryDirectory);
  } catch (error) {
    reportPersistenceError(temporaryDirectory, error);
  }
  directoryMirror.add(appDataDirectory);
  directoryMirror.add(temporaryDirectory);
  await hydrateDirectory(appDataDirectory);
}

/* -------------------------------------------------------------------------- */
/* Public API: existence                                                      */
/* -------------------------------------------------------------------------- */

export async function exists(target: string): Promise<boolean> {
  const resolved = resolveTarget(target);
  if (isInside(virtualAppRoot, resolved)) {
    return assetExists(resolved);
  }
  if (fileMirror.has(resolved) || directoryMirror.has(resolved)) {
    return true;
  }
  if (await deviceExists(resolved)) {
    return true;
  }
  return assetExists(resolved);
}

export function existsSync(target: string): boolean {
  const resolved = resolveTarget(target);
  if (isInside(virtualAppRoot, resolved)) {
    return assetExists(resolved);
  }
  if (fileMirror.has(resolved) || directoryMirror.has(resolved)) {
    return true;
  }
  return assetExists(resolved);
}

/** Alias used by `fs-extra`. */
export const pathExists = exists;

/* -------------------------------------------------------------------------- */
/* Public API: reading                                                        */
/* -------------------------------------------------------------------------- */

export async function readFile(
  target: string,
  options?: string | {encoding?: string | null},
): Promise<string | Buffer> {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const buffer = await readFileBytesAsync(target);
  return decodeBuffer(buffer, encoding);
}

export function readFileSync(
  target: string,
  options?: string | {encoding?: string | null},
): string | Buffer {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const buffer = readFileBytesSync(target);
  return decodeBuffer(buffer, encoding);
}

/** Reads a file as raw bytes (no decoding). */
export async function readFileBuffer(target: string): Promise<Buffer> {
  return readFileBytesAsync(target);
}

/* -------------------------------------------------------------------------- */
/* Public API: writing                                                        */
/* -------------------------------------------------------------------------- */

export async function writeFile(
  target: string,
  data: Buffer | Uint8Array | string,
  options?: string | {encoding?: string | null},
): Promise<void> {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const buffer = toBuffer(data, encoding);
  storeFile(resolved, buffer);
  await queueWrite(resolved, () => persistFile(resolved, buffer));
}

export function writeFileSync(
  target: string,
  data: Buffer | Uint8Array | string,
  options?: string | {encoding?: string | null},
): void {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const buffer = toBuffer(data, encoding);
  storeFile(resolved, buffer);
  queueWrite(resolved, () => persistFile(resolved, buffer)).catch(error =>
    reportPersistenceError(resolved, error),
  );
}

export async function appendFile(
  target: string,
  data: Buffer | Uint8Array | string,
  options?: string | {encoding?: string | null},
): Promise<void> {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const addition = toBuffer(data, encoding);
  const current = fileMirror.get(resolved) ?? (await readDeviceFile(resolved)) ?? Buffer.alloc(0);
  const buffer = Buffer.concat([current, addition]);
  storeFile(resolved, buffer);
  await queueWrite(resolved, () => persistFile(resolved, buffer));
}

export function appendFileSync(
  target: string,
  data: Buffer | Uint8Array | string,
  options?: string | {encoding?: string | null},
): void {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const addition = toBuffer(data, encoding);
  const current = fileMirror.get(resolved) ?? Buffer.alloc(0);
  const buffer = Buffer.concat([current, addition]);
  storeFile(resolved, buffer);
  queueWrite(resolved, () => persistFile(resolved, buffer)).catch(error =>
    reportPersistenceError(resolved, error),
  );
}

export async function truncate(target: string, length: number = 0): Promise<void> {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const current = fileMirror.get(resolved) ?? (await readDeviceFile(resolved)) ?? Buffer.alloc(0);
  const buffer = current.subarray(0, Math.max(0, length));
  storeFile(resolved, buffer);
  await queueWrite(resolved, () => persistFile(resolved, buffer));
}

export function truncateSync(target: string, length: number = 0): void {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const current = fileMirror.get(resolved) ?? Buffer.alloc(0);
  const buffer = current.subarray(0, Math.max(0, length));
  storeFile(resolved, buffer);
  queueWrite(resolved, () => persistFile(resolved, buffer)).catch(error =>
    reportPersistenceError(resolved, error),
  );
}

/* -------------------------------------------------------------------------- */
/* Public API: directories                                                    */
/* -------------------------------------------------------------------------- */

export async function mkdir(target: string, options?: {recursive?: boolean; mode?: number}): Promise<void> {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const recursive = options?.recursive === true;
  if (!recursive && directoryMirror.has(resolved)) {
    throw createError('EEXIST', 'mkdir', resolved, 'file already exists');
  }
  ensureParentDirectories(resolved);
  directoryMirror.add(resolved);
  await queueWrite(resolved, async () => {
    await ensureDeviceDirectory(resolved);
  });
}

export function mkdirSync(target: string, options?: {recursive?: boolean; mode?: number}): void {
  const resolved = resolveTarget(target);
  assertWritable(resolved);
  const recursive = options?.recursive === true;
  if (!recursive && directoryMirror.has(resolved)) {
    throw createError('EEXIST', 'mkdir', resolved, 'file already exists');
  }
  ensureParentDirectories(resolved);
  directoryMirror.add(resolved);
  queueWrite(resolved, async () => {
    await ensureDeviceDirectory(resolved);
  }).catch(error => reportPersistenceError(resolved, error));
}

function removeFromMirror(target: string): void {
  const prefix = target === '/' ? '/' : `${target}/`;
  for (const key of Array.from(fileMirror.keys())) {
    if (key === target || key.startsWith(prefix)) {
      fileMirror.delete(key);
    }
  }
  for (const key of Array.from(directoryMirror)) {
    if (key === target || key.startsWith(prefix)) {
      directoryMirror.delete(key);
    }
  }
}

export async function rmdir(target: string, _options?: {recursive?: boolean}): Promise<void> {
  const resolved = resolveTarget(target);
  removeFromMirror(resolved);
  await queueWrite(resolved, async () => {
    try {
      await RNFS.unlink(resolved);
    } catch {
      /* the directory may not exist on the device */
    }
  });
}

export function rmdirSync(target: string, _options?: {recursive?: boolean}): void {
  const resolved = resolveTarget(target);
  removeFromMirror(resolved);
  queueWrite(resolved, async () => {
    try {
      await RNFS.unlink(resolved);
    } catch {
      /* the directory may not exist on the device */
    }
  }).catch(error => reportPersistenceError(resolved, error));
}

export async function readdir(
  target: string,
  options?: {withFileTypes?: boolean; recursive?: boolean},
): Promise<string[] | Dirent[]> {
  const resolved = resolveTarget(target);
  const children = await collectChildren(resolved);
  const names = Array.from(children.keys()).sort();
  if (!options?.withFileTypes) {
    return names;
  }
  return names.map(name => createDirent(name, resolved, children.get(name)!.isDirectory));
}

export function readdirSync(
  target: string,
  options?: {withFileTypes?: boolean; recursive?: boolean},
): string[] | Dirent[] {
  const resolved = resolveTarget(target);
  const children = new Map<string, MirrorChild>([
    ...Array.from(mirrorChildren(resolved).entries()),
    ...Array.from(assetChildren(resolved).entries()),
  ]);
  const names = Array.from(children.keys()).sort();
  if (!options?.withFileTypes) {
    return names;
  }
  return names.map(name => createDirent(name, resolved, children.get(name)!.isDirectory));
}

async function collectChildren(resolved: string): Promise<Map<string, MirrorChild>> {
  const children = mirrorChildren(resolved);
  if (!isInside(virtualAppRoot, resolved)) {
    let entries: any[] = [];
    try {
      entries = await RNFS.readDir(resolved);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!children.has(entry.name)) {
        children.set(entry.name, {isDirectory: entry.isDirectory?.() === true, size: entry.size ?? 0});
      }
    }
  }
  for (const [name, child] of assetChildren(resolved)) {
    if (!children.has(name)) {
      children.set(name, child);
    }
  }
  return children;
}

/* -------------------------------------------------------------------------- */
/* Public API: stat                                                           */
/* -------------------------------------------------------------------------- */

function statFromMirror(resolved: string): FileStats | null {
  const buffer = fileMirror.get(resolved);
  if (buffer) {
    return createStats(buffer.length, false);
  }
  if (directoryMirror.has(resolved)) {
    return createStats(0, true);
  }
  return null;
}

function statFromAsset(resolved: string): FileStats | null {
  const key = assetKeyFor(resolved);
  if (!key || !assetExistsSync(key)) {
    return null;
  }
  const stat = assetStatSync(key);
  return createStats(stat.size, stat.isDirectory());
}

export async function stat(target: string): Promise<FileStats> {
  const resolved = resolveTarget(target);
  const mirrored = statFromMirror(resolved);
  if (mirrored) {
    return mirrored;
  }
  if (!isInside(virtualAppRoot, resolved) && (await deviceExists(resolved))) {
    try {
      const raw = (await RNFS.stat(resolved)) as any;
      const mtime = raw.mtime instanceof Date ? raw.mtime : new Date(raw.mtime ?? 0);
      return createStats(raw.size, raw.isDirectory(), mtime);
    } catch {
      /* fall through to the error below */
    }
  }
  const asset = statFromAsset(resolved);
  if (asset) {
    return asset;
  }
  throw enoent(resolved, 'stat');
}

export function statSync(target: string): FileStats {
  const resolved = resolveTarget(target);
  const mirrored = statFromMirror(resolved);
  if (mirrored) {
    return mirrored;
  }
  const asset = statFromAsset(resolved);
  if (asset) {
    return asset;
  }
  throw enoent(resolved, 'stat');
}

/** React Native has no symbolic links, therefore `lstat` equals `stat`. */
export const lstat = stat;
export const lstatSync = statSync;

/* -------------------------------------------------------------------------- */
/* Public API: removal, renaming, copying                                     */
/* -------------------------------------------------------------------------- */

export async function unlink(target: string): Promise<void> {
  const resolved = resolveTarget(target);
  if (!fileMirror.has(resolved) && !(await deviceExists(resolved))) {
    throw enoent(resolved, 'unlink');
  }
  fileMirror.delete(resolved);
  await queueWrite(resolved, async () => {
    try {
      await RNFS.unlink(resolved);
    } catch (error) {
      if (error && (error as any).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  });
}

export function unlinkSync(target: string): void {
  const resolved = resolveTarget(target);
  if (!fileMirror.has(resolved)) {
    throw enoent(resolved, 'unlink');
  }
  fileMirror.delete(resolved);
  queueWrite(resolved, async () => {
    try {
      await RNFS.unlink(resolved);
    } catch {
      /* ignore */
    }
  }).catch(error => reportPersistenceError(resolved, error));
}

export async function rm(
  target: string,
  options?: {recursive?: boolean; force?: boolean},
): Promise<void> {
  const resolved = resolveTarget(target);
  const known = fileMirror.has(resolved) || directoryMirror.has(resolved) || (await deviceExists(resolved));
  if (!known) {
    if (options?.force) {
      return;
    }
    throw enoent(resolved, 'rm');
  }
  removeFromMirror(resolved);
  await queueWrite(resolved, async () => {
    try {
      await RNFS.unlink(resolved);
    } catch {
      /* ignore */
    }
  });
}

export function rmSync(target: string, options?: {recursive?: boolean; force?: boolean}): void {
  const resolved = resolveTarget(target);
  const known = fileMirror.has(resolved) || directoryMirror.has(resolved);
  if (!known && !options?.force) {
    throw enoent(resolved, 'rm');
  }
  removeFromMirror(resolved);
  queueWrite(resolved, async () => {
    try {
      await RNFS.unlink(resolved);
    } catch {
      /* ignore */
    }
  }).catch(error => reportPersistenceError(resolved, error));
}

export async function rename(source: string, destination: string): Promise<void> {
  const from = resolveTarget(source);
  const to = resolveTarget(destination);
  assertWritable(to);
  const buffer = fileMirror.get(from);
  if (buffer) {
    fileMirror.delete(from);
    storeFile(to, buffer);
  }
  await queueWrite(to, async () => {
    await ensureDeviceDirectory(dirnameOf(to));
    try {
      await RNFS.moveFile(from, to);
    } catch (error) {
      if (buffer) {
        await persistFile(to, buffer);
        return;
      }
      throw error;
    }
  });
}

export function renameSync(source: string, destination: string): void {
  const from = resolveTarget(source);
  const to = resolveTarget(destination);
  assertWritable(to);
  const buffer = fileMirror.get(from);
  if (buffer) {
    fileMirror.delete(from);
    storeFile(to, buffer);
  }
  queueWrite(to, async () => {
    await ensureDeviceDirectory(dirnameOf(to));
    try {
      await RNFS.moveFile(from, to);
    } catch {
      if (buffer) {
        await persistFile(to, buffer);
      }
    }
  }).catch(error => reportPersistenceError(to, error));
}

export async function copyFile(
  source: string,
  destination: string,
  flags?: number,
): Promise<void> {
  const from = resolveTarget(source);
  const to = resolveTarget(destination);
  assertWritable(to);
  const buffer = await readFileBytesAsync(from);
  if ((flags ?? 0) & constants.COPYFILE_EXCL) {
    if (fileMirror.has(to) || directoryMirror.has(to) || (await deviceExists(to))) {
      throw createError('EEXIST', 'copyfile', to, 'file already exists');
    }
  }
  storeFile(to, buffer);
  await queueWrite(to, () => persistFile(to, buffer));
}

export function copyFileSync(source: string, destination: string, flags?: number): void {
  const from = resolveTarget(source);
  const to = resolveTarget(destination);
  assertWritable(to);
  const buffer = readFileBytesSync(from);
  if ((flags ?? 0) & constants.COPYFILE_EXCL) {
    if (fileMirror.has(to) || directoryMirror.has(to)) {
      throw createError('EEXIST', 'copyfile', to, 'file already exists');
    }
  }
  storeFile(to, buffer);
  queueWrite(to, () => persistFile(to, buffer)).catch(error => reportPersistenceError(to, error));
}

/* -------------------------------------------------------------------------- */
/* Public API: misc                                                           */
/* -------------------------------------------------------------------------- */

export async function access(target: string, _mode?: number): Promise<void> {
  if (!(await exists(target))) {
    throw enoent(resolveTarget(target), 'access');
  }
}

export function accessSync(target: string, _mode?: number): void {
  if (!existsSync(target)) {
    throw enoent(resolveTarget(target), 'access');
  }
}

export async function realpath(target: string): Promise<string> {
  return resolveTarget(target);
}

export function realpathSync(target: string): string {
  return resolveTarget(target);
}

export async function chmod(target: string, mode: number | string): Promise<void> {
  /* React Native has no permission model. */
  void target;
  void mode;
}

export function chmodSync(target: string, mode: number | string): void {
  void target;
  void mode;
}

export async function chown(target: string, uid: number, gid: number): Promise<void> {
  void target;
  void uid;
  void gid;
}

export function chownSync(target: string, uid: number, gid: number): void {
  void target;
  void uid;
  void gid;
}

export async function utimes(target: string, atime: any, mtime: any): Promise<void> {
  void target;
  void atime;
  void mtime;
}

export function utimesSync(target: string, atime: any, mtime: any): void {
  void target;
  void atime;
  void mtime;
}

export async function mkdtemp(prefix: string, _options?: {encoding?: string}): Promise<string> {
  const resolved = resolveTarget(prefix);
  assertWritable(resolved);
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  const directory = `${resolved}${suffix}`;
  ensureParentDirectories(directory);
  directoryMirror.add(directory);
  await queueWrite(directory, async () => {
    await ensureDeviceDirectory(directory);
  });
  return directory;
}

export function mkdtempSync(prefix: string, _options?: {encoding?: string}): string {
  const resolved = resolveTarget(prefix);
  assertWritable(resolved);
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  const directory = `${resolved}${suffix}`;
  ensureParentDirectories(directory);
  directoryMirror.add(directory);
  queueWrite(directory, async () => {
    await ensureDeviceDirectory(directory);
  }).catch(error => reportPersistenceError(directory, error));
  return directory;
}

/* -------------------------------------------------------------------------- */
/* File handles                                                               */
/* -------------------------------------------------------------------------- */

export class FileHandle implements FileHandleLike {
  readonly fd: number;
  private readonly target: string;
  private readonly flags: string;
  private content: Buffer;
  private position = 0;
  private dirty = false;
  private closed = false;

  constructor(target: string, flags: string, content: Buffer) {
    this.target = target;
    this.flags = flags;
    this.content = content;
    this.fd = -1;
    if (flags.includes('a')) {
      this.position = content.length;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw createError('EBADF', 'read', this.target, 'bad file descriptor');
    }
  }

  async read(
    buffer: Buffer,
    offset: number = 0,
    length?: number,
    position?: number | null,
  ): Promise<{bytesRead: number; buffer: Buffer}> {
    this.assertOpen();
    const start = position === undefined || position === null ? this.position : position;
    const size = length ?? buffer.length - offset;
    const slice = this.content.subarray(start, start + size);
    buffer.set(slice, offset);
    if (position === undefined || position === null) {
      this.position = start + slice.length;
    }
    return {bytesRead: slice.length, buffer};
  }

  async write(
    buffer: Buffer,
    offset: number = 0,
    length?: number,
    position?: number | null,
  ): Promise<{bytesWritten: number; buffer: Buffer}> {
    this.assertOpen();
    const size = length ?? buffer.length - offset;
    const payload = buffer.subarray(offset, offset + size);
    const start = position === undefined || position === null ? this.position : position;
    const needed = start + payload.length;
    if (needed > this.content.length) {
      const expanded = Buffer.alloc(needed);
      this.content.copy(expanded);
      this.content = expanded;
    }
    payload.copy(this.content, start);
    this.dirty = true;
    if (position === undefined || position === null) {
      this.position = start + payload.length;
    }
    return {bytesWritten: payload.length, buffer};
  }

  async readv(buffers: Buffer[], position?: number | null): Promise<{bytesRead: number}> {
    this.assertOpen();
    let start = position === undefined || position === null ? this.position : position;
    let total = 0;
    for (const buffer of buffers) {
      const slice = this.content.subarray(start, start + buffer.length);
      buffer.set(slice, 0);
      start += slice.length;
      total += slice.length;
    }
    if (position === undefined || position === null) {
      this.position = start;
    }
    return {bytesRead: total};
  }

  async writev(buffers: Buffer[], position?: number | null): Promise<{bytesWritten: number}> {
    this.assertOpen();
    let start = position === undefined || position === null ? this.position : position;
    let total = 0;
    for (const buffer of buffers) {
      const needed = start + buffer.length;
      if (needed > this.content.length) {
        const expanded = Buffer.alloc(needed);
        this.content.copy(expanded);
        this.content = expanded;
      }
      buffer.copy(this.content, start);
      start += buffer.length;
      total += buffer.length;
    }
    this.dirty = true;
    if (position === undefined || position === null) {
      this.position = start;
    }
    return {bytesWritten: total};
  }

  async readFile(): Promise<Buffer> {
    this.assertOpen();
    return Buffer.from(this.content);
  }

  async writeFile(data: Buffer | Uint8Array | string, encoding?: string): Promise<void> {
    this.assertOpen();
    this.content = toBuffer(data as any, encoding);
    this.dirty = true;
  }

  async stat(): Promise<FileStats> {
    this.assertOpen();
    return createStats(this.content.length, false);
  }

  async truncate(length: number = 0): Promise<void> {
    this.assertOpen();
    this.content = this.content.subarray(0, Math.max(0, length));
    this.dirty = true;
  }

  async sync(): Promise<void> {
    this.assertOpen();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.dirty) {
      const content = this.content;
      storeFile(this.target, content);
      queueWrite(this.target, () => persistFile(this.target, content)).catch(error =>
        reportPersistenceError(this.target, error),
      );
    }
  }
}

export async function open(target: string, flags: string | number = 'r', _mode?: number): Promise<FileHandle> {
  const resolved = resolveTarget(target);
  const flagString = typeof flags === 'number' ? 'r' : String(flags);

  if (flagString.includes('x') && (fileMirror.has(resolved) || directoryMirror.has(resolved))) {
    throw createError('EEXIST', 'open', resolved, 'file already exists');
  }
  if (flagString.includes('w') || flagString.includes('x')) {
    assertWritable(resolved);
  }

  let content = fileMirror.get(resolved) ?? Buffer.alloc(0);
  if (!flagString.includes('w') && !flagString.includes('x')) {
    content = await readFileBytesAsync(resolved);
  }
  const handle = new FileHandle(resolved, flagString, content);
  if (flagString.includes('w') || flagString.includes('x')) {
    storeFile(resolved, content);
    queueWrite(resolved, () => persistFile(resolved, content)).catch(error =>
      reportPersistenceError(resolved, error),
    );
  }
  return handle;
}

/* -------------------------------------------------------------------------- */
/* Directory handles                                                          */
/* -------------------------------------------------------------------------- */

export class FSDir {
  private readonly target: string;
  private index = 0;
  private entries: Dirent[] = [];

  constructor(target: string, entries: Dirent[]) {
    this.target = target;
    this.entries = entries;
  }

  async read(): Promise<Dirent | null> {
    if (this.index >= this.entries.length) {
      return null;
    }
    return this.entries[this.index++];
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Dirent> {
    for (const entry of this.entries) {
      yield entry;
    }
  }
}

export async function opendir(target: string): Promise<FSDir> {
  const resolved = resolveTarget(target);
  const entries = (await readdir(resolved, {withFileTypes: true})) as Dirent[];
  return new FSDir(resolved, entries);
}

/* -------------------------------------------------------------------------- */
/* Streams                                                                    */
/* -------------------------------------------------------------------------- */

export function createReadStream(target: string, options?: any): Readable {
  const stream = new Readable({
    highWaterMark: options?.highWaterMark,
    read() {
      /* the content is pushed asynchronously */
    },
  }) as any;

  const load = async () => {
    const buffer = await readFileBytesAsync(target);
    let slice = buffer;
    const start = typeof options?.start === 'number' ? options.start : undefined;
    const end = typeof options?.end === 'number' ? options.end : undefined;
    if (start !== undefined || end !== undefined) {
      const from = start ?? 0;
      const to = end === undefined ? slice.length : end + 1;
      slice = slice.subarray(from, to);
    }
    stream.push(slice);
    stream.push(null);
  };

  setTimeout(() => {
    load().catch(error => {
      stream.destroy(error as Error);
    });
  }, 0);

  return stream;
}

export function createWriteStream(target: string, options?: any): Writable {
  const resolved = resolveTarget(target);
  const flags = String(options?.flags ?? 'w');
  const stream = new Writable({
    highWaterMark: options?.highWaterMark,
    write(chunk: any, _encoding: any, callback: (error?: Error | null) => void) {
      try {
        const buffer = toBuffer(chunk);
        const current = fileMirror.get(resolved);
        if (!current || !flags.includes('a')) {
          fileMirror.set(resolved, buffer);
        } else {
          fileMirror.set(resolved, Buffer.concat([current, buffer]));
        }
        ensureParentDirectories(resolved);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  }) as any;

  if (flags.includes('x') && (fileMirror.has(resolved) || directoryMirror.has(resolved))) {
    setTimeout(() => {
      stream.destroy(createError('EEXIST', 'open', resolved, 'file already exists'));
    }, 0);
  }

  let closed = false;
  stream.on('finish', () => {
    const buffer = fileMirror.get(resolved) ?? Buffer.alloc(0);
    queueWrite(resolved, () => persistFile(resolved, buffer)).catch(error =>
      reportPersistenceError(resolved, error),
    );
    if (!closed) {
      closed = true;
      stream.emit('close');
    }
  });

  return stream;
}

/* -------------------------------------------------------------------------- */
/* Synchronous file descriptors (desktop only code paths)                     */
/* -------------------------------------------------------------------------- */

const openDescriptors = new Map<number, {target: string; buffer: Buffer; position: number}>();
let nextDescriptor = 1;

export function openSync(target: string, flags: string | number = 'r', _mode?: number): number {
  const resolved = resolveTarget(target);
  const flagString = typeof flags === 'number' ? 'r' : String(flags);
  if (flagString.includes('x') && fileMirror.has(resolved)) {
    throw createError('EEXIST', 'open', resolved, 'file already exists');
  }
  let buffer: Buffer;
  if (flagString.includes('w') || flagString.includes('x')) {
    buffer = Buffer.alloc(0);
    storeFile(resolved, buffer);
  } else {
    buffer = readFileBytesSync(resolved);
  }
  const fd = nextDescriptor++;
  openDescriptors.set(fd, {target: resolved, buffer, position: 0});
  return fd;
}

export function readSync(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
): number {
  const descriptor = openDescriptors.get(fd);
  if (!descriptor) {
    throw createError('EBADF', 'read', '', 'bad file descriptor');
  }
  const start = position === null ? descriptor.position : position;
  const slice = descriptor.buffer.subarray(start, start + length);
  buffer.set(slice, offset);
  if (position === null) {
    descriptor.position = start + slice.length;
  }
  return slice.length;
}

export function writeSync(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
): number {
  const descriptor = openDescriptors.get(fd);
  if (!descriptor) {
    throw createError('EBADF', 'write', '', 'bad file descriptor');
  }
  const start = position === null ? descriptor.position : position;
  const payload = buffer.subarray(offset, offset + length);
  const needed = start + payload.length;
  if (needed > descriptor.buffer.length) {
    const expanded = Buffer.alloc(needed);
    descriptor.buffer.copy(expanded);
    descriptor.buffer = expanded;
  }
  payload.copy(descriptor.buffer, start);
  if (position === null) {
    descriptor.position = start + payload.length;
  }
  storeFile(descriptor.target, descriptor.buffer);
  queueWrite(descriptor.target, () => persistFile(descriptor.target, descriptor.buffer)).catch(error =>
    reportPersistenceError(descriptor.target, error),
  );
  return payload.length;
}

export function closeSync(fd: number): void {
  const descriptor = openDescriptors.get(fd);
  if (!descriptor) {
    throw createError('EBADF', 'close', '', 'bad file descriptor');
  }
  openDescriptors.delete(fd);
  const buffer = descriptor.buffer;
  queueWrite(descriptor.target, () => persistFile(descriptor.target, buffer)).catch(error =>
    reportPersistenceError(descriptor.target, error),
  );
}

export function fstatSync(fd: number): FileStats {
  const descriptor = openDescriptors.get(fd);
  if (!descriptor) {
    throw createError('EBADF', 'fstat', '', 'bad file descriptor');
  }
  return createStats(descriptor.buffer.length, false);
}

export function fsyncSync(_fd: number): void {
  /* writes are persisted asynchronously */
}

export function fdatasyncSync(_fd: number): void {
  /* writes are persisted asynchronously */
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const constants = {
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_SYNC: 1052672,
  O_DIRECTORY: 65536,
  O_NOFOLLOW: 131072,
  S_IFMT: 61440,
  S_IFREG: 32768,
  S_IFDIR: 16384,
  S_IFLNK: 40960,
  S_IRWXU: 448,
  S_IRUSR: 256,
  S_IWUSR: 128,
  S_IXUSR: 64,
  S_IRWXG: 56,
  S_IRGRP: 32,
  S_IWGRP: 16,
  S_IXGRP: 8,
  S_IRWXO: 7,
  S_IROTH: 4,
  S_IWOTH: 2,
  S_IXOTH: 1,
};

/* -------------------------------------------------------------------------- */
/* Promise API                                                                */
/* -------------------------------------------------------------------------- */

export const promises = {
  access,
  appendFile,
  chmod,
  chown,
  copyFile,
  exists,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  readFileBuffer,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
  constants,
};

export const Stats = createStats;
export const Dirent = createDirent;

/* -------------------------------------------------------------------------- */
/* Default export                                                             */
/* -------------------------------------------------------------------------- */

const fs = {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  closeSync,
  constants,
  copyFile,
  copyFileSync,
  createReadStream,
  createWriteStream,
  Dirent,
  exists,
  existsSync,
  FileHandle,
  fstatSync,
  fsyncSync,
  fdatasyncSync,
  hydrateFileSystem,
  flushPendingWrites,
  lstat,
  lstatSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  open,
  openSync,
  opendir,
  pathExists,
  promises,
  readdir,
  readdirSync,
  readFile,
  readFileSync,
  readFileBuffer,
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
  Stats,
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

export default fs;
