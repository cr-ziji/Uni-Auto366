/**
 * Tests of the `fs` polyfill.
 *
 * The polyfill keeps a process wide memory mirror so that the SYNCHRONOUS
 * calls of the original desktop code work on React Native.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
});
