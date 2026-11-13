/**
 * Tests of the `fs` polyfill.
 *
 * The polyfill keeps a process wide memory mirror so that the SYNCHRONOUS
 * calls of the original desktop code work on React Native.
 */
import {
  close,
  closeSync,
  existsSync,
  mkdirSync,
  open,
  openSync,
  read,
  readFileSync,
  readdirSync,
  write,
  writeFileSync,
  hydrateFileSystem,
} from '../src/polyfills/node/fs';

describe('the fs polyfill', () => {
  beforeAll(async () => {
    await hydrateFileSystem();
  });

  it('returns a file that was written synchronously', () => {
    const target = '/tmp/Auto366/documents/.Auto366/config/hello.txt';
    writeFileSync(target, 'hello mobile');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello mobile');
  });

  it('reports a missing file with ENOENT', () => {
    const target = '/tmp/Auto366/documents/.Auto366/does-not-exist.txt';
    expect(existsSync(target)).toBe(false);
    expect(() => readFileSync(target, 'utf8')).toThrow();
    try {
      readFileSync(target, 'utf8');
    } catch (error) {
      expect(error.code).toBe('ENOENT');
    }
  });

  it('creates the parent directories of a file', () => {
    const directory = '/tmp/Auto366/documents/.Auto366/logs';
    mkdirSync(directory, {recursive: true});
    writeFileSync(`${directory}/a.log`, 'line');
    expect(readdirSync(directory)).toContain('a.log');
  });

  it('serves the bundled assets from the virtual application root', () => {
    const html = readFileSync('/app/index.html', 'utf8');
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('serves a bundled rule set through the data root', () => {
    // `<dataRoot>/rulesets/...` falls back to the bundled rule sets.
    const rulesets = readdirSync('/tmp/Auto366/documents/.Auto366/rulesets');
    expect(Array.isArray(rulesets)).toBe(true);
  });

  it('writes Uint8Array slices through FileHandle.write', async () => {
    // RN 的 Buffer.subarray() 返回普通 Uint8Array；大响应落盘时不能对
    // subarray 直接调用 Buffer 专用的 `.copy()`。
    const target = '/tmp/Auto366/documents/.Auto366/handle-slice.bin';
    const handle = await open(target, 'wx');
    const source = new Uint8Array([10, 20, 30, 40, 50, 60]);
    await handle.write(source as unknown as Buffer, 1, 3);
    await handle.close();
    expect(Array.from(readFileSync(target) as Buffer)).toEqual([20, 30, 40]);
  });

  it('supports the asynchronous fs.read/fs.write/fs.close helpers', async () => {
    // `fs-extra` 的调用方会直接 await `fs.read(handle, ...)` / `fs.close(handle)`，
    // 这里同时覆盖 FileHandle 与 openSync() 返回的数字描述符。
    const target = '/tmp/Auto366/documents/.Auto366/async-handle.bin';
    const handle = await open(target, 'wx');
    const payload = new Uint8Array([1, 2, 3, 4]);
    const written = await write(handle, payload, 0, payload.length, 0);
    expect(written.bytesWritten).toBe(4);
    await close(handle);

    const reader = await open(target, 'r');
    const header = Buffer.alloc(4);
    const result = await read(reader, header, 0, 4, 0);
    await close(reader);
    expect(result.bytesRead).toBe(4);
    expect(Array.from(header)).toEqual([1, 2, 3, 4]);

    const fd = openSync(target, 'r');
    const slice = Buffer.alloc(2);
    expect(await read(fd, slice, 0, 2, 1)).toEqual({bytesRead: 2, buffer: slice});
    expect(Array.from(slice)).toEqual([2, 3]);
    closeSync(fd);
  });
});
