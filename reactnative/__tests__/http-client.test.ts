/**
 * Regression tests of the HTTP client.
 *
 * The client is what talks to the upstream server on behalf of the proxy, and
 * two of its behaviours are easy to break without noticing:
 *
 *  - `finishRequest()` must NOT call `socket.end()`. In
 *    `react-native-tcp-socket` `end()` is mapped to the native `destroy()`,
 *    i.e. it closes the whole connection instead of half-closing it. The
 *    request was therefore cut off before the response could be read - both
 *    for plain HTTP and for the HTTPS interception.
 *  - the connection is closed only after the response body was consumed.
 */
import TcpSocket from 'react-native-tcp-socket';

import {HttpClientRequest, httpRequest} from '../src/runtime/http/client';

type Listener = (...args: any[]) => void;

class FakeSocket {
  readonly writes: string[] = [];
  ended = false;
  destroyed = false;
  private readonly listeners = new Map<string, Listener[]>();

  write(data: any): boolean {
    this.writes.push(String(data));
    return true;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  setTimeout(): void {}

  on(event: string, listener: Listener): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

let socket: FakeSocket;
let onConnect: (() => void) | undefined;

beforeEach(() => {
  socket = new FakeSocket();
  onConnect = undefined;

  const connect = TcpSocket.connect as unknown as jest.Mock;
  connect.mockReset();
  connect.mockImplementation((_options: any, callback: () => void) => {
    onConnect = callback;
    return socket;
  });

  const connectTLS = TcpSocket.connectTLS as unknown as jest.Mock;
  connectTLS.mockReset();
  connectTLS.mockImplementation((_options: any, callback: () => void) => {
    onConnect = callback;
    return socket;
  });
});

function finishConnect(): void {
  if (!onConnect) {
    throw new Error('the client did not open a socket');
  }
  onConnect();
}

describe('HttpClientRequest', () => {
  it('sends the request head without closing the connection', () => {
    const request = new HttpClientRequest({
      host: '127.0.0.1',
      port: 8080,
      path: '/api',
    });

    request.end();
    finishConnect();

    expect(socket.writes.join('')).toContain('GET /api HTTP/1.1\r\n');
    // Regression: `end()` in react-native-tcp-socket destroys the socket,
    // which made every upstream response unreachable.
    expect(socket.ended).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it('writes the request body and still keeps the connection open', () => {
    const request = new HttpClientRequest({
      host: '127.0.0.1',
      port: 8080,
      path: '/upload',
      method: 'POST',
    });

    request.end('hello');
    finishConnect();

    const raw = socket.writes.join('');
    expect(raw).toContain('POST /upload HTTP/1.1\r\n');
    expect(raw).toContain('hello');
    expect(socket.ended).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it('reads the response and only then closes the connection', () => {
    const request = new HttpClientRequest({
      host: '127.0.0.1',
      port: 8080,
      path: '/',
    });
    const events: string[] = [];
    let body = '';
    request.on('response', head => events.push(`response:${head.statusCode}`));
    request.on('data', chunk => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => events.push('end'));
    request.on('close', () => events.push('close'));

    request.end();
    finishConnect();
    socket.emit(
      'data',
      Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'),
    );

    expect(events).toEqual(['response:200', 'end']);
    expect(body).toBe('hello');
    expect(socket.destroyed).toBe(true);

    // The socket reports its close afterwards; it must not be treated as an
    // aborted response.
    socket.emit('close');
    expect(events).toEqual(['response:200', 'end', 'close']);
  });

  it('decodes a chunked response body', () => {
    const request = new HttpClientRequest({
      host: '127.0.0.1',
      port: 8080,
      path: '/',
    });
    let body = '';
    request.on('data', chunk => {
      body += chunk.toString('utf8');
    });

    request.end();
    finishConnect();
    socket.emit(
      'data',
      Buffer.from(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
          '5\r\nhello\r\n0\r\n\r\n',
      ),
    );

    expect(body).toBe('hello');
    expect(socket.destroyed).toBe(true);
  });

  it('uses connectTLS for tls requests', () => {
    const request = new HttpClientRequest({
      host: 'fs.up366.cn',
      path: '/',
      tls: true,
    });

    request.end();
    finishConnect();

    expect(TcpSocket.connectTLS).toHaveBeenCalledTimes(1);
    expect(TcpSocket.connectTLS).toHaveBeenCalledWith(
      expect.objectContaining({servername: 'fs.up366.cn'}),
      expect.any(Function),
    );
    expect(TcpSocket.connect).not.toHaveBeenCalled();
    expect(socket.ended).toBe(false);
  });
});

describe('httpRequest', () => {
  it('resolves with the status and the response body', async () => {
    const pending = httpRequest({
      host: '127.0.0.1',
      port: 8080,
      path: '/x',
    });

    finishConnect();
    socket.emit(
      'data',
      Buffer.from('HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok'),
    );

    const response = await pending;
    expect(response.statusCode).toBe(201);
    expect(response.body.toString('utf8')).toBe('ok');
  });
});
