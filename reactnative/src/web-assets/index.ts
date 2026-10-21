/**
 * Access to the bundled web assets (the desktop `index.html` / `styles/` /
 * `renderer/` / `rulesets/` tree).
 *
 * The assets are embedded into the JS bundle by `scripts/build-web-assets.js`
 * so that both Android and iOS can serve them from the local HTTP server
 * without relying on platform specific asset packaging.
 */
import manifest from './assets.json';

export interface WebAssetEntry {
  encoding: 'utf8' | 'base64';
  data: string;
}

interface WebAssetManifest {
  generatedAt: string;
  files: Record<string, WebAssetEntry>;
}

const webAssets = manifest as unknown as WebAssetManifest;

export const webAssetGeneratedAt: string = webAssets.generatedAt;

export function listWebAssets(): string[] {
  return Object.keys(webAssets.files);
}

export function getWebAssetText(name: string): string | null {
  const entry = webAssets.files[name];
  if (!entry) {
    return null;
  }
  if (entry.encoding === 'utf8') {
    return entry.data;
  }
  return decodeBase64(entry.data);
}

export function getWebAssetBytes(name: string): Uint8Array | null {
  const entry = webAssets.files[name];
  if (!entry) {
    return null;
  }
  if (entry.encoding === 'base64') {
    return decodeBase64Bytes(entry.data);
  }
  return utf8Bytes(entry.data);
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

function decodeBase64(value: string): string {
  const bytes = decodeBase64Bytes(value);
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const globalBuffer = (globalThis as any).Buffer;
  if (globalBuffer) {
    return new Uint8Array(globalBuffer.from(value, 'base64'));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function utf8Bytes(value: string): Uint8Array {
  const encoded = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    bytes[i] = encoded.charCodeAt(i);
  }
  return bytes;
}
