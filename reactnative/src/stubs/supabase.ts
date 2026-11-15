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

/** 连接被对端重置 / 半关闭：换个新连接重试通常就能成功。 */
function isRetryable(error: any): boolean {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') {
    return true;
  }
  return /ECONNRESET|EPIPE|socket hang up|connection reset|ECONNABORTED/i.test(message);
}

/**
 * Performs a single HTTPS request and buffers the whole response.
 *
 * `Content-Length` is always sent: Supabase sits behind Kong, which answers a
 * `Transfer-Encoding: chunked` object upload by closing the connection (the
 * client then reports `connect reset`). 请求正文长度在发首部之前就已经知道，
 * 所以没有理由使用 chunked。
 */
function requestOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const finalHeaders: Record<string, string> = {...headers};
    if (body) {
      finalHeaders['Content-Length'] = String(body.length);
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      finalHeaders['Content-Length'] = '0';
    }
    // 大文件上传时 30 s 太短（一份答案 ZIP 有几 MB），给 120 s。
    const requestTimeout = 120000;
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers: finalHeaders,
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
    req.setTimeout?.(requestTimeout, () => {
      req.destroy?.(new Error('[E2RN] the Supabase request timed out'));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/** 一次请求 + 断连重试（Supabase 偶发 reset 时不会让用户看到失败）。 */
async function request(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<RawResponse> {
  let lastError: any = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestOnce(url, method, headers, body);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === 2) {
        break;
      }
      // 已经在尝试新连接了，这里只做一点退避。
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  const failure: any = lastError ?? new Error('the Supabase request failed');
  // 传输层错误（一个字节的响应都没收到）。`ECONNRESET` 出现在这里通常是网络
  // 按域名重置了 TLS 握手（例如对 `*.supabase.co` 的屏蔽），而不是服务端返回
  // 的错误。打上标记，让上层能给出一句可操作的提示，而不是裸的 "connect reset"。
  if (failure && typeof failure === 'object' && !failure.status) {
    failure.blocked = true;
  }
  throw failure;
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
              Accept: 'application/json',
              'cache-control': 'max-age=3600',
              'x-upsert': options?.upsert ? 'true' : 'false',
            }),
            payload,
          );
          const error = toError(response);
          return {data: error ? null : parseJson(response), error};
        } catch (error: any) {
          return {
            data: null,
            error: {
              message: error?.message ?? String(error),
              code: error?.code,
              blocked: error?.blocked === true,
            },
          };
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
