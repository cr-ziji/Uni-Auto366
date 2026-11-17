import {zipSync, unzipSync, strToU8, strFromU8} from 'fflate';
import crypto from 'crypto';
import fs from 'fs';
import fse from 'fs-extra';
import os from 'os';
import path from 'path';

const injectionZip = require('../../modules/injection/zip');

const html = '<html><body><h1>pk</h1></body></html>';
const binary = new Uint8Array(4096).map((_, index) => (index * 37) % 256);

const buildZip = (): Buffer =>
  Buffer.from(
    zipSync(
      {
        'course/index.html': strToU8(html),
        'course/chapter/lesson.html': strToU8(html),
        'course/app.js': strToU8('console.log("course");'),
        'media/clip.bin': binary,
      },
      {level: 6},
    ),
  );

describe('injection zip rewrite', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-zip-'));
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('injects the script without touching the other entries', async () => {
    const source = path.join(dir, 'original.zip');
    const target = path.join(dir, 'injected.zip');
    fs.writeFileSync(source, buildZip());

    const scripts = [{name: 'auto-pk.js', content: 'window.__pk = true;'}];
    const result = await injectionZip.injectZipFile(source, target, scripts);

    const bytes = fs.readFileSync(target);
    const entries = unzipSync(new Uint8Array(bytes));

    // HTML 被插入脚本引用，脚本文件出现在同一目录
    const injectedHtml = strFromU8(entries['course/index.html']);
    expect(injectedHtml).toContain('auto-pk.js');
    expect(strFromU8(entries['course/auto-pk.js'])).toBe('window.__pk = true;');
    expect(strFromU8(entries['course/chapter/lesson.html'])).toContain('auto-pk.js');
    expect(strFromU8(entries['course/chapter/auto-pk.js'])).toBe('window.__pk = true;');

    // 其余条目逐字节不变
    expect(strFromU8(entries['course/app.js'])).toBe('console.log("course");');
    expect(Buffer.from(entries['media/clip.bin'])).toEqual(Buffer.from(binary));

    // 校验值与文件内容一致，响应里的 filemd5/filesize 才不会对不上
    expect(result.htmlCount).toBe(2);
    expect(result.size).toBe(bytes.length);
    expect(result.md5).toBe(crypto.createHash('md5').update(bytes).digest('hex'));
  });

  it('places the listening script at the start of body', async () => {
    const source = path.join(dir, 'original.zip');
    const target = path.join(dir, 'injected.zip');
    fs.writeFileSync(source, buildZip());

    await injectionZip.injectZipFile(source, target, [
      {name: 'auto-listening.js', content: 'window.__mic = true;'},
    ]);

    const entries = unzipSync(new Uint8Array(fs.readFileSync(target)));
    const injectedHtml = strFromU8(entries['course/index.html']);
    expect(injectedHtml).toContain('<body><script src="./auto-listening.js"></script>');
  });

  it('leaves the archive untouched when it has no html', async () => {
    const source = path.join(dir, 'original.zip');
    const target = path.join(dir, 'injected.zip');
    fs.writeFileSync(
      source,
      Buffer.from(zipSync({'app.js': strToU8('console.log(1);')})),
    );

    const result = await injectionZip.injectZipFile(source, target, [
      {name: 'auto-pk.js', content: 'x'},
    ]);
    expect(result.htmlCount).toBe(0);
    expect(unzipSync(new Uint8Array(fs.readFileSync(target)))['app.js']).toBeDefined();
  });

  it('reports unsupported archives instead of writing a broken file', () => {
    const junk = Buffer.alloc(256, 0x41);
    expect(() => injectionZip.rewriteZip(junk)).toThrow(/找不到 ZIP 目录尾/);
    try {
      injectionZip.rewriteZip(junk);
    } catch (error) {
      expect((error as any).code).toBe('E_ZIP_UNSUPPORTED');
    }
  });
});
