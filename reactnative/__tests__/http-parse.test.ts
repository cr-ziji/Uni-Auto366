/**
 * Tests of the HTTP/1.1 parsing helpers.
 */
import {
  ChunkedDecoder,
  buildRequestHead,
  hasCompleteHead,
  parseRequestHead,
  parseResponseHead,
  resolveRequestFraming,
} from '../src/runtime/http/parse';

describe('the HTTP parser', () => {
  it('parses a request head', () => {
    const raw = Buffer.from(
      'GET /api/answer?x=1 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nAccept: */*\r\n\r\n',
      'utf8',
    );
    const {head, rest} = parseRequestHead(raw);
    expect(head).not.toBeNull();
    expect(head?.method).toBe('GET');
    expect(head?.url).toBe('/api/answer?x=1');
    expect(head?.httpVersion).toBe('HTTP/1.1');
    expect(head?.headers.host).toBe('127.0.0.1:8080');
    expect(rest.length).toBe(0);
  });

  it('keeps the body that follows the head', () => {
    const raw = Buffer.from(
      'POST /x HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello',
      'utf8',
    );
    const {head, rest} = parseRequestHead(raw);
    expect(head?.method).toBe('POST');
    expect(rest.toString('utf8')).toBe('hello');
  });

  it('detects an incomplete head', () => {
    expect(hasCompleteHead(Buffer.from('GET / HTTP/1.1\r\nHost: a\r\n', 'utf8'))).toBe(false);
    expect(hasCompleteHead(Buffer.from('GET / HTTP/1.1\r\nHost: a\r\n\r\n', 'utf8'))).toBe(true);
  });

  it('parses a response head', () => {
    const raw = Buffer.from(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
      'utf8',
    );
    const {head, rest} = parseResponseHead(raw);
    expect(head?.statusCode).toBe(200);
    expect(head?.headers['content-type']).toBe('application/json');
    expect(rest.toString('utf8')).toBe('{}');
  });

  it('derives the framing of a request', () => {
    expect(resolveRequestFraming({})).toBe('none');
    expect(resolveRequestFraming({'content-length': '10'})).toBe('length');
    expect(resolveRequestFraming({'transfer-encoding': 'chunked'})).toBe('chunked');
  });

  it('decodes a chunked body that is split over several packets', () => {
    const decoder = new ChunkedDecoder();
    const first = decoder.push(Buffer.from('5\r\nhello\r\n', 'utf8'));
    expect(first.complete).toBe(false);
    expect(Buffer.concat(first.chunks).toString('utf8')).toBe('hello');
    const second = decoder.push(Buffer.from('6\r\n world\r\n0\r\n\r\n', 'utf8'));
    expect(second.complete).toBe(true);
    expect(Buffer.concat(second.chunks).toString('utf8')).toBe(' world');
  });

  it('builds a request head', () => {
    const head = buildRequestHead('GET', '/index.html', {Host: '127.0.0.1:1234', Accept: '*/*'});
    expect(head).toContain('GET /index.html HTTP/1.1');
    expect(head).toContain('Host: 127.0.0.1:1234');
    expect(head.endsWith('\r\n\r\n')).toBe(true);
  });
});
