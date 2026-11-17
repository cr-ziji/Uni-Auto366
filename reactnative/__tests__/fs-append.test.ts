import * as fsPoly from '../src/polyfills/node/fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RNFS = require('react-native-fs');

/**
 * The log writer appends every ~40 ms. Appending used to read the file back,
 * concatenate and write the whole thing again, so a few megabytes of log made
 * every batch copy megabytes on the JS thread - and every IPC reply is
 * delivered from that same thread.
 */
describe('appendFile', () => {
  it('appends on the device instead of rewriting the whole file', async () => {
    const target = '/tmp/Auto366/documents/append-large.log';
    await fsPoly.promises.writeFile(target, Buffer.alloc(600 * 1024, 0x61));

    const writesBefore = RNFS.writeFile.mock.calls.length;
    const appendsBefore = RNFS.appendFile.mock.calls.length;
    for (let index = 0; index < 5; index += 1) {
      await fsPoly.promises.appendFile(target, Buffer.from('tail'));
    }

    // No full-file rewrite: only real appends reach the device.
    expect(RNFS.writeFile.mock.calls.length).toBe(writesBefore);
    expect(RNFS.appendFile.mock.calls.length).toBe(appendsBefore + 5);

    const content = String(await fsPoly.promises.readFile(target, 'utf8'));
    expect(content.length).toBe(600 * 1024 + 20);
    expect(content.endsWith('tailtailtailtailtail')).toBe(true);
  });

  it('keeps small files readable synchronously', async () => {
    const target = '/tmp/Auto366/documents/small.log';
    await fsPoly.promises.writeFile(target, Buffer.from('head', 'utf8'));
    await fsPoly.promises.appendFile(target, Buffer.from('tail', 'utf8'));
    expect(fsPoly.readFileSync(target, 'utf8')).toBe('headtail');
    expect(fsPoly.statSync(target).size).toBe(8);
  });

  it('keeps the appended bytes when the stream of a download is truncated', async () => {
    const target = '/tmp/Auto366/documents/partial.bin';
    await fsPoly.promises.appendFile(target, Buffer.from('PK\u0003\u0004abc'));
    await fsPoly.promises.appendFile(target, Buffer.from('def'));
    expect(await fsPoly.promises.readFile(target, 'utf8')).toBe('PK\u0003\u0004abcdef');
  });
});
