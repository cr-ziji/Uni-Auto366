// 移动端没有原生 zlib：`modules/injection/zip.js` 会落到 fflate 的版本。
// 这里把 `zlib` 换成 RN 的 polyfill，确认"用 polyfill 压出来的条目"能被标准
// ZIP 解析器（fflate）读回——否则手机上打出来的包是坏的，而桌面测试看不出来。
jest.mock('zlib', () => require('../src/polyfills/node/zlib'));

import {zipSync, unzipSync, strToU8, strFromU8} from 'fflate';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const injectionZip = require('../../modules/injection/zip');

describe('injection zip rewrite (fflate zlib, mobile path)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-zip-fflate-'));
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('produces an archive that standard tools can read', async () => {
    const source = path.join(dir, 'original.zip');
    const target = path.join(dir, 'injected.zip');
    const lesson = '<html><body><div id="app"></div></body></html>';
    fs.writeFileSync(
      source,
      Buffer.from(
        zipSync({
          'pk/index.html': strToU8(lesson),
          'pk/assets/words.json': strToU8('{"a":1}'),
          'pk/img/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
        }),
      ),
    );

    const result = await injectionZip.injectZipFile(source, target, [
      {name: 'auto-pk.js', content: 'window.__auto_pk = 1;'},
    ]);
    const bytes = fs.readFileSync(target);
    const entries = unzipSync(new Uint8Array(bytes));

    expect(result.htmlCount).toBe(1);
    expect(strFromU8(entries['pk/index.html'])).toContain('auto-pk.js');
    expect(strFromU8(entries['pk/auto-pk.js'])).toBe('window.__auto_pk = 1;');
    expect(strFromU8(entries['pk/assets/words.json'])).toBe('{"a":1}');
    expect(Array.from(entries['pk/img/logo.png'])).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(result.md5).toBe(crypto.createHash('md5').update(bytes).digest('hex'));
  });
});
