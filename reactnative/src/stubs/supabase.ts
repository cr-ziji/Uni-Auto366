/**
 * Minimal replacement for the desktop `@supabase/supabase-js` package.
 *
 * `modules/answers/sharing.js` uploads an answer file to a public Supabase
 * bucket and shares the public URL. Only the *storage* part of the SDK is
 * used, so instead of pulling in the whole SDK the two REST calls are
 * implemented directly on top of the `https` polyfill:
 *
 *   upload      -> POST   {url}/storage/v1/object/{bucket}/{path}
 *   download    -> GET    {url}/storage/v1/object/{bucket}/{path}
 *   public url  -> {url}/storage/v1/object/public/{bucket}/{path}
 *
 * The anonymous key is sent as `apikey` and `Authorization: Bearer` header,
 * exactly like the official SDK does.
 */
import {Buffer} from 'buffer';

import https from '../polyfills/node/https';

export interface SupabaseError {
  message: string;
  status?: number;
  [key: string]: any;
}

export interface StorageUploadResult {
  data: any;
  error: SupabaseError | null;
}

export interface StorageBucket {
  upload(
    path: string,
    data: Buffer | Uint8Array | string,
    options?: {upsert?: boolean; contentType?: string},
  ): Promise<StorageUploadResult>;
  download(path: string): Promise<StorageUploadResult>;
  list(path?: string): Promise<StorageUploadResult>;
  remove(paths: string[]): Promise<StorageUploadResult>;
  getPublicUrl(path: string): {data: {publicUrl: string}; error: SupabaseError | null};
}

export interface SupabaseClient {
  storage: {from(bucket: string): StorageBucket};
  auth: any;
  [key: string]: any;
}

interface RawResponse {
  statusCode: number;
  body: Buffer;
}

/** Performs a single HTTPS request and buffers the whole response. */
function request(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks)});
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout?.(30000, () => {
      req.destroy?.(new Error('[E2RN] the Supabase request timed out'));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function toError(response: RawResponse): SupabaseError | null {
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return null;
  }
  let message = response.body?.toString('utf8') ?? '';
  try {
    const parsed = JSON.parse(message);
    message = parsed?.message || parsed?.error || message;
  } catch {
    // Keep the raw body.
  }
  return {message: message || `HTTP ${response.statusCode}`, status: response.statusCode};
}

function parseJson(response: RawResponse): any {
  const text = response.body?.toString('utf8') ?? '';
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createClient(url: string, anonKey: string): SupabaseClient {
  const base = String(url ?? '').replace(/\/+$/, '');
  const key = String(anonKey ?? '');

  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(extra ?? {}),
  });

  const bucket = (name: string): StorageBucket => {
    const objectUrl = (path: string): string =>
      `${base}/storage/v1/object/${encodeURIComponent(name)}/${path
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/')}`;

    return {
      async upload(path, data, options) {
        try {
          const payload = Buffer.isBuffer(data)
            ? data
            : typeof data === 'string'
            ? Buffer.from(data, 'utf8')
            : Buffer.from(data);
          const response = await request(
            objectUrl(path),
            'POST',
            headers({
              'Content-Type': options?.contentType ?? 'application/octet-stream',
              'x-upsert': options?.upsert ? 'true' : 'false',
            }),
            payload,
          );
          const error = toError(response);
          return {data: error ? null : parseJson(response), error};
        } catch (error: any) {
          return {data: null, error: {message: error?.message ?? String(error)}};
        }
      },

      async download(path) {
        try {
          const response = await request(objectUrl(path), 'GET', headers());
          const error = toError(response);
          return {data: error ? null : response.body, error};
        } catch (error: any) {
          return {data: null, error: {message: error?.message ?? String(error)}};
        }
      },

      async list(path = '') {
        try {
          const response = await request(
            `${base}/storage/v1/object/list/${encodeURIComponent(name)}`,
            'POST',
            headers({'Content-Type': 'application/json'}),
            Buffer.from(JSON.stringify({prefix: path}), 'utf8'),
          );
          const error = toError(response);
          return {data: error ? null : parseJson(response), error};
        } catch (error: any) {
          return {data: null, error: {message: error?.message ?? String(error)}};
        }
      },

      async remove(paths: string[]) {
        try {
          const response = await request(
            `${base}/storage/v1/object/${encodeURIComponent(name)}`,
            'DELETE',
            headers({'Content-Type': 'application/json'}),
            Buffer.from(JSON.stringify({prefixes: paths}), 'utf8'),
          );
          const error = toError(response);
          return {data: error ? null : parseJson(response), error};
        } catch (error: any) {
          return {data: null, error: {message: error?.message ?? String(error)}};
        }
      },

      getPublicUrl(path: string) {
        return {
          data: {
            publicUrl: `${base}/storage/v1/object/public/${encodeURIComponent(name)}/${path
              .split('/')
              .map(segment => encodeURIComponent(segment))
              .join('/')}`,
          },
          error: null,
        };
      },
    };
  };

  return {
    storage: {from: bucket},
    auth: {
      getSession: async () => ({data: {session: null}, error: null}),
      getUser: async () => ({data: {user: null}, error: null}),
      signInWithPassword: async () => ({data: null, error: {message: 'not supported'}}),
      signOut: async () => ({error: null}),
    },
  };
}

export default {createClient};
