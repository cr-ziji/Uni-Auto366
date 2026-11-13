/**
 * Regression test for large writes across the native bridge.
 *
 * A ZIP injection can be 100+ MB. Sending it as a single base64 string made the
 * Android bridge (and its Java heap) allocate one huge string, which failed
 * mid-write and left the client with a truncated ZIP that it downloaded again
 * and again. Writes must be split into small slices.
 */
jest.unmock('../src/runtime/native/net');

import {NativeModules} from 'react-native';

import {NativeSocket} from '../src/runtime/native/net';

const write = jest.fn();

beforeEach(() => {
  write.mockReset();
  (NativeModules as any).Auto366Net = {write};
});

afterEach(() => {
  delete (NativeModules as any).Auto366Net;
});

describe('NativeSocket.write', () => {
  it('splits a large body into bridge-sized slices', () => {
    const socket = new NativeSocket('socket-1', false);
    const body = Buffer.alloc(200 * 1024, 7);

    expect(socket.write(body)).toBe(true);

    expect(write).toHaveBeenCalledTimes(4);
    let total = 0;
    for (const [id, base64] of write.mock.calls) {
      expect(id).toBe('socket-1');
      const size = Buffer.from(base64, 'base64').length;
      expect(size).toBeLessThanOrEqual(64 * 1024);
      total += size;
    }
    expect(total).toBe(body.length);
  });

  it('sends small writes in one call', () => {
    const socket = new NativeSocket('socket-2', false);

    expect(socket.write(Buffer.from('hello'))).toBe(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(Buffer.from(write.mock.calls[0][1], 'base64').toString()).toBe('hello');
  });

  it('encodes slices even when subarray() returns a plain Uint8Array', () => {
    // RN 的 Buffer 实现里 `Buffer.prototype.subarray()` 返回普通
    // `Uint8Array`，它的 `toString()` 会忽略编码参数，变成 "72,84,..."。
    // 原生层再按 base64 解码就得到完全错误的字节（ZIP 会直接损坏）。
    const original = Buffer.prototype.subarray;
    (Buffer.prototype as any).subarray = function subarray(
      this: Buffer,
      start?: number,
      end?: number,
    ) {
      return new Uint8Array(
        original.call(this, start, end) as unknown as ArrayLike<number>,
      );
    };
    try {
      const socket = new NativeSocket('socket-5', false);
      const payload = Buffer.from('HTTP/1.1 200 OK\r\n\r\nZIP');
      expect(socket.write(payload)).toBe(true);

      const total = write.mock.calls.reduce((sum: number, [, base64]: [string, string]) => {
        return sum + Buffer.from(base64, 'base64').length;
      }, 0);
      expect(total).toBe(payload.length);

      const decoded = Buffer.concat(
        write.mock.calls.map(([, base64]: [string, string]) =>
          Buffer.from(base64, 'base64'),
        ),
      );
      expect(decoded.toString()).toBe(payload.toString());
    } finally {
      (Buffer.prototype as any).subarray = original;
    }
  });

  it('keeps only a few async writes in flight and shuts down after draining', async () => {
    const writeAsync = jest.fn(() => Promise.resolve());
    const shutdown = jest.fn();
    (NativeModules as any).Auto366Net = {write, writeAsync, shutdown};
    const socket = new NativeSocket('socket-4', false);

    expect(socket.write(Buffer.alloc(1024 * 1024))).toBe(true);
    // 64 KiB per slice => 16 slices, but only a bounded window is handed over.
    expect(writeAsync.mock.calls.length).toBeLessThanOrEqual(4);

    socket.end();
    expect(shutdown).not.toHaveBeenCalled();

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(writeAsync).toHaveBeenCalledTimes(16);
    expect(shutdown).toHaveBeenCalledTimes(1);
    const calls = writeAsync.mock.calls as unknown as Array<[string, string]>;
    const total = calls.reduce(
      (sum, [, base64]) => sum + Buffer.from(base64, 'base64').length,
      0,
    );
    expect(total).toBe(1024 * 1024);
  });

  it('reports failure instead of pretending the write succeeded', () => {
    const socket = new NativeSocket('socket-3', false);
    socket.on('error', () => {});
    write.mockImplementation(() => {
      throw new Error('bridge closed');
    });

    expect(socket.write(Buffer.alloc(128 * 1024))).toBe(false);
  });
});
