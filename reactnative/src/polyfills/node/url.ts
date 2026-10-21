/**
 * Node `url` polyfill for React Native.
 *
 * Hermes does not ship a WHATWG `URL` implementation, therefore
 * `react-native-url-polyfill` is installed (it also replaces the global
 * `URL` / `URLSearchParams`).
 *
 * On top of that the legacy Node helpers are re-implemented:
 *
 *   - `fileURLToPath()` / `pathToFileURL()` - the virtual app root (`/app`)
 *     is a plain POSIX path, so no Windows specific handling is needed.
 *   - `parse()` / `format()` / `resolve()` - the legacy `url` object API that
 *     the proxy modules still use.
 */
import 'react-native-url-polyfill/auto';
import {URL as PolyfillURL, URLSearchParams as PolyfillURLSearchParams} from 'react-native-url-polyfill';

/*
 * React Native declares the global `URL` / `URLSearchParams` classes, but the
 * exported constants below would shadow them. Therefore the global types are
 * captured through aliases that only use the *type* meaning of the names.
 */
type GlobalUrlInstance = URL;
type GlobalUrlSearchParamsInstance = URLSearchParams;

interface GlobalUrlConstructor {
  new (url: string, base?: string): GlobalUrlInstance;
  prototype: GlobalUrlInstance;
  createObjectURL(blob: any): string;
  revokeObjectURL(url: string): void;
}

interface GlobalUrlSearchParamsConstructor {
  new (init?: any): GlobalUrlSearchParamsInstance;
  prototype: GlobalUrlSearchParamsInstance;
}

export const URL: GlobalUrlConstructor = PolyfillURL as unknown as GlobalUrlConstructor;
export const URLSearchParams: GlobalUrlSearchParamsConstructor =
  PolyfillURLSearchParams as unknown as GlobalUrlSearchParamsConstructor;

export interface UrlObject {
  protocol: string | null;
  slashes: boolean | null;
  auth: string | null;
  host: string | null;
  port: string | null;
  hostname: string | null;
  hash: string | null;
  search: string | null;
  query: string | { [key: string]: string | string[] } | null;
  pathname: string | null;
  path: string | null;
  href: string;
}

/** Converts a `file:` URL into a filesystem path. */
export function fileURLToPath(url: string | URL): string {
  const href = typeof url === 'string' ? url : url.href;
  if (!/^file:/i.test(href)) {
    throw new TypeError('The URL must be of scheme file');
  }
  let pathname: string;
  try {
    pathname = new URL(href).pathname;
  } catch {
    pathname = href.replace(/^file:(\/\/)?/i, '');
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  // `file:///app/index.html` -> `/app/index.html`
  if (decoded.startsWith('//')) {
    decoded = decoded.slice(1);
  }
  return decoded;
}

/** Converts a filesystem path into a `file:` URL. */
export function pathToFileURL(path: string): URL {
  const absolute = String(path ?? '');
  const normalized = absolute.startsWith('/') ? absolute : `/${absolute.replace(/^\/+/, '')}`;
  const encoded = normalized
    .split('/')
    .map(segment => encodeURIComponent(segment).replace(/%2F/gi, '/'))
    .join('/');
  return new URL(`file://${encoded.startsWith('/') ? '' : '/'}${encoded}`) as unknown as URL;
}

/**
 * Legacy `url.parse()`.
 *
 * Only the fields used by the ported modules are produced, but the shape
 * matches Node so that `protocol`, `hostname`, `port`, `path`, `search`,
 * `query`, `hash` and `href` behave the same.
 */
export function parse(urlString: string, parseQueryString?: boolean): UrlObject {
  const input = String(urlString ?? '');
  let rest = input;

  let protocol: string | null = null;
  let slashes: boolean | null = null;
  let auth: string | null = null;
  let host: string | null = null;
  let port: string | null = null;
  let hostname: string | null = null;
  let hash: string | null = null;
  let search: string | null = null;
  let query: UrlObject['query'] = null;
  let pathname: string | null = null;

  const protocolMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(rest);
  if (protocolMatch) {
    protocol = protocolMatch[1].toLowerCase();
    rest = rest.slice(protocolMatch[1].length);
  }

  if (rest.startsWith('//')) {
    slashes = true;
    rest = rest.slice(2);
    const slashIndex = rest.indexOf('/');
    let authority = slashIndex < 0 ? rest : rest.slice(0, slashIndex);
    rest = slashIndex < 0 ? '' : rest.slice(slashIndex);
    const atIndex = authority.lastIndexOf('@');
    if (atIndex >= 0) {
      auth = authority.slice(0, atIndex);
      authority = authority.slice(atIndex + 1);
    }
    host = authority;
    const colonIndex = authority.lastIndexOf(':');
    if (colonIndex > authority.lastIndexOf(']')) {
      hostname = authority.slice(0, colonIndex);
      port = authority.slice(colonIndex + 1);
    } else {
      hostname = authority;
    }
  }

  const hashIndex = rest.indexOf('#');
  if (hashIndex >= 0) {
    hash = rest.slice(hashIndex);
    rest = rest.slice(0, hashIndex);
  }

  const searchIndex = rest.indexOf('?');
  if (searchIndex >= 0) {
    search = rest.slice(searchIndex);
    rest = rest.slice(0, searchIndex);
  }

  pathname = rest;

  if (search) {
    const raw = search.slice(1);
    if (parseQueryString) {
      const parsed: {[key: string]: string | string[]} = {};
      for (const pair of raw.split('&')) {
        if (!pair) {
          continue;
        }
        const separator = pair.indexOf('=');
        const key = separator < 0 ? pair : pair.slice(0, separator);
        const value = separator < 0 ? '' : pair.slice(separator + 1);
        const decodedKey = safeDecode(key);
        const decodedValue = safeDecode(value);
        const existing = parsed[decodedKey];
        if (existing === undefined) {
          parsed[decodedKey] = decodedValue;
        } else if (Array.isArray(existing)) {
          existing.push(decodedValue);
        } else {
          parsed[decodedKey] = [existing, decodedValue];
        }
      }
      query = parsed;
    } else {
      query = raw;
    }
  }

  const path = pathname || search ? `${pathname ?? ''}${search ?? ''}` : null;
  const href = `${protocol ?? ''}${slashes ? '//' : ''}${auth ? `${auth}@` : ''}${host ?? ''}${path ?? ''}${hash ?? ''}`;

  return {protocol, slashes, auth, host, port, hostname, hash, search, query, pathname, path, href};
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Legacy `url.format()`. */
export function format(urlObject: Partial<UrlObject> | string): string {
  if (typeof urlObject === 'string') {
    return urlObject;
  }
  const protocol = urlObject.protocol ?? '';
  const slashes = urlObject.slashes ?? protocol.endsWith(':');
  const auth = urlObject.auth ? `${urlObject.auth}@` : '';
  const host = urlObject.host ?? urlObject.hostname ?? '';
  const port = urlObject.port ? `:${urlObject.port}` : '';
  const pathname = urlObject.pathname ?? '';
  const search = urlObject.search ?? (urlObject.query ? `?${stringifyQuery(urlObject.query)}` : '');
  const hash = urlObject.hash ?? '';
  return `${protocol}${slashes ? '//' : ''}${auth}${host}${port}${pathname}${search}${hash}`;
}

function stringifyQuery(query: string | {[key: string]: string | string[]}): string {
  if (typeof query === 'string') {
    return query;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}

/** Legacy `url.resolve()`. */
export function resolve(from: string, to: string): string {
  try {
    return new URL(to, from).href;
  } catch {
    return String(to ?? '');
  }
}

/** Legacy `url.resolveObject()`. */
export function resolveObject(from: string, to: string): UrlObject {
  return parse(resolve(from, to));
}

export default {
  URL,
  URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  parse,
  format,
  resolve,
  resolveObject,
};
