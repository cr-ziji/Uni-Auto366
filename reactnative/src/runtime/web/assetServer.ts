/**
 * Local HTTP server for the bundled web assets.
 *
 * The original Electron application loads `index.html`, `styles/`,
 * `renderer/`, `rulesets/` and `resources/` from the installation directory.
 * On React Native these files live inside the JS bundle, so they are served
 * from a tiny HTTP server that listens on `127.0.0.1` with an ephemeral port.
 *
 * The server exists for two reasons:
 *
 *  1. the WebView needs a real origin - relative URLs (`styles/app.css`) and
 *     `fetch()` calls only work when the page is served over HTTP, and
 *  2. the original renderer talks to the local API of the ported
 *     `modules/local-server`, which is a *different* port - serving the
 *     assets from `127.0.0.1` keeps the same-origin behaviour of the
 *     desktop build.
 */
import {Buffer} from 'buffer';

import {getWebAssetBuffer, getWebAssetContentType, listWebAssets} from '../../web-assets';
import {readVirtualWidth} from './virtualWidth';

const HOST = '127.0.0.1';

/**
 * Preferred port of the asset server.
 *
 * The port is part of the WebView's *origin*, and `localStorage` (the theme,
 * the tutorial state, the accepted agreement, ...) is keyed by the origin. An
 * ephemeral port would therefore wipe the storage on every launch - the
 * tutorial would show up again and again. A fixed port keeps the origin
 * stable; the ephemeral port is only a fallback for the (unlikely) case that
 * the port is already taken.
 */
const PREFERRED_PORT = 17866;

/** The (mutable) state of the running asset server. */
let server: any = null;
let baseUrl = '';
let starting: Promise<string> | null = null;

/** Cached list of the bundled asset names. */
let assetKeys: string[] | null = null;

function keys(): string[] {
  if (!assetKeys) {
    assetKeys = listWebAssets();
  }
  return assetKeys;
}

/** Removes `.` / `..` segments so that a request cannot escape the bundle. */
function sanitize(pathname: string): string {
  const segments = pathname.split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      result.pop();
      continue;
    }
    result.push(segment);
  }
  return result.join('/');
}

/**
 * Maps a request path onto the name of a bundled asset.
 *
 * The manifest is normally keyed by the path relative to the application
 * root (`styles/app.css`, `renderer/app.js`, ...). Older manifests were
 * flattened, therefore a unique suffix match is used as a fallback.
 */
export function resolveAssetPath(pathname: string): string | null {
  let raw = String(pathname ?? '/');
  const queryIndex = raw.search(/[?#]/);
  if (queryIndex >= 0) {
    raw = raw.slice(0, queryIndex);
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  raw = raw.replace(/\\/g, '/');
  let relative = sanitize(raw.replace(/^\/+/, ''));
  if (!relative || relative.endsWith('/')) {
    relative = relative ? `${relative}index.html` : 'index.html';
  }

  const all = keys();
  if (all.indexOf(relative) >= 0) {
    return relative;
  }

  // `styles/x.css` -> `x.css` (flattened manifest)
  const prefixes = ['styles/', 'renderer/', 'rulesets/', 'resources/', 'preload/', 'node_modules/'];
  for (const prefix of prefixes) {
    if (relative.startsWith(prefix)) {
      const rest = relative.slice(prefix.length);
      if (rest && all.indexOf(rest) >= 0) {
        return rest;
      }
    }
  }

  // Unique suffix match.
  const matches = all.filter(key => key.endsWith(`/${relative}`));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    matches.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    return matches[0];
  }
  return null;
}

interface AssetResponse {
  status: number;
  contentType: string;
  body: Buffer | null;
}

/** `<meta name="viewport" ...>` - attribute order and quoting are flexible. */
const VIEWPORT_META = /<meta\b[^>]*\bname\s*=\s*["']?viewport["']?[^>]*>/i;

/**
 * Rewrites the viewport meta tag of an HTML page.
 *
 * The desktop renderer declares `width=device-width`, which on a phone would
 * squeeze the 1400 px wide desktop layout into a ~360 px viewport. Declaring
 * the *desktop* width instead lets the WebView compute a page scale that fits
 * the whole layout onto the screen - the page is then rasterised at screen
 * resolution instead of at 1400x900 dp.
 */
export function rewriteViewportMeta(html: string, virtualWidth: number): string {
  const width = Math.max(Math.round(virtualWidth || 0), 1);
  const meta = `<meta name="viewport" content="width=${width}, user-scalable=no">`;
  if (VIEWPORT_META.test(html)) {
    return html.replace(VIEWPORT_META, meta);
  }
  // No viewport tag at all - put one at the beginning of the head.
  const head = /<head\b[^>]*>/i;
  if (head.test(html)) {
    return html.replace(head, match => `${match}\n    ${meta}`);
  }
  return `${meta}\n${html}`;
}

/** Builds the response for a request path. */
export function buildAssetResponse(
  pathname: string,
  headOnly: boolean,
  virtualWidth?: number | null,
): AssetResponse {
  const name = resolveAssetPath(pathname);
  if (!name) {
    return {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: headOnly ? null : Buffer.from('Not Found', 'utf8'),
    };
  }
  // `getWebAssetBuffer` caches the decoded body; the renderer asks for the
  // same CSS/JS/font files several times per page load.
  const buffer = getWebAssetBuffer(name);
  if (!buffer) {
    return {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: headOnly ? null : Buffer.from('Not Found', 'utf8'),
    };
  }
  const contentType = getWebAssetContentType(name);
  if (virtualWidth && /html/i.test(contentType)) {
    const html = buffer.toString('utf8');
    return {
      status: 200,
      contentType,
      body: headOnly ? null : Buffer.from(rewriteViewportMeta(html, virtualWidth), 'utf8'),
    };
  }
  return {
    status: 200,
    contentType,
    body: headOnly ? null : buffer,
  };
}

function headersFor(response: AssetResponse, bodyLength: number): Record<string, any> {
  return {
    'Content-Type': response.contentType,
    'Content-Length': bodyLength,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };
}

/**
 * Same-origin endpoint that forwards a request to an absolute URL.
 *
 * The renderer runs in a WebView served from `http://127.0.0.1:<port>`, so
 * every call to the rule-set API (`https://366.cyril.qzz.io/...`) is a
 * cross-origin request and is blocked by the browser unless the server sends
 * CORS headers - which it does not for the download endpoints. The desktop
 * build had `webSecurity` semantics of its own, so the renderer never had to
 * care.
 *
 * `window.fetch` is patched in the preload to route cross-origin calls here;
 * the request is then issued from the main context (the Node `http` shim),
 * which is not subject to CORS at all, and the response is relayed back
 * unchanged (status, headers, bytes).
 */
export const PROXY_PATH = '/__e2rn/proxy';

/** Headers that belong to a single connection and must not be relayed. */
const DROPPED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // Ask the upstream for the identity encoding: the body is relayed as is,
  // and a `content-encoding` header on an already decoded body would make the
  // browser fail to parse it.
  'accept-encoding',
  'origin',
  'referer',
]);

function readRequestBody(request: any): Promise<Buffer> {
  // The http polyfill buffers the whole request body before the handler runs and
  // only replays it afterwards, so the bytes are already on the request object.
  // Reading the stream here would either wait forever or return nothing.
  if (Buffer.isBuffer(request.body)) {
    return Promise.resolve(request.body);
  }
  if (request.readableEnded) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function relayHeaders(
  source: Record<string, any>,
  bodyLength: number,
  options?: {keepContentEncoding?: boolean},
): Record<string, string> {
  const keepEncoding = options?.keepContentEncoding === true;
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(source ?? {})) {
    const name = rawName.toLowerCase();
    if (name === 'content-encoding') {
      // The body is relayed either decoded (header dropped) or untouched
      // (header kept, see `decodeUpstreamBody`). Never strip it blindly.
      if (!keepEncoding) {
        continue;
      }
    } else if (DROPPED_HEADERS.has(name)) {
      continue;
    }
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    headers[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  headers['content-length'] = String(bodyLength);
  headers['access-control-allow-origin'] = '*';
  return headers;
}

/**
 * Decodes a gzip/deflate upstream body.
 *
 * The request asks for `identity`, but a CDN is allowed to ignore that and
 * compress anyway. Relaying those bytes while dropping `content-encoding`
 * makes the page read a gzip stream as JSON (`Unexpected end of JSON input`),
 * so the payload is decoded here. When decoding is impossible (brotli, or a
 * body that is not actually compressed) the header is kept instead, which
 * lets the WebView decompress it.
 */
function decodeUpstreamBody(
  payload: Buffer,
  encoding: string,
): {payload: Buffer; decoded: boolean} {
  if (payload.length === 0) {
    return {payload, decoded: true};
  }
  if (encoding !== 'gzip' && encoding !== 'x-gzip' && encoding !== 'deflate') {
    return {payload, decoded: false};
  }
  try {
    const zlib = require('../../polyfills/node/zlib');
    const result =
      encoding === 'deflate' ? zlib.inflateSync(payload) : zlib.gunzipSync(payload);
    return {payload: Buffer.from(result), decoded: true};
  } catch {
    return {payload, decoded: false};
  }
}

const PROXY_TIMEOUT_MS = 60000;

export async function handleProxy(request: any, response: any, search: string): Promise<void> {
  const reply = (status: number, message: string) => {
    try {
      const body = Buffer.from(message, 'utf8');
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Access-Control-Allow-Origin': '*',
      });
      response.end(body);
    } catch {
      // The client may already be gone.
    }
  };

  const target = new URLSearchParams(search).get('url') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    reply(400, `invalid proxy target: ${target}`);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    reply(400, `unsupported proxy protocol: ${parsed.protocol}`);
    return;
  }

  let body: Buffer;
  try {
    body = await readRequestBody(request);
  } catch (error: any) {
    reply(400, `could not read the request body: ${error?.message ?? error}`);
    return;
  }

  const http = require('../../polyfills/node/http');
  const https = require('../../polyfills/node/https');
  const transport = parsed.protocol === 'https:' ? https : http;

  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(request.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (DROPPED_HEADERS.has(name) || rawValue === undefined) {
      continue;
    }
    headers[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  if (body.length > 0) {
    headers['content-length'] = String(body.length);
  }
  // The relay hands the bytes straight to the page, so ask for an
  // uncompressed answer instead of the `gzip, deflate` the WebView sends.
  headers['accept-encoding'] = 'identity';

  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    let upstream: any;
    try {
      upstream = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: String(request.method ?? 'GET').toUpperCase(),
          headers,
        },
        (res: any) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const upstreamHeaders = res.headers ?? {};
            const encoding = String(upstreamHeaders['content-encoding'] ?? '')
              .trim()
              .toLowerCase();
            const decoded = decodeUpstreamBody(Buffer.concat(chunks), encoding);
            try {
              response.writeHead(
                res.statusCode ?? 502,
                relayHeaders(upstreamHeaders, decoded.payload.length, {
                  // Keep the header only when the bytes are still compressed.
                  keepContentEncoding: Boolean(encoding) && !decoded.decoded,
                }),
              );
              response.end(decoded.payload);
            } catch {
              // The client may already be gone.
            }
            finish();
          });
          res.on('error', (error: Error) => {
            reply(502, `upstream error: ${error.message}`);
            finish();
          });
        },
      );
    } catch (error: any) {
      reply(500, `could not start the upstream request: ${error?.message ?? error}`);
      finish();
      return;
    }

    const timer = setTimeout(() => {
      try {
        upstream.destroy();
      } catch {
        // Ignore.
      }
      reply(504, `proxy timeout after ${PROXY_TIMEOUT_MS} ms`);
      finish();
    }, PROXY_TIMEOUT_MS);
    timer.unref?.();

    upstream.on('error', (error: Error) => {
      clearTimeout(timer);
      reply(502, `upstream error: ${error.message}`);
      finish();
    });
    upstream.on('close', () => clearTimeout(timer));

    if (body.length > 0) {
      upstream.write(body);
    }
    upstream.end();
  });
}

/**
 * The request handler that is shared by both server implementations.
 *
 * The returned promise MUST be handed back to the server: the polyfill closes
 * any response that is still open once the handler returns, so an un-awaited
 * proxy call used to be answered with an empty `200` (the page then failed with
 * `Unexpected end of JSON input`) and the real reply was written to a response
 * that had already ended.
 */
export function handleRequest(request: any, response: any): void | Promise<void> {
  const method = String(request.method ?? 'GET').toUpperCase();
  const target = String(request.url ?? '/');
  const pathname = target.split('?')[0];
  const headOnly = method === 'HEAD';

  if (method === 'OPTIONS') {
    response.writeHead(204, headersFor({status: 204, contentType: 'text/plain', body: null}, 0));
    response.end();
    return;
  }

  if (pathname === PROXY_PATH) {
    const queryIndex = target.indexOf('?');
    return handleProxy(request, response, queryIndex >= 0 ? target.slice(queryIndex + 1) : '');
  }

  const result = buildAssetResponse(pathname, headOnly, readVirtualWidth(target));
  const body = result.body ?? Buffer.alloc(0);
  response.writeHead(result.status, headersFor(result, body.length));
  response.end(headOnly ? undefined : body);
}

/** Starts a server with the Node style `http` polyfill. */
async function startWithHttpPolyfill(port: number): Promise<number> {
  const http = require('../../polyfills/node/http');
  const instance = http.createServer(handleRequest);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    instance.once('error', onError);
    instance.listen(port, HOST, () => {
      instance.removeListener('error', onError);
      resolve();
    });
  });
  const address = instance.address();
  server = {
    close: () => {
      try {
        instance.close();
      } catch {
        // Ignore.
      }
    },
  };
  return address ? address.port : port;
}

/** Starts a minimal HTTP/1.1 server on top of the native `Auto366Net` module. */
async function startWithNativeNet(port: number): Promise<number> {
  const {createNativeServer} = require('../native/net');
  const instance = createNativeServer({}, (socket: any) => {
    let buffer = '';
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        // Ignore.
      }
    });
    socket.on('data', (chunk: any) => {
      buffer += chunk.toString('utf8');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const head = buffer.slice(0, headerEnd);
      buffer = buffer.slice(headerEnd + 4);
      const lines = head.split('\r\n');
      const requestLine = lines.shift() ?? '';
      const parts = requestLine.split(' ');
      const method = String(parts[0] ?? 'GET').toUpperCase();
      const target = String(parts[1] ?? '/');
      const pathname = target.split('?')[0];
      const headOnly = method === 'HEAD';
      if (pathname === PROXY_PATH) {
        // This fallback parses the request head only (and accumulates bytes as
        // UTF-8), so it cannot relay a request body reliably. Report it
        // explicitly instead of answering with an empty 404.
        const message = Buffer.from(
          'The native fallback server cannot proxy requests; the http polyfill must be available.',
          'utf8',
        );
        socket.write(
          [
            'HTTP/1.1 501 Not Implemented',
            'Content-Type: text/plain; charset=utf-8',
            `Content-Length: ${message.length}`,
            'Access-Control-Allow-Origin: *',
            'Connection: close',
            '',
            '',
          ].join('\r\n'),
        );
        socket.write(message);
        socket.end();
        return;
      }
      const result = buildAssetResponse(pathname, headOnly, readVirtualWidth(target));
      const body = result.body ?? Buffer.alloc(0);
      const reason = result.status === 200 ? 'OK' : 'Not Found';
      const responseHead = [
        `HTTP/1.1 ${result.status} ${reason}`,
        `Content-Type: ${result.contentType}`,
        `Content-Length: ${body.length}`,
        'Cache-Control: no-cache',
        'Access-Control-Allow-Origin: *',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      try {
        socket.write(responseHead);
        if (!headOnly && body.length > 0) {
          socket.write(body);
        }
        socket.end();
      } catch {
        // Ignore.
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    instance.once('error', onError);
    instance.listen(port, HOST).then(
      () => {
        instance.removeListener('error', onError);
        resolve();
      },
      (error: Error) => {
        instance.removeListener('error', onError);
        reject(error);
      },
    );
  });
  const address = instance.address();
  server = {
    close: () => {
      try {
        instance.close();
      } catch {
        // Ignore.
      }
    },
  };
  return address ? address.port : port;
}

/**
 * Starts the asset server and returns its base URL.
 *
 * The function never rejects: a failure is logged and an empty string is
 * returned, because the application must not break when the server cannot
 * bind a port.
 */
export async function startAssetServer(): Promise<string> {
  if (baseUrl) {
    return baseUrl;
  }
  if (starting) {
    return starting;
  }
  starting = (async () => {
    let port = 0;
    // The preferred port keeps the WebView origin (and therefore
    // `localStorage`) stable across launches; `0` is the fallback.
    for (const candidate of [PREFERRED_PORT, 0]) {
      try {
        port = await startWithHttpPolyfill(candidate);
        break;
      } catch (error) {
        console.warn(
          `[e2rn] the http polyfill could not serve the web assets on port ${candidate}, falling back.`,
          error,
        );
        try {
          port = await startWithNativeNet(candidate);
          break;
        } catch (fallbackError) {
          console.error(
            `[e2rn] the local asset server could not be started on port ${candidate}`,
            fallbackError,
          );
          port = 0;
        }
      }
    }
    if (!port) {
      console.error('[e2rn] the local asset server did not get a port');
      return '';
    }
    baseUrl = `http://${HOST}:${port}`;
    if (port !== PREFERRED_PORT) {
      console.warn(
        `[e2rn] port ${PREFERRED_PORT} is busy - the WebView origin changes, ` +
          'so the saved localStorage state will not be available.',
      );
    }
    console.log(`[e2rn] web assets are served from ${baseUrl}`);
    return baseUrl;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** The base URL of the running asset server ('' when it is not running). */
export function getAssetServerBaseUrl(): string {
  return baseUrl;
}

/** Builds the URL of a bundled asset. */
export function getAssetUrl(assetPath: string): string {
  if (!baseUrl) {
    return '';
  }
  const relative = String(assetPath ?? '').replace(/^\/+/, '');
  return `${baseUrl}/${relative}`;
}

/** Stops the asset server. */
export function stopAssetServer(): void {
  try {
    server?.close?.();
  } catch {
    // Ignore.
  }
  server = null;
  baseUrl = '';
}

export default {
  startAssetServer,
  getAssetServerBaseUrl,
  getAssetUrl,
  resolveAssetPath,
  buildAssetResponse,
  rewriteViewportMeta,
  stopAssetServer,
};
