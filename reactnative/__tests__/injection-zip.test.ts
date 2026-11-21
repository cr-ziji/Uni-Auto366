/**
 * `modules/injection/zip.js` 的原地改写测试。
 *
 * 夹具用 `test-utils/zip-fixture` 现打（deflate），校验用真实的 `node-stream-zip`，
 * 保证"手机改出来的包桌面工具能读"。
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {writeZipFile} from '../test-utils/zip-fixture';

const injectionZip = require('../../modules/injection/zip');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RealStreamZip = require('node-stream-zip');

const html = '<html><body><h1>pk</h1></body></html>';
const binary = new Uint8Array(4096).map((_, index) => (index * 37) % 256);

const FILES: Record<string, Buffer | string> = {
  'course/index.html': html,
  'course/chapter/lesson.html': html,
  'course/app.js': 'console.log("course");',
  'media/clip.bin': Buffer.from(binary),
};

/** 用桌面版 node-stream-zip 读回全部条目。 */
async function readZip(target: string): Promise<Record<string, Buffer>> {
  const zip = new RealStreamZip.async({file: target});
  const entries = await zip.entries();
  const result: Record<string, Buffer> = {};
  for (const name of Object.keys(entries)) {
    if (entries[name].isDirectory) {
      continue;
    }
    result[name] = await zip.entryData(name);
  }
  await zip.close();
  return result;
}

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
    writeZipFile(source, FILES);

    const scripts = [{name: 'auto-pk.js', content: 'window.__pk = true;'}];
    const result = await injectionZip.injectZipFile(source, target, scripts);

    const bytes = fs.readFileSync(target);
    const entries = await readZip(target);

    // HTML 被插入脚本引用，脚本文件出现在同一目录
    expect(entries['course/index.html'].toString('utf8')).toContain('auto-pk.js');
    expect(entries['course/auto-pk.js'].toString('utf8')).toBe('window.__pk = true;');
    expect(entries['course/chapter/lesson.html'].toString('utf8')).toContain('auto-pk.js');
    expect(entries['course/chapter/auto-pk.js'].toString('utf8')).toBe('window.__pk = true;');

    // 其余条目逐字节不变
    expect(entries['course/app.js'].toString('utf8')).toBe('console.log("course");');
    expect(entries['media/clip.bin']).toEqual(Buffer.from(binary));

    // 校验值与文件内容一致，响应里的 filemd5/filesize 才不会对不上
    expect(result.htmlCount).toBe(2);
    expect(result.size).toBe(bytes.length);
    expect(result.md5).toBe(crypto.createHash('md5').update(bytes).digest('hex'));
  });

  it('places the listening script at the start of body', async () => {
    const source = path.join(dir, 'original.zip');
    const target = path.join(dir, 'injected.zip');
    writeZipFile(source, FILES);

    await injectionZip.injectZipFile(source, target, [
      {name: 'auto-listening.js', content: 'window.__mic = true;'},
    ]);

    const entries = await readZip(target);
    expect(entries['course/index.html'].toString('utf8')).toContain(
      '<body><script src="./auto-listening.js"></script>',
    );
  });

  it('leaves the archive untouched when it has no html', async () => {
    const source = path.join(dir, 'plain.zip');
    const target = path.join(dir, 'plain-out.zip');
    writeZipFile(source, {"app.js": "console.log(1);"});

    const result = await injectionZip.injectZipFile(source, target, [
      {name: 'auto-pk.js', content: 'x'},
    ]);

    expect(result.htmlCount).toBe(0);
    const entries = await readZip(target);
    expect(entries['app.js'].toString('utf8')).toBe('console.log(1);');
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
