/**
 * Regression test for the proxy's client-disconnect notification.
 *
 * A keep-alive socket is reused by many requests. The proxy must attach a
 * single `close` listener per socket instead of one per request, otherwise
 * long-lived connections trip `MaxListenersExceededWarning`.
 */
import {Buffer} from 'buffer';
import {EventEmitter} from 'events';
import {Proxy} from '../src/stubs/http-mitm-proxy';

describe('the proxy socket listeners', () => {
  it('keeps one close listener per keep-alive socket', () => {
    const proxy = new Proxy({});
    const socket = new EventEmitter();
    const rawResponse = {
      writeHead: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      destroy: jest.fn(),
      writeRaw: jest.fn(),
    };
    const requests: any[] = [];

    // `pipeRequest` would open a real upstream connection; the listener
    // bookkeeping under test happens before that.
    (proxy as any).pipeRequest = (_ctx: any, request: any) => {
      requests.push(request);
      return Promise.resolve();
    };

    for (let index = 0; index < 30; index++) {
      (proxy as any).handleHttp(
        {
          method: 'GET',
          url: `http://example.com/${index}`,
          httpVersion: '1.1',
          headers: {host: 'example.com'},
          body: Buffer.alloc(0),
          socket,
        },
        rawResponse,
        false,
      );
    }

    expect(requests).toHaveLength(30);
    expect(socket.listenerCount('close')).toBe(1);

    const aborted: number[] = [];
    requests.forEach((request, index) => {
      request.once('aborted', () => aborted.push(index));
    });

    socket.emit('close');

    expect(aborted).toEqual(requests.map((_request, index) => index));
    expect(socket.listenerCount('close')).toBe(0);
  });
});
