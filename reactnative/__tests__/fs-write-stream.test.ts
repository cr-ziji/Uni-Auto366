import * as fsPoly from '../src/polyfills/node/fs';

/**
 * `createWriteStream` is what every download and every `archiver` package goes
 * through. It used to keep only the last chunk for the default flags (`w`)
 * because each write replaced the mirror instead of appending, so a multi-chunk
 * ZIP ended up unusable ("premature close" / invalid archive on the device).
 */
describe('fs.createWriteStream', () => {
  const dir = '/tmp/Auto366/documents/write-stream';

  beforeAll(async () => {
    await fsPoly.promises.mkdir(dir, {recursive: true});
  });

  const write = (target: string, chunks: string[], options?: any): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const stream = (fsPoly as any).createWriteStream(target, options);
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      stream.on('error', reject);
      stream.on('finish', done);
      stream.on('close', done);
      for (const chunk of chunks) {
        stream.write(Buffer.from(chunk));
      }
      stream.end();
    });

  it('keeps every chunk written with the default flags', async () => {
    const target = `${dir}/chunks.bin`;
    await write(target, ['AAA', 'BBB', 'CCC']);
    const content = await fsPoly.promises.readFile(target, 'utf8');
    const stat = await fsPoly.promises.stat(target);
    expect(content).toBe('AAABBBCCC');
    expect(stat.size).toBe(9);
  });

  it('overwrites the previous content when the stream is opened with "w"', async () => {
    const target = `${dir}/overwrite.bin`;
    await write(target, ['old-content']);
    await write(target, ['new', '-content']);
    expect(await fsPoly.promises.readFile(target, 'utf8')).toBe('new-content');
  });

  it('appends when opened with "a"', async () => {
    const target = `${dir}/append.bin`;
    await write(target, ['head-']);
    await write(target, ['tail'], {flags: 'a'});
    expect(await fsPoly.promises.readFile(target, 'utf8')).toBe('head-tail');
  });

  it('keeps the bytes written so far when the stream is destroyed', async () => {
    const target = `${dir}/damaged.zip`;
    const stream = (fsPoly as any).createWriteStream(target);
    const closed = new Promise<void>(resolve => stream.on('close', resolve));
    // 下载被截断时 pipeline 会带着错误销毁写流，这个错误本身由调用方处理。
    stream.on('error', () => {});
    stream.write(Buffer.from('PK\u0003\u0004partial'));
    stream.destroy(new Error('socket closed'));
    await closed;
    expect(await fsPoly.promises.readFile(target, 'utf8')).toBe('PK\u0003\u0004partial');
  });

  it('keeps persist:false files in the memory mirror only', async () => {
    const target = `${dir}/mirror-only.bin`;
    await write(target, ['abc', 'def'], {persist: false});
    expect(await fsPoly.promises.readFile(target, 'utf8')).toBe('abcdef');
    expect(await fsPoly.exists(target)).toBe(true);
  });
});
