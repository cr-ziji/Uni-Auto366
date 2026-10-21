/**
 * Read-only, synchronous file system over the bundled web assets.
 *
 * The desktop build reads bundled files (`rulesets/`, `preload/`,
 * `styles/`, ...) straight from the application directory. On React Native the
 * bundled files live inside the JS bundle, so they are exposed through this
 * virtual file system instead of the real (asynchronous) one.
 *
 * The API intentionally mirrors the `fs` subset used by the ported modules.
 */
import {Buffer} from 'buffer';
import {getWebAssetBytes, getWebAssetText, listWebAssets} from './index';

/** Virtual root of the read-only application directory. */
export const virtualAppRoot = '/app';

export interface AssetStat {
  size: number;
  mtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
}

const directoryCache = new Map<string, Set<string>>();

function normalize(target: string): string {
  const segments: string[] = [];
  for (const part of String(target ?? '').split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

/** Strips the virtual root prefix and returns the manifest key, if any. */
export function toAssetKey(target: string): string | null {
  const normalized = normalize(target);
  if (normalized === '') {
    return null;
  }
  if (normalized.startsWith(`${virtualAppRoot}/`)) {
    return normalized.slice(virtualAppRoot.length + 1);
  }
  return normalized;
}

function buildDirectoryIndex(): void {
  if (directoryCache.size > 0) {
    return;
  }
  for (const key of listWebAssets()) {
    const parts = key.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const directory = parts.slice(0, i - 1).join('/');
      const name = parts[i - 1];
      const bucket = directoryCache.get(directory) ?? new Set<string>();
      bucket.add(name);
      directoryCache.set(directory, bucket);
    }
  }
}

export function assetExistsSync(target: string): boolean {
  const key = toAssetKey(target);
  if (!key) {
    return false;
  }
  buildDirectoryIndex();
  if (directoryCache.has(key)) {
    return true;
  }
  return getWebAssetText(key) !== null || getWebAssetBytes(key) !== null;
}

export function assetIsDirectorySync(target: string): boolean {
  const key = toAssetKey(target);
  if (!key) {
    return false;
  }
  buildDirectoryIndex();
  return directoryCache.has(key);
}

export function assetReadFileSync(target: string, encoding?: string): string | Buffer {
  const key = toAssetKey(target);
  if (!key) {
    throw enoent(target);
  }
  if (encoding === 'utf8' || encoding === 'utf-8' || encoding === undefined) {
    const text = getWebAssetText(key);
    if (text !== null) {
      return text;
    }
  }
  const bytes = getWebAssetBytes(key);
  if (!bytes) {
    throw enoent(target);
  }
  return Buffer.from(bytes);
}

export function assetReaddirSync(target: string): string[] {
  const key = toAssetKey(target);
  if (!key) {
    throw enoent(target);
  }
  buildDirectoryIndex();
  const bucket = directoryCache.get(key);
  if (!bucket) {
    throw enoent(target);
  }
  return [...bucket].sort();
}

export function assetStatSync(target: string): AssetStat {
  const key = toAssetKey(target);
  if (!key) {
    throw enoent(target);
  }
  buildDirectoryIndex();
  if (directoryCache.has(key)) {
    return {
      size: 0,
      mtime: new Date(0),
      isFile: () => false,
      isDirectory: () => true,
    };
  }
  const bytes = getWebAssetBytes(key);
  if (!bytes) {
    throw enoent(target);
  }
  return {
    size: bytes.length,
    mtime: new Date(0),
    isFile: () => true,
    isDirectory: () => false,
  };
}

/** Recursively lists every bundled file below `target`. */
export function assetWalkSync(target: string): string[] {
  const key = toAssetKey(target);
  if (!key) {
    return [];
  }
  buildDirectoryIndex();
  const prefix = key ? `${key}/` : '';
  return listWebAssets()
    .filter(name => name.startsWith(prefix))
    .map(name => name.slice(prefix.length));
}

function enoent(target: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, '${target}'`);
  error.code = 'ENOENT';
  return error;
}

export const assetFs = {
  existsSync: assetExistsSync,
  isDirectorySync: assetIsDirectorySync,
  readFileSync: assetReadFileSync,
  readdirSync: assetReaddirSync,
  statSync: assetStatSync,
  walkSync: assetWalkSync,
  virtualAppRoot,
};

export default assetFs;
