/**
 * Access to the bundled web assets (the desktop `index.html` / `styles/` /
 * `renderer/` / `rulesets/` tree).
 *
 * The assets are embedded into the JS bundle by `scripts/build-web-assets.js`
 * in two pieces:
 *
 *  - `index.json`   path -> `[size, binary]`. A few kilobytes, parsed eagerly;
 *                   it answers `exists` / `stat` / `readdir` without touching
 *                   any file content.
 *  - `payload.json` a single deflate+base64 blob with every file body.
 *
 * The payload is decoded lazily, on the first *content* request: it used to be
 * a 2.4 MB JSON module that Hermes had to parse and allocate during start-up,
 * which is time the user spends looking at the splash screen.
 */
import {Buffer} from 'buffer';

import indexData from './index.json';

interface WebAssetIndex {
  generatedAt: string;
  /** `[size, binary]`; `binary === 1` means the payload holds base64. */
  files: Record<string, [number, 0 | 1]>;
}

const index = indexData as unknown as WebAssetIndex;

/** Decoded payload (`path -> utf8 text / base64`). */
let contents: Record<string, string> | null = null;
/** Set when the payload could not be decoded, so it is not retried per request. */
let contentsFailure: Error | null = null;

/** Decoded bodies, kept because the renderer requests a file more than once. */
const byteCache = new Map<string, Buffer>();
const textCache = new Map<string, string>();

export const webAssetGeneratedAt: string = index.generatedAt;

export function listWebAssets(): string[] {
  return Object.keys(index.files);
}

export function hasWebAsset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(index.files, name);
}

/** Size of the file in bytes, or `null` when it is not bundled. */
export function getWebAssetSize(name: string): number | null {
  const entry = index.files[name];
  return entry ? entry[0] : null;
}

export function getWebAssetEncoding(name: string): 'utf8' | 'base64' | null {
  const entry = index.files[name];
  if (!entry) {
    return null;
  }
  return entry[1] === 1 ? 'base64' : 'utf8';
}

/** Loads (and caches) the decompressed payload. */
function loadContents(): Record<string, string> | null {
  if (contents) {
    return contents;
  }
  if (contentsFailure) {
    return null;
  }
  try {
    const startedAt = Date.now();
    // Required here, not at module scope: Metro's lazy requires then keep both
    // the zlib polyfill and the payload itself out of the start-up path.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {inflateRawSync} = require('../polyfills/node/zlib');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const payload = require('./payload.json') as {data: string};
    const inflated = inflateRawSync(Buffer.from(payload.data, 'base64'));
    contents = JSON.parse(Buffer.from(inflated).toString('utf8')) as Record<
      string,
      string
    >;
    console.log(
      `[e2rn] web assets: ${Object.keys(contents).length} payloads decoded in ` +
        `${Date.now() - startedAt} ms`,
    );
    return contents;
  } catch (error) {
    contentsFailure = error as Error;
    console.error('[e2rn] the bundled web assets could not be decoded', error);
    return null;
  }
}

export function getWebAssetText(name: string): string | null {
  if (!hasWebAsset(name)) {
    return null;
  }
  const cached = textCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const files = loadContents();
  const raw = files ? files[name] : undefined;
  if (typeof raw !== 'string') {
    return null;
  }
  const text =
    getWebAssetEncoding(name) === 'base64'
      ? Buffer.from(raw, 'base64').toString('utf8')
      : raw;
  textCache.set(name, text);
  return text;
}

export function getWebAssetBytes(name: string): Uint8Array | null {
  return getWebAssetBuffer(name);
}

/**
 * The body of a bundled file.
 *
 * The `Buffer` is cached: the asset server converts it for every HTTP request,
 * and re-decoding a 400 KB image for each of them is pure waste.
 */
export function getWebAssetBuffer(name: string): Buffer | null {
  if (!hasWebAsset(name)) {
    return null;
  }
  const cached = byteCache.get(name);
  if (cached) {
    return cached;
  }
  const files = loadContents();
  const raw = files ? files[name] : undefined;
  if (typeof raw !== 'string') {
    return null;
  }
  const buffer =
    getWebAssetEncoding(name) === 'base64'
      ? Buffer.from(raw, 'base64')
      : Buffer.from(raw, 'utf8');
  byteCache.set(name, buffer);
  return buffer;
}

export function getWebAssetContentType(name: string): string {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  switch (extension) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
