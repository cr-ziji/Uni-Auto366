import {Buffer} from 'buffer';
import {EventEmitter} from 'events';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {gzipSync} = require('../src/polyfills/node/zlib');

/**
 * The renderer is served from `http://127.0.0.1:<port>`, so the rule-set API
 * (`https://366.cyril.qzz.io/...`) is a cross-origin request and the WebView
 * refuses it unless the server sends CORS headers. `window.fetch` is patched
 * to relay those calls through `/__e2rn/proxy`, which issues the request from
 * the main context.
 *
 * These tests pin the contract of that endpoint: the request is forwarded
 * with its business headers and body, and the answer is relayed with the
 * original status and bytes (but without `content-encoding`, because the body
 * is already decoded).
 */
const mockUpstreamRequest = jest.fn();

jest.mock('../src/polyfills/node/http', () => ({
  ...jest.requireActual('../src/polyfills/node/http'),
  request: (options: any, callback: any) => mockUpstreamRequest(options, callback),
}));

jest.mock('../src/polyfills/node/https', () => ({
  ...jest.requireActual('../src/polyfills/node/https'),
  request: (options: any, callback: any) => mockUpstreamRequest(options, callback),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {handleProxy, relayHeaders} = require('../src/runtime/web/assetServer');

function fakeClientRequest() {
  const request = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: '127.0.0.1:17866',
      'accept-encoding': 'gzip, deflate',
      origin: 'http://127.0.0.1:17866',
      'x-custom': 'kept',
    },
    readableEnded: true,
  }) as any;
  return request;
}

function fakeClientResponse() {
  const chunks: any[] = [];
  return {
    chunks,
    writeHead: jest.fn(),
    end: jest.fn((body: any) => chunks.push(body)),
  } as any;
}

function fakeUpstream(status: number, headers: Record<string, string>, body: string | Buffer) {
  return (options: any, callback: any) => {
    const request = new EventEmitter() as any;
    request.write = jest.fn();
    request.destroy = jest.fn();
    request.end = () => {
      const response = new EventEmitter() as any;
      response.statusCode = status;
      response.headers = headers;
      callback(response);
      response.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
      response.emit('end');
    };
    return request;
  };
}

describe('the same-origin request relay', () => {
  beforeEach(() => {
    mockUpstreamRequest.mockReset();
  });

  it('forwards business headers, drops connection headers and relays the body', async () => {
    const json = '{"success":true}';
    mockUpstreamRequest.mockImplementation(
      fakeUpstream(
        200,
        {'content-type': 'application/json', 'content-encoding': 'gzip', connection: 'keep-alive'},
        // A CDN may compress even though the relay asks for `identity`; the
        // page must still receive plain JSON.
        gzipSync(json),
      ),
    );

    const response = fakeClientResponse();
    await handleProxy(
      fakeClientRequest(),
      response,
      `url=${encodeURIComponent('https://366.cyril.qzz.io/api/rulesets?page=1')}`,
    );

    const options = mockUpstreamRequest.mock.calls[0][0];
    expect(options.hostname).toBe('366.cyril.qzz.io');
    expect(options.path).toBe('/api/rulesets?page=1');
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toBe('application/json');
    expect(options.headers['x-custom']).toBe('kept');
    // These would either break the request or produce a body the page cannot read.
    expect(options.headers.host).toBeUndefined();
    expect(options.headers['accept-encoding']).toBe('identity');
    expect(options.headers.origin).toBeUndefined();

    expect(response.writeHead).toHaveBeenCalled();
    const [status, headers] = response.writeHead.mock.calls[0];
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['content-length']).toBe(String(Buffer.byteLength(json)));
    expect(Buffer.concat(response.chunks).toString('utf8')).toBe(json);
  });

  it('keeps the encoding header when the body cannot be decoded', async () => {
    mockUpstreamRequest.mockImplementation(
      fakeUpstream(
        200,
        {'content-type': 'application/json', 'content-encoding': 'br'},
        '{"success":true}',
      ),
    );
    const response = fakeClientResponse();
    await handleProxy(
      fakeClientRequest(),
      response,
      `url=${encodeURIComponent('https://366.cyril.qzz.io/api/rulesets')}`,
    );
    // Brotli has no polyfill here: the bytes are passed through untouched, so
    // the header has to survive or the WebView would read them as plain JSON.
    expect(response.writeHead.mock.calls[0][1]['content-encoding']).toBe('br');
  });

  it('relays an error status instead of turning it into a success', async () => {
    mockUpstreamRequest.mockImplementation(
      fakeUpstream(404, {'content-type': 'text/plain'}, 'not found'),
    );
    const response = fakeClientResponse();
    await handleProxy(
      fakeClientRequest(),
      response,
      `url=${encodeURIComponent('https://366.cyril.qzz.io/api/rulesets/404')}`,
    );
    expect(response.writeHead.mock.calls[0][0]).toBe(404);
    expect(Buffer.concat(response.chunks).toString('utf8')).toBe('not found');
  });

  it('rejects a target that is not http(s)', async () => {
    const response = fakeClientResponse();
    await handleProxy(fakeClientRequest(), response, `url=${encodeURIComponent('file:///etc/passwd')}`);
    expect(mockUpstreamRequest).not.toHaveBeenCalled();
    expect(response.writeHead.mock.calls[0][0]).toBe(400);
  });

  it('keeps only the headers that are safe to relay', () => {
    const headers = relayHeaders(
      {
        'content-type': 'application/zip',
        'content-encoding': 'gzip',
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        'content-length': '999',
        'accept-ranges': 'bytes',
      },
      12,
    );
    expect(headers['content-type']).toBe('application/zip');
    expect(headers['accept-ranges']).toBe('bytes');
    expect(headers['content-length']).toBe('12');
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers.connection).toBeUndefined();
  });
});
